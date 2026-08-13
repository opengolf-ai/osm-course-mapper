"""Vectorization: masks to mappable WGS84 polygons, simplified in metres.

Every scene here is a hand-built mask on a synthetic raster, for the same reason
`test_classify.py` paints its pixels: the assertions are about geometry, and
geometry is only checkable when the test knows the ground truth exactly. Nothing
in this file runs a model, touches the network, or reads a real NAIP tile.

Three conventions run through it:

* The raster is georeferenced in **EPSG:26910**, NAD83 UTM zone 10N — the CRS
  Planetary Computer actually serves NAIP in, and deliberately *not* the WGS84
  UTM zone (32610) that `build_corridor` computes for the same line. An
  implementation that simplified or reprojected from the corridor's zone rather
  than the item's would be off by the datum shift, and the round-trip assertions
  below are tight enough to notice.
* Masks are built as boolean arrays with a known pixel outline, so "this
  staircase has 200 vertices before simplification" is a fact the test can state
  rather than a number copied from an implementation.
* Where a test claims a naive implementation would fail it, the test *shows*
  that: the touching-masks test simplifies the same two polygons independently
  and asserts the sliver appears, so the topology-aware assertion above it cannot
  quietly pass for the wrong reason.
"""

from __future__ import annotations

import datetime as dt
import json
import math

import numpy as np
import pytest
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.features import shapes as raster_shapes
from rasterio.transform import from_origin
from shapely.affinity import translate
from shapely.geometry import shape
from shapely.ops import transform as shapely_transform

from service import naip, vectorize
from service.classify import (
    ClassifiedCorridor,
    ClassifiedFeature,
    FeatureKind,
    SpectralStats,
    TeeSet,
)
from service.results import NoCoverage, Ok
from service.segment import CorridorMask, SegmentedCorridor

# NAD83 UTM zone 10N: the item CRS, not the corridor's computed WGS84 UTM zone.
ITEM_CRS = CRS.from_epsg(26910)

# Northings chosen for the latitude test and reused everywhere else. 4,000,000 m
# in zone 10N is northern California — longitude near -123 and latitude near 36,
# which differ in both sign and magnitude and so catch a lon/lat swap.
MID_NORTHING = 4_000_000.0
LOW_NORTHING = 2_700_000.0  # ~24.4 N
HIGH_NORTHING = 7_000_000.0  # ~63.1 N

HEIGHT, WIDTH = 160, 240


def _transform(northing: float = MID_NORTHING, gsd: float = 0.6):
    """An affine placing a synthetic raster in the item CRS at a given northing.

    Only the northing varies between the latitude cases, so two rasters built
    from the same mask differ by a pure translation in metres and by nothing else.
    """
    return from_origin(500_000.0, northing, gsd, gsd)


def _xy(transform, row: float, col: float) -> tuple[float, float]:
    """The projected centre of a pixel."""
    x = transform.c + transform.a * (col + 0.5) + transform.b * (row + 0.5)
    y = transform.f + transform.d * (col + 0.5) + transform.e * (row + 0.5)
    return (x, y)


def _line(transform) -> list[tuple[float, float]]:
    """A WGS84 line down the middle of the raster, for `build_corridor` to buffer.

    Nothing in this unit reads the line — it is U3's input, not U4's — but a
    `CorridorRaster` cannot be constructed without a `Corridor`, and building one
    from the raster's own transform keeps the fixture internally consistent.
    """
    to_wgs84 = Transformer.from_crs(ITEM_CRS, naip.WGS84, always_xy=True).transform
    return [
        to_wgs84(*_xy(transform, HEIGHT / 2, 10)),
        to_wgs84(*_xy(transform, HEIGHT / 2, WIDTH - 10)),
    ]


