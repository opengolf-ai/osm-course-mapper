"""Turn U3's classified masks into WGS84 GeoJSON a contributor can actually map.

This is the last geometry step before the endpoint. Its whole job is stated by
what happens to its output: a contributor looks at a proposal, says yes, and the
shape becomes an OpenStreetMap way. So "correct" here is not "matches the pixels"
— a polygon tracing every pixel corner of a 2,000 m2 green matches the pixels
perfectly and is 400 nodes of unmappable noise. Correct is *mappable*: the same
shape, at a node count a human would have drawn.

Four decisions carry that, and each of them is a place this unit quietly fails if
it is done the obvious way instead.

**1. Simplify in metres, in the projected CRS, before reprojecting (KTD7).**
Douglas-Peucker in degrees is the classic bug in this pipeline. One degree of
longitude is 101 km at the southern edge of the contiguous states and 50 km at
the Canadian border, so a single numeric tolerance means two different ground
distances at two different courses — and two different distances in x and y at
the *same* course. The corridor is already in a metre-based projected CRS when it
arrives here, so simplification happens there and reprojection to WGS84 happens
last, once, on the finished shapes.

**2. The CRS to simplify in is the *item's*, not the corridor's.** `Corridor`
carries a WGS84 UTM zone computed from the drawn line; `CorridorRaster.crs` is
whatever Planetary Computer served the NAIP item in, which is NAD83 UTM. They are
different data and the transform that georeferences the pixels belongs to the
second one. Vectorizing against the first would put every proposal a couple of
metres off — small enough to look right and large enough to be wrong.

**3. Simplify the whole collection at once, with `topojson` (KTD7).** SAM's masks
partition the corridor's pixels, so a green and its apron, or a fairway and the
bunker cut into its edge, share every vertex along their seam. Simplify each
polygon on its own and the two copies of that seam are reduced against different
rings with different anchors: they stop coinciding, and the pair overlaps in
places and gaps in others. Those slivers are exactly what a reviewer cannot fix
and OSM validators reject. `topojson` cuts the shared seam out as one arc,
simplifies the arc once, and rebuilds both polygons from it. That also forces a
**single tolerance for the whole corridor** — a per-feature tolerance would
reintroduce the problem it was chosen to solve — which is why the escalation
below moves every proposal together.

`rastachimp` is the library that appears to be built for this exact job and it
cannot be used: it is a 2019 alpha whose own test suite fails against the
Shapely 2 that samgeo's dependency chain requires, so the two cannot be installed
in one environment.

**4. The vertex cap is a loop, not a single pass.** A tolerance derived from the
pixel size is a starting guess. A deeply crenellated mask — a fairway edge broken
up by mowing lines, a pond fringed with reeds — blows through 80 vertices at it.
So the tolerance escalates until every proposal fits, and stops early if a
coarser tolerance would collapse one of them: an oversized proposal a contributor
trims is recoverable, and a green simplified into a triangle is not. See
`MAX_PROPOSAL_VERTICES` and `vectorize_corridor` for what happens when a shape
cannot reach the cap.

**Holes are kept; multi-part masks are reduced to their largest part.** Both are
real cases and they get opposite treatment on purpose. A hole is a feature — a
bunker cut into a green, an island in a pond — and OSM models it as the inner way
of a multipolygon, so dropping it would propose turf on top of sand. A mask in
two disjoint pieces is almost always an artifact of four-connected polygonization
splitting two lobes that touch at a corner, and a proposal is one shape a
contributor confirms and maps as one way; a MultiPolygon "green" is not something
they can accept. The dropped area is recorded in the proposal's notes rather than
disappearing.

**A `topojson` trap worth naming.** `Topology` accepts GeoJSON *Features*, and
`to_geojson()` then returns each feature's original `geometry` verbatim — the
arcs are simplified, the output is not. Silently. This module therefore feeds
`Topology` bare geometry mappings and carries identity by position, which is the
only form where the simplification actually reaches the output.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import topojson
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.features import shapes as raster_shapes
from rasterio.transform import Affine
from shapely import make_valid
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform as shapely_transform

from service.classify import ClassifiedCorridor, ClassifiedFeature, FeatureKind, TeeSet
from service.naip import WGS84
from service.results import NoCoverage, Ok, Result

#: The node ceiling for one proposal. Chosen against what a contributor would
#: have drawn by hand rather than against any OSM limit — a way may hold 2,000
#: nodes, and a 400-node green is legal and useless. Real mapped golf features run
#: from a dozen nodes for a tee box to perhaps sixty for an intricate green
#: complex, so 80 is generous at the top of that range while still ruling out the
#: traced-every-pixel blob. It is a target enforced by escalation, not an
#: invariant: see `vectorize_corridor` for the one case that exceeds it.
MAX_PROPOSAL_VERTICES = 80

#: The starting simplification tolerance, in pixels. One to two pixels is the
#: range where Douglas-Peucker removes stair treads — which are pure
#: rasterization artifact, never signal — without moving a boundary further than
#: the imagery could locate it in the first place. 1.5 sits in the middle.
#:
#: In *pixels*, converted to metres against the item's own ground resolution at
#: call time, because NAIP is flown at both 0.6 m and 1.0 m and a constant in
#: metres would be 1.5 pixels on one flight and 0.9 on another.
SIMPLIFY_TOLERANCE_PIXELS = 1.5

#: How much coarser each escalation attempt is. Small enough that the accepted
#: tolerance is not wildly past what the cap needed — every step past it is detail
#: thrown away for nothing — and large enough that the budget below spans a useful
#: range rather than creeping.
TOLERANCE_GROWTH = 1.6

#: How many tolerances to try. With the growth above this reaches roughly 27x the
#: starting tolerance, or about 24 m on 0.6 m imagery — far coarser than any golf
#: feature's own detail, so a shape still over the cap at the end of it is not
#: going to be rescued by trying harder.
MAX_SIMPLIFY_ATTEMPTS = 8


@dataclass(frozen=True)
class Provenance:
    """Where a set of proposals came from: the flight, the model, the resolution.

    One value shared by the corridor and by every proposal on it, rather than
    fields copied onto each. R5 obliges every proposal to carry the acquisition
    date it was derived from, and a proposal that has been lifted out of the
    collection — pulled into a changeset comment, stored with a contributor's
    decision by U9 — must still be able to answer that. Sharing one frozen object
    makes the guarantee structural instead of a rule someone has to remember.
    """

    acquired: dt.date
    gsd_meters: float
    source: str
    model_id: str
    item_id: str

    def as_properties(self) -> dict[str, Any]:
        """JSON-ready provenance, for GeoJSON `properties`."""
        return {
            "acquired": self.acquired.isoformat(),
            "gsd_meters": self.gsd_meters,
            "source": self.source,
            "model_id": self.model_id,
            "item_id": self.item_id,
        }


@dataclass(frozen=True)
class ProposedFeature:
    """One proposal, as geometry a client can draw and a contributor can accept.

    This is the contract U5 serializes. `geometry` is a GeoJSON geometry mapping
    in WGS84 `[longitude, latitude]` — a plain dict rather than a shapely object,
    because it crosses a JSON boundary next and pydantic serializes a dict without
    being taught anything.

    `confidence` is U3's number verbatim, the one the contributor sees. `tee_set`
    is set only on tees and only when a scorecard set matched, exactly as it
    arrived. `area_sq_meters` is measured on the *simplified* polygon, not on the
    mask: it is the area of the shape being proposed, which is what a contributor
    is agreeing to.

    `notes` are U3's, plus anything this unit had to do to the geometry — a
    dropped disjoint part, a shape that would not fit the vertex cap. The reason a
    proposal looks the way it does travels with it.
    """

    kind: FeatureKind
    geometry: dict[str, Any]
    confidence: float
    area_sq_meters: float
    vertex_count: int
    provenance: Provenance
    tee_set: TeeSet | None = None
    notes: tuple[str, ...] = ()

    def as_geojson_feature(self) -> dict[str, Any]:
        """This proposal as a GeoJSON Feature, provenance included in properties.

        Provenance is repeated on every feature rather than only at the collection
        level so that a feature copied out on its own — which is what happens the
        moment a client hands one shape to an OSM editor — still says which NAIP
        flight it came from.
        """
        properties: dict[str, Any] = {
            "kind": str(self.kind),
            "confidence": self.confidence,
            "area_sq_meters": self.area_sq_meters,
            "vertex_count": self.vertex_count,
            "notes": list(self.notes),
            "tee_set": (
                None
                if self.tee_set is None
                else {
                    "name": self.tee_set.name,
                    "yards": self.tee_set.yards,
                    "key": self.tee_set.key,
                }
            ),
        }
        properties.update(self.provenance.as_properties())
        return {"type": "Feature", "geometry": self.geometry, "properties": properties}


@dataclass(frozen=True)
class VectorizedCorridor:
    """Every proposal for one hole, ready to leave the service.

    `missing_tee_sets` is carried through from U3 untouched. It is not decoration:
    "we could not find your white tee" is the prompt that gets a contributor to
    draw it, and a client that never receives it cannot ask.

    `simplify_tolerance_meters` is the tolerance the escalation settled on. It is
    reported rather than kept private because it is the single number that
    explains why a proposal looks blockier than the imagery, and because a
    reviewer comparing two runs of the same hole needs to know whether the
    geometry changed or only the smoothing did.

    `unclassified_mask_count` preserves the distinction U3 draws between "we
    proposed three features" and "we understood three of six masks". Those masks
    are deliberately not vectorized — they are not proposals — but their existence
    is information.
    """

    proposals: tuple[ProposedFeature, ...]
    provenance: Provenance
    missing_tee_sets: tuple[TeeSet, ...] = ()
    simplify_tolerance_meters: float = 0.0
    unclassified_mask_count: int = 0

    def to_feature_collection(self) -> dict[str, Any]:
        """The whole corridor as one GeoJSON FeatureCollection.

        A FeatureCollection rather than a bespoke envelope because the client
        already renders GeoJSON and every viewer on earth reads this — which is
        also how this unit is verified by eye. Corridor-level facts that are not
        per-feature (the missing tee sets, the tolerance) ride in a top-level
        `properties` member: not part of RFC 7946, ignored by viewers, and read by
        our own client.
        """
        return {
            "type": "FeatureCollection",
            "features": [proposal.as_geojson_feature() for proposal in self.proposals],
            "properties": {
                "missing_tee_sets": [
                    {"name": tee.name, "yards": tee.yards, "key": tee.key}
                    for tee in self.missing_tee_sets
                ],
                "simplify_tolerance_meters": self.simplify_tolerance_meters,
                "unclassified_mask_count": self.unclassified_mask_count,
                **self.provenance.as_properties(),
            },
        }


def _metric_crs(classified: ClassifiedCorridor) -> CRS:
    """The CRS to simplify in: the item's, unless the item is not projected.

    NAIP on Planetary Computer is always served in a NAD83 UTM zone, so this
    returns `raster.crs` for every real request and the fallback never fires. It
    exists anyway because the alternative to a fallback is simplifying a tolerance
    expressed in metres against coordinates expressed in degrees — the exact bug
    KTD7 is about — and a `Corridor` already carries a metre-based zone computed
    for this line, so the recovery costs one branch.
    """
    raster = classified.corridor.raster
    if raster.crs.is_projected:
        return raster.crs
    return raster.corridor.utm_crs


def _meters_per_unit(crs: CRS) -> float:
    """How many metres one unit of `crs` is.

    1.0 for every UTM zone, which is every CRS this will see. Read rather than
    assumed because a projected CRS in US survey feet would otherwise take a
    tolerance of "1.5" as 1.5 feet and simplify three times too finely, and
    because reading it is one call.
    """
    if not crs.is_projected:
        return 1.0
    return float(crs.linear_units_factor[1])


def _largest_polygon(geometry: BaseGeometry) -> BaseGeometry | None:
    """The biggest polygonal part of a geometry, or `None` if there is none.

    Interior rings are untouched — see the module docstring for why holes are kept
    and disjoint parts are not.
    """
    if geometry.is_empty:
        return None
    if geometry.geom_type == "Polygon":
        return geometry
    parts = [
        part
        for part in getattr(geometry, "geoms", [])
        if part.geom_type == "Polygon" and not part.is_empty
    ]
    if not parts:
        return None
    return max(parts, key=lambda part: part.area)


def _polygonize(
    mask: np.ndarray,
    transform: Affine,
    to_metric: Callable[[float, float], tuple[float, float]] | None,
) -> tuple[BaseGeometry, float] | None:
    """One mask to one polygon in the metric CRS, plus the area dropped with it.

    `rasterio.features.shapes` traces pixel corners, so the result is a staircase
    with interior rings where the mask has holes and several parts where the mask
    has lobes joined only at a corner. Holes stay; the largest part wins and the
    rest is measured so the caller can say so. `None` means the mask held no
    polygon at all, which U2's filters should already have made impossible.

    Reprojection into the metric CRS happens here, before the parts are measured
    against each other, so the dropped area is reported in the same frame as
    everything else this unit says. For every real NAIP item `to_metric` is
    `None` and there is nothing to do.
    """
    parts = [
        shape(geometry)
        for geometry, _ in raster_shapes(
            mask.astype(np.uint8), mask=mask, transform=transform
        )
    ]
    if to_metric is not None:
        parts = [shapely_transform(to_metric, part) for part in parts]
    parts = [part for part in parts if not part.is_empty]
    if not parts:
        return None
    largest = max(parts, key=lambda part: part.area)
    dropped = sum(part.area for part in parts if part is not largest)
    return largest, dropped


def _vertex_count(geometry: BaseGeometry) -> int:
    """Every node in a polygon, exterior and interior rings alike.

    Interior rings count because a contributor uploading a green with a bunker cut
    out of it uploads both ways, and the cap is about how much geometry they are
    being asked to accept.
    """
    polygon = geometry
    if polygon.geom_type != "Polygon":
        return 0
    return len(polygon.exterior.coords) + sum(len(ring.coords) for ring in polygon.interiors)


def _toposimplify(
    geometries: Sequence[BaseGeometry], tolerance: float
) -> list[BaseGeometry] | None:
    """Simplify a whole collection at one tolerance, preserving shared boundaries.

    Bare geometry mappings go in, never GeoJSON Features: `topojson` 1.10 returns
    a Feature's original geometry verbatim from `to_geojson()`, so feeding it
    Features produces simplified arcs and unsimplified output, silently. Identity
    is therefore carried by position, and the assert below is what would catch
    that assumption breaking rather than letting proposals swap kinds.

    `prequantize=False` because quantization would snap coordinates to a grid
    derived from the collection's own bounding box — a second, invisible
    simplification on top of the one being asked for, at a resolution that changes
    with the corridor's size.

    Returns `None` when this tolerance destroys any member of the collection: an
    empty, zero-area or unrepairable ring. That is the signal to stop escalating
    and keep the last tolerance that worked.
    """
    topology = topojson.Topology(
        [mapping(geometry) for geometry in geometries], prequantize=False
    )
    collection = json.loads(topology.toposimplify(tolerance).to_geojson())
    features = collection["features"]
    assert len(features) == len(geometries), (
        "topojson returned a different number of geometries than it was given, so "
        "position no longer identifies a proposal"
    )

    simplified: list[BaseGeometry] = []
    for feature in features:
        geometry = shape(feature["geometry"])
        if not geometry.is_valid:
            # Douglas-Peucker can fold a narrow neck across itself. Repair rather
            # than reject: `make_valid` keeps the shape, and the largest part of
            # the repair is the feature. If the repair is empty the tolerance was
            # simply too coarse, which the caller handles by backing off.
            geometry = make_valid(geometry)
        polygon = _largest_polygon(geometry)
        if polygon is None or polygon.area <= 0.0:
            return None
        simplified.append(polygon)
    return simplified


def vectorize_corridor(
    classified: ClassifiedCorridor,
    *,
    max_vertices: int = MAX_PROPOSAL_VERTICES,
    tolerance_pixels: float = SIMPLIFY_TOLERANCE_PIXELS,
    tolerance_growth: float = TOLERANCE_GROWTH,
    max_attempts: int = MAX_SIMPLIFY_ATTEMPTS,
) -> Result[VectorizedCorridor]:
    """Vectorize U3's proposals into simplified WGS84 GeoJSON.

    Only `classified.features` are vectorized. `classified.unclassified` holds
    masks that matched no rule; they are counted and left as pixels, because
    proposing a shape nobody can name is asking a contributor a question with no
    answer.

    The tolerance starts at `tolerance_pixels` times the imagery's own ground
    resolution and escalates by `tolerance_growth` until no proposal exceeds
    `max_vertices`, for at most `max_attempts` tries. Every proposal moves at the
    same tolerance: a per-feature tolerance would break the shared arcs that
    KTD7's topology-aware simplification exists to keep, so one crenellated
    fairway does coarsen the green beside it. That is the trade, and it is the
    right way round — a slightly blockier green is a shape a contributor accepts,
    while a green with a sliver along its apron is one they cannot.

    **When a shape will not fit.** Escalation stops early if a tolerance would
    collapse any proposal to nothing, and stops anyway after `max_attempts`. In
    either case the coarsest tolerance that produced valid geometry is used, and
    any proposal still over the cap is returned as it is with a note saying so.
    Returning an 88-vertex green a contributor trims beats returning a triangle
    where the green was, and beats returning nothing; the note is what stops the
    cap from looking like a guarantee it is not.

    Returns `Ok(VectorizedCorridor)`, or `NoCoverage` when there was nothing to
    vectorize — no proposals at all, or none that held a polygon. That is a
    legitimately empty answer, not a failure, and `results.py` says why.
    """
    raster = classified.corridor.raster
    provenance = Provenance(
        acquired=classified.acquired,
        gsd_meters=classified.gsd_meters,
        source=classified.source,
        model_id=classified.model_id,
        item_id=raster.item_id,
    )

    if not classified.features:
        return NoCoverage(
            "There are no golf feature proposals in this corridor to vectorize.",
            detail={
                "item_id": raster.item_id,
                "acquired": classified.acquired.isoformat(),
                "unclassified_masks": len(classified.unclassified),
            },
        )

    metric_crs = _metric_crs(classified)
    meters_per_unit = _meters_per_unit(metric_crs)
    to_metric = (
        None
        if raster.crs == metric_crs
        else Transformer.from_crs(raster.crs, metric_crs, always_xy=True).transform
    )
    # always_xy on the way out is what makes the result [longitude, latitude]
    # rather than pyproj's authority-defined latitude-first order for EPSG:4326.
    to_wgs84 = Transformer.from_crs(metric_crs, WGS84, always_xy=True).transform

    sources: list[ClassifiedFeature] = []
    originals: list[BaseGeometry] = []
    extra_notes: list[tuple[str, ...]] = []

    for feature in classified.features:
        polygonized = _polygonize(feature.mask.mask, raster.transform, to_metric)
        if polygonized is None:
            continue
        geometry, dropped_area = polygonized
        notes: tuple[str, ...] = ()
        if dropped_area > 0.0:
            notes = (
                f"This mask polygonized into more than one disjoint part; the largest "
                f"was proposed and {dropped_area * meters_per_unit**2:.0f} m2 of "
                f"smaller parts was dropped, because one proposal is one shape.",
            )
        sources.append(feature)
        originals.append(geometry)
        extra_notes.append(notes)

    if not originals:
        return NoCoverage(
            "None of this corridor's proposals held a polygon once vectorized.",
            detail={
                "item_id": raster.item_id,
                "acquired": classified.acquired.isoformat(),
                "proposals": len(classified.features),
            },
        )

    # The starting tolerance in metres, then in the CRS's own units. Derived from
    # the resolution U1 read off the item, never from a constant: a 1.0 m flight
    # treated as 0.6 m is simplified two-thirds as hard as intended, and every
    # proposal comes back blockier or blobbier than it should.
    tolerance_meters = tolerance_pixels * classified.gsd_meters
    accepted: list[BaseGeometry] = originals
    accepted_tolerance = 0.0

    for _ in range(max_attempts):
        simplified = _toposimplify(originals, tolerance_meters / meters_per_unit)
        if simplified is None:
            # This tolerance destroys something. Keep the last one that did not.
            break
        accepted = simplified
        accepted_tolerance = tolerance_meters
        if max(_vertex_count(geometry) for geometry in simplified) <= max_vertices:
            break
        tolerance_meters *= tolerance_growth

    proposals: list[ProposedFeature] = []
    for feature, geometry, notes in zip(sources, accepted, extra_notes, strict=True):
        vertices = _vertex_count(geometry)
        if vertices > max_vertices:
            reached = (
                "no simplification tolerance held its shape"
                if accepted_tolerance <= 0.0
                else f"the coarsest tolerance that held its shape was {accepted_tolerance:.1f} m"
            )
            notes = notes + (
                f"This shape has {vertices} nodes, above the {max_vertices}-node target: "
                f"{reached}. It is proposed as it is rather than simplified until it "
                f"stopped being the feature; trimming it is quicker than redrawing it.",
            )
        proposals.append(
            ProposedFeature(
                kind=feature.kind,
                geometry=mapping(shapely_transform(to_wgs84, geometry)),
                confidence=feature.confidence,
                area_sq_meters=float(geometry.area * meters_per_unit**2),
                vertex_count=vertices,
                provenance=provenance,
                tee_set=feature.tee_set,
                notes=feature.notes + notes,
            )
        )

    return Ok(
        VectorizedCorridor(
            proposals=tuple(proposals),
            provenance=provenance,
            missing_tee_sets=classified.missing_tee_sets,
            simplify_tolerance_meters=accepted_tolerance,
            unclassified_mask_count=len(classified.unclassified),
        )
    )