def _corridor_mask(array: np.ndarray, gsd: float) -> CorridorMask:
    """A `CorridorMask` over an arbitrary boolean array, measured the way U2 does."""
    rows, cols = np.nonzero(array)
    pixel_count = int(rows.size)
    return CorridorMask(
        mask=array,
        predicted_iou=0.92,
        stability_score=0.94,
        pixel_count=pixel_count,
        area_sq_meters=pixel_count * gsd * gsd,
        bbox_pixels=(int(rows.min()), int(rows.max()) + 1, int(cols.min()), int(cols.max()) + 1),
        centroid_rowcol=(float(rows.mean()), float(cols.mean())),
    )


def _feature(
    array: np.ndarray,
    kind: FeatureKind,
    gsd: float,
    *,
    confidence: float = 0.86,
    tee_set: TeeSet | None = None,
) -> ClassifiedFeature:
    return ClassifiedFeature(
        mask=_corridor_mask(array, gsd),
        kind=kind,
        confidence=confidence,
        model_confidence=0.93,
        area_penalty=1.0,
        kind_penalty=1.0,
        spectral=SpectralStats(ndvi=0.6, brightness=70.0, nir=200.0, sample_pixels=1_000),
        distance_along_line_meters=100.0,
        tee_set=tee_set,
    )


def _classified(
    features: tuple[ClassifiedFeature, ...],
    transform,
    gsd: float,
    *,
    unclassified: tuple[ClassifiedFeature, ...] = (),
    missing_tee_sets: tuple[TeeSet, ...] = (),
    height: int = HEIGHT,
    width: int = WIDTH,
) -> ClassifiedCorridor:
    """Wrap hand-built features as U3's output.

    `pixels` is zeros: this unit reads the mask arrays and the transform, never
    the imagery, and a real four-band scene here would only imply otherwise.
    """
    line = _line(transform)
    built = naip.build_corridor(line)
    assert isinstance(built, Ok), built
    raster = naip.CorridorRaster(
        pixels=np.zeros((4, height, width), dtype=np.uint8),
        transform=transform,
        crs=ITEM_CRS,
        acquired=dt.date(2023, 7, 4),
        gsd_meters=gsd,
        item_id="ca-2023",
        asset_href="file:///synthetic.tif",
        corridor=built.value,
    )
    segmented = SegmentedCorridor(
        raster=raster,
        masks=tuple(f.mask for f in features + unclassified),
        model_id="facebook/sam2-hiera-large",
    )
    return ClassifiedCorridor(
        corridor=segmented,
        features=features,
        unclassified=unclassified,
        missing_tee_sets=missing_tee_sets,
        line_length_meters=float(width * gsd),
    )


# --------------------------------------------------------------------------- #
# Mask shapes
# --------------------------------------------------------------------------- #


def _staircase_mask(top: int = 20, bottom: int = 140, left: int = 20) -> np.ndarray:
    """A shape whose right edge is a perfectly straight 45-degree diagonal.

    Straight, and yet `rasterio.features.shapes` cannot say so: it traces pixel
    corners, so the diagonal comes back as a staircase with two vertices per row —
    245 nodes describing a line that needs two. Every raster boundary is like
    this, which is the entire reason this unit simplifies at all.
    """
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    for row in range(top, bottom):
        array[row, left : 40 + (row - top)] = True
    return array


def _boundary_column(row: int) -> int:
    """The shared edge between the two touching masks: wiggly, and long."""
    return 120 + int(6 * math.sin(row / 5.0)) + (row % 3)


def _touching_masks() -> tuple[np.ndarray, np.ndarray]:
    """Two masks that share every vertex along one wiggly boundary.

    Exactly what U2 produces for a green and its apron, or a fairway and the
    bunker cut into its edge: SAM's masks partition the pixels, so the two
    outlines are coincident, vertex for vertex, along the seam.
    """
    left = np.zeros((HEIGHT, WIDTH), dtype=bool)
    right = np.zeros((HEIGHT, WIDTH), dtype=bool)
    for row in range(20, 140):
        column = _boundary_column(row)
        left[row, 20:column] = True
        right[row, column:220] = True
    return left, right


def _notched_mask() -> np.ndarray:
    """A rectangle with ten one-pixel-deep notches cut into its right edge.

    Every number here is chosen to make the latitude test discriminate, and each
    one matters:

    * **The notches are 1 px, 0.6 m deep.** One degree of longitude is 101 km at
      24 N and 50 km at 63 N, so a tolerance of 0.9 m expressed as a constant
      8.1e-6 degrees means 0.82 m of longitude at the low latitude and 0.41 m at
      the high one. A 0.6 m notch falls between those two: simplified in degrees
      it is erased in the south and kept in the north. Simplified in metres — 0.9
      m at both — it is erased at both, which is what the test asserts.
    * **There are ten of them, not a hundred.** Keeping them costs about forty
      nodes, which stays under the vertex cap. A hundred notches would blow
      through the cap, the tolerance would escalate, and both latitudes would be
      driven down to the same handful of nodes — hiding the very difference the
      test exists to catch.
    """
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[30:130, 40:200] = True
    for start in range(34, 130, 10):
        array[start : start + 4, 199] = False
    return array


def _sawtooth_mask() -> np.ndarray:
    """A large blob with a deep sawtooth edge — hundreds of vertices, on purpose.

    The teeth are 6 px deep, which is well outside the default one-to-two-pixel
    tolerance, so nothing but escalating the tolerance brings this under the
    vertex cap.
    """
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    for row in range(20, 140):
        array[row, 20:220] = True
    for row in range(20, 140, 4):
        array[row : row + 2, 214:220] = False
        array[row : row + 2, 20:26] = False
    return array


def _raw_polygons(array: np.ndarray, transform) -> list:
    """The unsimplified outline(s) of a mask, in the item CRS.

    Used by tests that need to compare against what the implementation started
    from — the vertex count before simplification, or the naive per-polygon
    baseline.
    """
    return [
        shape(geom)
        for geom, _ in raster_shapes(array.astype(np.uint8), mask=array, transform=transform)
    ]


def _vertices(geometry: dict) -> int:
    geom = shape(geometry)
    polygons = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    return sum(
        len(ring.coords) for polygon in polygons for ring in [polygon.exterior, *polygon.interiors]
    )


def _to_item_crs(geometry: dict):
    """A WGS84 proposal back in the item CRS, where areas and distances are metres.

    Every geometric assertion in this file goes through here rather than measuring
    on lon/lat directly, for the same reason the implementation simplifies before
    reprojecting: an area in square degrees is not an area.
    """
    to_item = Transformer.from_crs(naip.WGS84, ITEM_CRS, always_xy=True).transform
    return shapely_transform(to_item, shape(geometry))


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_a_staircase_pixel_boundary_simplifies_to_a_low_vertex_polygon(gsd) -> None:
    """R4. A proposal is only useful if a contributor can accept it into OSM.

    A raster mask has no smooth edges: every boundary is a staircase of pixel
    corners, and a 120-row mask arrives with several hundred vertices. Handing
    that to a contributor is handing them a shape they must redraw, which is the
    same as handing them nothing.
    """
    transform = _transform()
    array = _staircase_mask()
    corridor = _classified((_feature(array, FeatureKind.GREEN, gsd),), transform, gsd)

    raw = _raw_polygons(array, transform)
    assert len(raw) == 1
    raw_vertices = len(raw[0].exterior.coords)
    assert raw_vertices > 200, "the fixture must actually be a staircase"

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert proposal.kind is FeatureKind.GREEN
    assert proposal.vertex_count < 40
    assert proposal.vertex_count == _vertices(proposal.geometry)
    # And the shape is still the shape: simplification removed stair treads, not
    # the polygon. Area is compared in the item CRS, where it is in metres.
    simplified_area = _to_item_crs(proposal.geometry).area
    assert simplified_area == pytest.approx(raw[0].area, rel=0.02)


def test_two_touching_masks_simplify_without_opening_a_sliver_between_them(gsd) -> None:
    """KTD7. Shared boundaries survive only when they are simplified together.

    Two masks that partition a region share every vertex along their seam. Run
    Douglas-Peucker over each polygon on its own and the two copies of that seam
    are simplified against different rings, with different anchors, and they stop
    coinciding — the pair overlaps in places and gaps in others. That is the
    sliver KTD7 exists to prevent, and the second half of this test demonstrates
    it on the very same input, so the assertions above cannot pass by luck.
    """
    transform = _transform()
    left_array, right_array = _touching_masks()
    corridor = _classified(
        (
            _feature(left_array, FeatureKind.FAIRWAY, gsd),
            _feature(right_array, FeatureKind.GREEN, gsd),
        ),
        transform,
        gsd,
    )

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    left, right = (_to_item_crs(p.geometry) for p in result.value.proposals)
    assert left.is_valid and right.is_valid
    # Both were genuinely simplified, or this proves nothing: a pair of untouched
    # staircases trivially still shares its seam.
    raw_left = _raw_polygons(left_array, transform)[0]
    raw_right = _raw_polygons(right_array, transform)[0]
    assert _vertices(result.value.proposals[0].geometry) < len(raw_left.exterior.coords) / 2
    assert _vertices(result.value.proposals[1].geometry) < len(raw_right.exterior.coords) / 2

    assert left.intersection(right).area == pytest.approx(0.0, abs=1e-6)
    union = left.union(right)
    assert union.geom_type == "Polygon"
    assert len(union.interiors) == 0

    # The control. Same two polygons, same tolerance, simplified independently —
    # which is what any implementation that reached for `shapely.simplify` per
    # feature would do. It must fail the assertions above; if it did not, the
    # test would be asserting nothing about topology.
    tolerance = vectorize.SIMPLIFY_TOLERANCE_PIXELS * gsd
    naive_left = raw_left.simplify(tolerance)
    naive_right = raw_right.simplify(tolerance)
    naive_union = naive_left.union(naive_right)
    assert (
        naive_left.intersection(naive_right).area > 0.0
        or naive_union.geom_type != "Polygon"
        or len(naive_union.interiors) > 0
    ), "the fixture stopped discriminating: per-polygon simplification no longer slivers"


def test_the_same_shape_simplifies_identically_at_high_and_low_latitude(gsd) -> None:
    """KTD7. A tolerance in degrees is a different distance at every latitude.

    Douglas-Peucker in degrees is the classic bug in this pipeline: one degree of
    longitude is 101 km at 24 N and 50 km at 63 N, so the same numeric tolerance
    erases a two-metre wiggle in Mexico and preserves it in Alaska. The identical
    mask is georeferenced at both latitudes here, and the two results must be the
    same shape in metres — not merely similar.
    """
    array = _notched_mask()
    results = {}
    for label, northing in (("low", LOW_NORTHING), ("high", HIGH_NORTHING)):
        transform = _transform(northing)
        corridor = _classified((_feature(array, FeatureKind.GREEN, gsd),), transform, gsd)
        result = vectorize.vectorize_corridor(corridor)
        assert isinstance(result, Ok), result
        results[label] = result.value.proposals[0]

    # Sanity: the two really are at different latitudes, so the comparison means
    # something.
    low_lat = shape(results["low"].geometry).bounds[1]
    high_lat = shape(results["high"].geometry).bounds[1]
    assert low_lat < 30.0 < 55.0 < high_lat

    assert results["low"].vertex_count == results["high"].vertex_count
    # And the teeth were removed, rather than both being returned untouched —
    # otherwise identical outputs would prove only that nothing happened.
    assert results["low"].vertex_count < 12

    # Same metric shape, up to the translation between the two northings.
    metric = {}
    for label in ("low", "high"):
        geom = _to_item_crs(results[label].geometry)
        minx, miny, _, _ = geom.bounds
        metric[label] = translate(geom, xoff=-minx, yoff=-miny)
    difference = metric["low"].symmetric_difference(metric["high"]).area
    assert difference < metric["low"].area * 1e-6


def test_output_coordinates_are_wgs84_longitude_then_latitude(gsd) -> None:
    """R4. GeoJSON is [longitude, latitude], and a swap is silently plausible.

    The raster sits in UTM zone 10N at 4,000,000 m north: longitude near -123,
    latitude near +36. The two differ in sign and in magnitude, so a swapped pair
    lands in the Indian Ocean rather than merely looking a little off — which a
    symmetric test site would not catch.
    """
    transform = _transform()
    array = _staircase_mask()
    corridor = _classified((_feature(array, FeatureKind.BUNKER, gsd),), transform, gsd)

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert proposal.geometry["type"] == "Polygon"
    ring = proposal.geometry["coordinates"][0]
    for longitude, latitude in ring:
        assert -124.0 < longitude < -122.0, (longitude, latitude)
        assert 35.0 < latitude < 37.0, (longitude, latitude)

    # And the whole payload survives a JSON round trip, since U5 serializes it.
    # Compared through `json.loads` on both sides because shapely's `mapping`
    # produces tuples where JSON produces lists; the coordinates are what matter.
    collection = result.value.to_feature_collection()
    round_tripped = json.loads(json.dumps(collection))["features"][0]["geometry"]
    assert round_tripped == json.loads(json.dumps(proposal.geometry))


def test_a_polygon_over_the_vertex_cap_is_simplified_further_rather_than_returned(gsd) -> None:
    """R4. The cap is a loop, not a single pass.

    One tolerance chosen from the pixel size is a guess, and a deeply crenellated
    mask blows straight through the cap at it. The tolerance has to escalate until
    the shape fits, and the result still has to be the shape — a proposal that met
    the cap by collapsing to a triangle would be worse than the blob.
    """
    transform = _transform()
    array = _sawtooth_mask()
    corridor = _classified((_feature(array, FeatureKind.FAIRWAY, gsd),), transform, gsd)

    raw = _raw_polygons(array, transform)[0]
    assert len(raw.exterior.coords) > 3 * vectorize.MAX_PROPOSAL_VERTICES

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert proposal.vertex_count <= vectorize.MAX_PROPOSAL_VERTICES
    # The escalation happened: the reported tolerance is coarser than the default.
    assert result.value.simplify_tolerance_meters > vectorize.SIMPLIFY_TOLERANCE_PIXELS * gsd
    # Still the fairway, not a triangle where the fairway was.
    assert _to_item_crs(proposal.geometry).area == pytest.approx(raw.area, rel=0.1)


def test_a_shape_that_cannot_reach_the_cap_is_returned_with_a_note_not_collapsed(gsd) -> None:
    """The documented escape hatch, exercised rather than only described.

    The cap is a target enforced by escalation, and escalation can run out —
    because the budget is finite, or because the next tolerance would collapse a
    small proposal beside a large one. When it does, the coarsest tolerance that
    kept every shape intact wins and the oversized proposal ships as it is. A
    contributor deleting nodes from a blocky fairway is doing five seconds of
    work; a contributor handed a triangle where the fairway was has to start over.
    """
    transform = _transform()
    array = _sawtooth_mask()
    corridor = _classified((_feature(array, FeatureKind.FAIRWAY, gsd),), transform, gsd)

    # No attempts at all is the sharpest form of "escalation ran out".
    result = vectorize.vectorize_corridor(corridor, max_attempts=0)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert proposal.vertex_count > vectorize.MAX_PROPOSAL_VERTICES
    assert any(str(vectorize.MAX_PROPOSAL_VERTICES) in note for note in proposal.notes), (
        proposal.notes
    )
    # Still the fairway, and still valid geometry, which is the point of shipping
    # it rather than simplifying until it fit.
    assert _to_item_crs(proposal.geometry).is_valid
    assert _to_item_crs(proposal.geometry).area == pytest.approx(
        _raw_polygons(array, transform)[0].area, rel=0.001
    )


def test_a_mask_with_a_hole_keeps_its_interior_ring(gsd) -> None:
    """A bunker cut into a green is a hole, and dropping it proposes turf over sand."""
    transform = _transform()
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[20:140, 20:200] = True
    array[70:100, 100:150] = False
    corridor = _classified((_feature(array, FeatureKind.GREEN, gsd),), transform, gsd)

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert len(proposal.geometry["coordinates"]) == 2
    assert _to_item_crs(proposal.geometry).area == pytest.approx(
        (120 * 180 - 30 * 50) * gsd * gsd, rel=0.02
    )


def test_a_mask_split_into_disjoint_parts_is_proposed_as_its_largest_part(gsd) -> None:
    """One proposal is one shape a contributor confirms and maps as one way.

    Four-connected polygonization splits a mask wherever two lobes touch only at
    a corner, which is an artifact of the connectivity rule rather than a golf
    feature in two pieces. The crumb is dropped and said so, instead of arriving
    as a MultiPolygon nobody can accept as a single OSM way.
    """
    transform = _transform()
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[20:120, 20:180] = True
    array[125:135, 185:195] = True
    corridor = _classified((_feature(array, FeatureKind.WATER, gsd),), transform, gsd)

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    (proposal,) = result.value.proposals
    assert proposal.geometry["type"] == "Polygon"
    assert _to_item_crs(proposal.geometry).area == pytest.approx(
        100 * 160 * gsd * gsd, rel=0.02
    )
    assert any("part" in note for note in proposal.notes), proposal.notes


def test_provenance_tee_assignments_and_missing_tee_sets_all_reach_the_client(gsd) -> None:
    """R5 and AE7. What U5 serializes has to be complete on its own.

    A proposal that cannot say which NAIP flight it came from cannot be attributed
    in a changeset, and a tee set nobody found has to arrive as a prompt rather
    than be silently dropped between units.
    """
    transform = _transform()
    tee = TeeSet(name="Blue", yards=400.0, key="blue")
    missing = (TeeSet(name="Red", yards=350.0, key="red"),)
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[60:90, 30:70] = True
    unclassified_array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    unclassified_array[10:20, 200:230] = True

    corridor = _classified(
        (_feature(array, FeatureKind.TEE, gsd, tee_set=tee),),
        transform,
        gsd,
        unclassified=(_feature(unclassified_array, FeatureKind.UNKNOWN, gsd),),
        missing_tee_sets=missing,
    )

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, Ok), result
    corridor_out = result.value
    # Unrecognised masks are counted, never vectorized into proposals.
    assert len(corridor_out.proposals) == 1
    assert corridor_out.unclassified_mask_count == 1
    (proposal,) = corridor_out.proposals
    assert proposal.tee_set == tee
    assert proposal.confidence == pytest.approx(0.86)
    assert proposal.provenance.acquired == dt.date(2023, 7, 4)
    assert proposal.provenance.gsd_meters == gsd
    assert proposal.provenance.source == naip.IMAGERY_SOURCE
    assert proposal.provenance.model_id == "facebook/sam2-hiera-large"
    assert [t.name for t in corridor_out.missing_tee_sets] == ["Red"]

    # And every one of those survives into the serialized form, per feature, so a
    # proposal lifted out of the collection still carries its acquisition date.
    collection = corridor_out.to_feature_collection()
    properties = collection["features"][0]["properties"]
    assert properties["kind"] == "tee"
    assert properties["acquired"] == "2023-07-04"
    assert properties["tee_set"]["name"] == "Blue"
    assert collection["properties"]["missing_tee_sets"][0]["name"] == "Red"
    json.dumps(collection)


def test_a_corridor_with_no_proposals_is_reported_as_no_coverage(gsd) -> None:
    """An empty answer is an answer, and `results.py` already has a name for it."""
    transform = _transform()
    unclassified_array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    unclassified_array[10:20, 200:230] = True
    corridor = _classified(
        (), transform, gsd, unclassified=(_feature(unclassified_array, FeatureKind.UNKNOWN, gsd),)
    )

    result = vectorize.vectorize_corridor(corridor)

    assert isinstance(result, NoCoverage), result
