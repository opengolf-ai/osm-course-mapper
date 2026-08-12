"""Feature classification: spectral rules, the positional prior, and tee matching.

Every scene here is painted rather than fetched. Real NAIP would make these tests
slow, network-bound and non-deterministic, and — more importantly — it would make
them unfalsifiable: the point of a classification test is that the ground truth is
known exactly, and "that patch is a bunker" is only known exactly when the test
painted it.

Two conventions run through the file:

* Geometry is expressed in **pixels** and converted to a WGS84 line at the last
  moment, because the assertions are about which mask sits at which end of the
  line, and pixel boxes are the only readable way to say that. `_line` inverts the
  raster's own transform so the line genuinely lands where the boxes are — if
  `classify_corridor` reprojected the line wrongly, the green would come back at
  the tee end and these tests would fail rather than pass by coincidence.
* Masks are constructed directly rather than by running `segment_corridor`, since
  `torch` and `segment-geospatial` are absent from the base install and the input
  to this unit is a `SegmentedCorridor` value, not a model.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import pytest
from pyproj import Transformer
from rasterio.crs import CRS

from service import classify, naip
from service.classify import FeatureKind
from service.results import Invalid, NoCoverage, Ok
from service.segment import CorridorMask, SegmentedCorridor

# A corridor 200 x 700 pixels: at NAIP's 0.6 m ground resolution that is 120 m
# across — U1's corridor width — and 420 m long, which is a real par 4.
HEIGHT, WIDTH = 200, 700

# The item CRS the synthetic raster is georeferenced in. UTM zone 10N, matching
# `utm_transform`'s origin, so the WGS84 line derived from it falls in California
# and `build_corridor` computes the same zone back.
ITEM_CRS = CRS.from_epsg(32610)

# Spectral signatures in NAIP's R, G, B, NIR order. Each is chosen so its
# expected class is unambiguous under the default thresholds:
#   TURF         NDVI 0.54, visible 68  — vegetated and dark in the visible
#   SAND         NDVI 0.02, visible 187 — the bunker case: bright, not vegetated
#   WATER        NDVI -0.27, NIR 20     — the water case: NIR absorbed outright
#   SHADOW_TURF  NDVI 0.71, visible 28  — dark like water, but NIR stays high
#   BARE         NDVI 0.03, visible 130 — matches no rule: not turf, not bright
#                                          enough for sand, too much NIR for water
TURF = (60, 90, 55, 200)
SAND = (205, 190, 165, 215)
WATER = (35, 45, 50, 20)
SHADOW_TURF = (25, 35, 25, 150)
BARE = (140, 130, 120, 150)

# Boxes are (row_start, row_stop, col_start, col_stop), stops exclusive, matching
# `CorridorMask.bbox_pixels` and conftest's `paint`.
GREEN_BOX = (70, 130, 640, 700)
TEE_BACK_BOX = (90, 110, 20, 45)
TEE_MIDDLE_BOX = (70, 88, 50, 72)
TEE_FORWARD_BOX = (112, 130, 80, 102)
FAIRWAY_BOX = (85, 115, 120, 560)
BUNKER_BOX = (40, 64, 600, 630)
POND_BOX = (140, 180, 300, 380)

# The drawn line's endpoints, in pixels: along the corridor's centre row, from
# just inside the back tee to the middle of the green.
INITIAL_ROWCOL = (100, 30)
TERMINAL_ROWCOL = (100, 670)

# 640 columns at 0.6 m. Stated here because the expected tee yardages below are
# derived from it, and a reader should be able to check the arithmetic.
LINE_LENGTH_METERS = 640 * 0.6

# Yardages placing each tee set exactly on its painted mask: a set's tee sits
# `yardage` back from the green, so its expected position along the line is
# `line length - yardage`. The 350 yd set has no mask painted for it anywhere and
# is the "possibly missing tee" of AE7.
TEE_SETS = (
    classify.TeeSet(name="Black", yards=420.0, key="black"),
    classify.TeeSet(name="Blue", yards=400.0, key="blue"),
    classify.TeeSet(name="White", yards=380.0, key="white"),
    classify.TeeSet(name="Red", yards=350.0, key="red"),
)


def _turf_scene() -> np.ndarray:
    """A 4-band raster of featureless turf, sized for this module's boxes."""
    scene = np.zeros((4, HEIGHT, WIDTH), dtype=np.uint8)
    for band, value in enumerate(TURF):
        scene[band, :, :] = value
    return scene


def _xy(transform, row: float, col: float) -> tuple[float, float]:
    """The projected centre of a pixel, applying the affine by hand.

    `rasterio.transform.xy` would do this, but writing it out keeps the pixel
    convention visible: the *centre* of (row, col), not its upper-left corner, so
    a point derived from a box's midpoint lands inside that box rather than on
    its boundary.
    """
    x = transform.c + transform.a * (col + 0.5) + transform.b * (row + 0.5)
    y = transform.f + transform.d * (col + 0.5) + transform.e * (row + 0.5)
    return (x, y)


def _line(transform, *rowcols: tuple[float, float]) -> list[tuple[float, float]]:
    """A WGS84 playing line through the given pixel positions.

    The inverse of what `classify_corridor` does internally, which is the point:
    the classifier has to reproject this back onto the raster grid, and a sign
    error or a swapped axis order there puts every endpoint in the wrong place.
    """
    to_wgs84 = Transformer.from_crs(ITEM_CRS, naip.WGS84, always_xy=True).transform
    return [to_wgs84(*_xy(transform, row, col)) for row, col in rowcols]


def _mask_array(box: tuple[int, int, int, int]) -> np.ndarray:
    row_start, row_stop, col_start, col_stop = box
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[row_start:row_stop, col_start:col_stop] = True
    return array


def _mask(
    box: tuple[int, int, int, int],
    gsd: float,
    *,
    predicted_iou: float = 0.92,
    stability_score: float = 0.94,
) -> CorridorMask:
    """A `CorridorMask` over a rectangular box, measured the way U2 measures.

    Area comes from the box's pixel count and the raster's own ground resolution,
    so the m2 figures the classifier's sanity ranges are compared against are the
    ones a real segmentation would have produced.
    """
    row_start, row_stop, col_start, col_stop = box
    pixel_count = (row_stop - row_start) * (col_stop - col_start)
    return CorridorMask(
        mask=_mask_array(box),
        predicted_iou=predicted_iou,
        stability_score=stability_score,
        pixel_count=pixel_count,
        area_sq_meters=pixel_count * gsd * gsd,
        bbox_pixels=box,
        centroid_rowcol=((row_start + row_stop - 1) / 2, (col_start + col_stop - 1) / 2),
    )


def _segmented(
    pixels: np.ndarray,
    masks: tuple[CorridorMask, ...],
    transform,
    gsd: float,
    line: list[tuple[float, float]],
) -> SegmentedCorridor:
    """Wrap painted pixels and hand-built masks as U2's output.

    The corridor on the raster is built from the same line the classifier is
    given, so the value is internally consistent even though nothing here asserts
    on it.
    """
    built = naip.build_corridor(line)
    assert isinstance(built, Ok), built
    raster = naip.CorridorRaster(
        pixels=pixels,
        transform=transform,
        crs=ITEM_CRS,
        acquired=dt.date(2023, 7, 4),
        gsd_meters=gsd,
        item_id="ca-2023",
        asset_href="file:///synthetic.tif",
        corridor=built.value,
    )
    ordered = tuple(sorted(masks, key=lambda m: (-m.pixel_count, m.centroid_rowcol)))
    return SegmentedCorridor(raster=raster, masks=ordered, model_id="facebook/sam2-hiera-large")


def _standard_hole(painter, transform, gsd):
    """The reference scene: green, three tees, fairway, one bunker, one pond.

    Every other scene in this file is a variation on it, so the layout is written
    once and the variations say only what they change.
    """
    scene = _turf_scene()
    painter(scene, BUNKER_BOX, SAND)
    painter(scene, POND_BOX, WATER)
    line = _line(transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = tuple(
        _mask(box, gsd)
        for box in (
            GREEN_BOX,
            TEE_BACK_BOX,
            TEE_MIDDLE_BOX,
            TEE_FORWARD_BOX,
            FAIRWAY_BOX,
            BUNKER_BOX,
            POND_BOX,
        )
    )
    return _segmented(scene, masks, transform, gsd, line), line


def _kinds(corridor: classify.ClassifiedCorridor) -> dict[tuple[int, int, int, int], FeatureKind]:
    """Map each mask's pixel box to the kind it was given, proposals and all."""
    return {f.mask.bbox_pixels: f.kind for f in corridor.all_features}


def test_a_mask_at_the_lines_terminal_point_classifies_as_green_and_the_near_end_as_tees(
    painter, utm_transform, gsd
) -> None:
    """AE2. The drawn line's endpoints are the whole positional prior.

    Green and tees are spectrally identical — both are mown, irrigated turf, and
    no combination of four bands separates them. The only thing that does is where
    they sit along the line the contributor drew, which is why the line survives
    into this unit after U2 refused to prompt with it.
    """
    segmented, line = _standard_hole(painter, utm_transform, gsd)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    kinds = _kinds(result.value)
    assert kinds[GREEN_BOX] is FeatureKind.GREEN
    assert kinds[TEE_BACK_BOX] is FeatureKind.TEE
    assert kinds[TEE_MIDDLE_BOX] is FeatureKind.TEE
    assert kinds[TEE_FORWARD_BOX] is FeatureKind.TEE
    assert kinds[FAIRWAY_BOX] is FeatureKind.FAIRWAY
    # Exactly one green: the review step asks "is that the green?" about one shape.
    assert len(result.value.of_kind(FeatureKind.GREEN)) == 1


def test_tee_masks_are_matched_to_scorecard_tee_sets_and_a_set_with_no_mask_is_surfaced(
    painter, utm_transform, gsd
) -> None:
    """AE7. The tee review step must open prefilled, and honest about what it missed.

    Each painted tee sits at exactly `line length - yardage` along the line for one
    scorecard set, so a correct matcher produces the mapping asserted below and a
    matcher that merely sorted by position would too — until the 350 yd set, which
    has no mask at all and must come back as possibly missing rather than being
    forced onto the nearest tee.
    """
    segmented, line = _standard_hole(painter, utm_transform, gsd)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    assigned = {
        f.mask.bbox_pixels: (f.tee_set.name if f.tee_set else None)
        for f in result.value.of_kind(FeatureKind.TEE)
    }
    assert assigned == {
        TEE_BACK_BOX: "Black",
        TEE_MIDDLE_BOX: "Blue",
        TEE_FORWARD_BOX: "White",
    }
    assert [t.name for t in result.value.missing_tee_sets] == ["Red"]

    # And the assignment follows the *yardages*, not the order the sets arrived
    # in. Swap two yardages and the two names must swap with them — without this,
    # a matcher that merely paired sorted masks against sorted sets would pass
    # everything above.
    swapped = (
        classify.TeeSet(name="Black", yards=420.0),
        classify.TeeSet(name="Blue", yards=380.0),
        classify.TeeSet(name="White", yards=400.0),
        classify.TeeSet(name="Red", yards=350.0),
    )
    reassigned = classify.classify_corridor(segmented, line, tee_sets=swapped)
    assert isinstance(reassigned, Ok), reassigned
    assert {
        f.mask.bbox_pixels: (f.tee_set.name if f.tee_set else None)
        for f in reassigned.value.of_kind(FeatureKind.TEE)
    } == {
        TEE_BACK_BOX: "Black",
        TEE_MIDDLE_BOX: "White",
        TEE_FORWARD_BOX: "Blue",
    }


def test_a_line_drawn_green_to_tee_is_rejected_rather_than_inverting_the_labels(
    painter, utm_transform, gsd
) -> None:
    """The most confident-looking wrong answer this system can produce.

    A reversed line inverts the positional prior silently: the tee complex becomes
    the green and the green becomes a tee, both with a model confidence attached,
    and the review step then asks the contributor to confirm a tee box as the
    green. Refusing the request is the only outcome that does not teach a
    contributor to distrust every proposal.
    """
    segmented, forward = _standard_hole(painter, utm_transform, gsd)
    reversed_line = list(reversed(forward))

    result = classify.classify_corridor(segmented, reversed_line, tee_sets=TEE_SETS)

    assert isinstance(result, Invalid), result
    assert result.field_name == "line"
    # The message has to name the fix, not just the fault: the contributor is
    # being asked to redraw, and "invalid line" does not say which way round.
    assert "tee" in result.message.lower() and "green" in result.message.lower()
    assert result.detail["tee_like_masks_at_terminal_point"] >= 2


def test_a_bright_low_ndvi_mask_classifies_as_bunker_not_green(
    painter, utm_transform, gsd
) -> None:
    """Position alone would call this a green; the spectrum overrules it.

    The sand is painted *at the line's terminal point*, which is the strongest
    possible positional claim to being the green. Spectral classification runs
    first for exactly this reason — the positional prior chooses among turf masks,
    it does not turn sand into turf.
    """
    scene = _turf_scene()
    greenside_sand = (85, 115, 655, 690)
    painter(scene, greenside_sand, SAND)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (_mask(greenside_sand, gsd), _mask(TEE_BACK_BOX, gsd), _mask(FAIRWAY_BOX, gsd))
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    assert _kinds(result.value)[greenside_sand] is FeatureKind.BUNKER
    assert result.value.of_kind(FeatureKind.GREEN) == ()


def test_a_dark_low_nir_mask_is_water_while_a_dark_high_nir_mask_is_shadowed_turf(
    painter, utm_transform, gsd
) -> None:
    """Both bands are load-bearing, and this is the pair that proves it.

    Water and turf under tree shade are near-indistinguishable in the visible
    bands — both are dark. NIR separates them outright: water absorbs it almost
    completely, while vegetation reflects it strongly even in shade. A brightness
    rule alone would propose a pond over half the shaded rough on a tree-lined
    hole and ask the contributor to reject each one.
    """
    scene = _turf_scene()
    painter(scene, POND_BOX, WATER)
    painter(scene, FAIRWAY_BOX, SHADOW_TURF)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (
        _mask(GREEN_BOX, gsd),
        _mask(TEE_BACK_BOX, gsd),
        _mask(FAIRWAY_BOX, gsd),
        _mask(POND_BOX, gsd),
    )
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    kinds = _kinds(result.value)
    assert kinds[POND_BOX] is FeatureKind.WATER
    assert kinds[FAIRWAY_BOX] is FeatureKind.FAIRWAY

    # The scope boundary of this unit: water is proposed as water. Whether it is a
    # *hazard* is a golf judgment (R14) reserved for the contributor, so nothing
    # here may decide it.
    pond = next(f for f in result.value.features if f.mask.bbox_pixels == POND_BOX)
    assert not hasattr(pond, "hazard")
    assert "hazard" not in pond.kind.value


def test_an_oversized_green_is_a_low_confidence_proposal_rather_than_a_drop(
    painter, utm_transform, gsd
) -> None:
    """Area is a confidence penalty, never a filter.

    5,000 m2 is double the top of the plausible green range, and a mask that big
    at the terminal point is most likely a green merged with its collar or its
    surrounding apron. A contributor can see that in one glance and drag the edge
    in; they cannot recover a proposal that was never sent.
    """
    # 100 x 139 pixels at 0.6 m is 5,004 m2.
    huge_green = (30, 130, 560, 699)
    scene = _turf_scene()
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (_mask(huge_green, gsd), _mask(TEE_BACK_BOX, gsd))
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    (green,) = result.value.of_kind(FeatureKind.GREEN)
    assert green.mask.area_sq_meters == pytest.approx(5004.0, rel=1e-3)
    # Still a proposal, and visibly less confident than the model alone would say.
    assert 0.0 < green.confidence < green.model_confidence
    assert green.area_penalty < 1.0
    # The raw scores stay recoverable: the penalty is applied on top of them, not
    # in place of them, so U5 can explain the number it shows.
    assert green.mask.predicted_iou == pytest.approx(0.92)
    assert green.mask.stability_score == pytest.approx(0.94)
    assert green.confidence == pytest.approx(green.model_confidence * green.area_penalty)
    assert any("m2" in note or "m²" in note for note in green.notes)


def test_two_turf_masks_at_the_terminal_end_resolve_to_exactly_one_green(
    painter, utm_transform, gsd
) -> None:
    """SAM routinely splits a green from its surround, or finds the apron beside it.

    Both masks are turf, both sit at the terminal end. The review step asks about
    one shape, so exactly one must win — and it must be the one the line actually
    ends inside, not merely the larger or the first.
    """
    apron = (20, 60, 620, 680)
    scene = _turf_scene()
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (
        _mask(GREEN_BOX, gsd),
        _mask(apron, gsd),
        _mask(TEE_BACK_BOX, gsd),
        _mask(FAIRWAY_BOX, gsd),
    )
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    greens = result.value.of_kind(FeatureKind.GREEN)
    assert len(greens) == 1
    assert greens[0].mask.bbox_pixels == GREEN_BOX
    assert _kinds(result.value)[apron] is not FeatureKind.GREEN


def test_a_corridor_with_no_water_returns_no_water_features(
    painter, utm_transform, gsd
) -> None:
    """Nothing forces a proposal per kind.

    R4 lists five kinds a proposal *may* be, not five kinds every hole *has*. Most
    holes have no water at all, and inventing one would make the water review step
    a rejection ritual.
    """
    scene = _turf_scene()
    painter(scene, BUNKER_BOX, SAND)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (
        _mask(GREEN_BOX, gsd),
        _mask(TEE_BACK_BOX, gsd),
        _mask(FAIRWAY_BOX, gsd),
        _mask(BUNKER_BOX, gsd),
    )
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    assert result.value.of_kind(FeatureKind.WATER) == ()
    assert result.value.of_kind(FeatureKind.BUNKER) != ()


def test_a_tee_mask_with_no_matching_set_degrades_to_an_unassigned_tee(
    painter, utm_transform, gsd
) -> None:
    """The client's tee slots are fixed at four, so an extra mask must not overflow.

    A course carrying two tee sets can still show four tee-shaped masks — a
    practice tee, a forward tee the card omits, a mask SAM split in half. The
    extra ones stay tees, unassigned, and the contributor names them; they never
    take a set that belongs to another mask and they never invent a fifth slot.
    """
    segmented, line = _standard_hole(painter, utm_transform, gsd)
    two_sets = (
        classify.TeeSet(name="Black", yards=420.0, key="black"),
        classify.TeeSet(name="Blue", yards=400.0, key="blue"),
    )

    result = classify.classify_corridor(segmented, line, tee_sets=two_sets)

    assert isinstance(result, Ok), result
    tees = result.value.of_kind(FeatureKind.TEE)
    assert len(tees) == 3
    assigned = [f.tee_set.name for f in tees if f.tee_set is not None]
    assert sorted(assigned) == ["Black", "Blue"]
    unassigned = [f for f in tees if f.tee_set is None]
    assert len(unassigned) == 1
    assert result.value.missing_tee_sets == ()


def test_masks_matching_no_rule_are_kept_apart_from_the_proposals(
    painter, utm_transform, gsd
) -> None:
    """A cart path is neither turf, sand nor water, and it is not a proposal.

    It is also not nothing: dropping it silently would make "the classifier
    proposed three features" indistinguishable from "the classifier understood
    three of six masks". It comes back separately so U5 can count it without U4
    vectorizing it.
    """
    path = (95, 105, 200, 500)
    scene = _turf_scene()
    painter(scene, path, BARE)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (_mask(GREEN_BOX, gsd), _mask(TEE_BACK_BOX, gsd), _mask(path, gsd))
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    assert [f.mask.bbox_pixels for f in result.value.unclassified] == [path]
    assert all(f.kind is not FeatureKind.UNKNOWN for f in result.value.features)


def test_a_corridor_whose_masks_all_match_no_rule_is_a_no_coverage_result(
    painter, utm_transform, gsd
) -> None:
    """No proposals is a legitimate answer, and U5 reports it with its own status.

    `Ok` with an empty feature list would reach the client as a successful
    detection that found nothing, indistinguishable from a silent bug.
    """
    path = (95, 105, 200, 500)
    scene = _turf_scene()
    painter(scene, path, BARE)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    segmented = _segmented(scene, (_mask(path, gsd),), utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, NoCoverage), result
    assert result.detail["unclassified_masks"] == 1


def test_the_fairway_is_the_largest_elongated_turf_mask_and_says_it_is_uncertain(
    painter, utm_transform, gsd
) -> None:
    """Fairway versus rough is the weakest call this unit makes, and it admits it.

    Both are turf with the same signature; the only cue in 0.6 m imagery is the
    mowing pattern, which SAM may or may not have cut a boundary along. The
    proposal is therefore capped below what the model's own scores would give it,
    so a contributor's attention lands where it is most likely needed.
    """
    rough = (10, 40, 200, 300)
    scene = _turf_scene()
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (
        _mask(GREEN_BOX, gsd),
        _mask(TEE_BACK_BOX, gsd),
        _mask(FAIRWAY_BOX, gsd),
        _mask(rough, gsd),
    )
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    (fairway,) = result.value.of_kind(FeatureKind.FAIRWAY)
    assert fairway.mask.bbox_pixels == FAIRWAY_BOX
    assert fairway.confidence < fairway.model_confidence
    assert any("fairway" in note.lower() for note in fairway.notes)


def test_a_par_three_fairway_is_proposed_but_marked_less_likely(
    painter, utm_transform, gsd
) -> None:
    """R6's other half: the scorecard's par shapes what the corridor should contain.

    Par 3 holes are commonly mapped tee-to-green with no separately mown fairway
    at all, so a fairway proposal on one deserves more suspicion than the same
    mask on a par 4 — but not suppression, because plenty of long par 3s do have
    one.
    """
    segmented, line = _standard_hole(painter, utm_transform, gsd)

    par4 = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS, par=4)
    par3 = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS, par=3)

    assert isinstance(par4, Ok) and isinstance(par3, Ok)
    (from_par4,) = par4.value.of_kind(FeatureKind.FAIRWAY)
    (from_par3,) = par3.value.of_kind(FeatureKind.FAIRWAY)
    assert from_par3.confidence < from_par4.confidence
    assert any("par 3" in note.lower() for note in from_par3.notes)


def test_the_spectral_thresholds_are_parameters_rather_than_buried_constants(
    painter, utm_transform, gsd
) -> None:
    """The default cut points are uncalibrated, so they must be replaceable.

    Nobody has measured NDVI over a bunker in NAIP for this project. The defaults
    are reasoned starting values, and the honest way to ship a reasoned starting
    value is to make it an argument — so that calibrating it later is a call-site
    change rather than an edit to this module.
    """
    scene = _turf_scene()
    painter(scene, BUNKER_BOX, SAND)
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    masks = (_mask(GREEN_BOX, gsd), _mask(TEE_BACK_BOX, gsd), _mask(BUNKER_BOX, gsd))
    segmented = _segmented(scene, masks, utm_transform, gsd, line)

    # Raise the brightness a bunker must reach above the painted sand's 187, and
    # the same pixels stop being a bunker.
    strict = classify.SpectralThresholds(bunker_min_brightness=240.0)
    result = classify.classify_corridor(segmented, line, thresholds=strict)

    assert isinstance(result, Ok), result
    assert result.value.of_kind(FeatureKind.BUNKER) == ()
    assert classify.DEFAULT_THRESHOLDS.bunker_min_brightness < 240.0


def test_a_line_with_fewer_than_two_points_is_rejected(painter, utm_transform, gsd) -> None:
    """Without two endpoints there is no positional prior at all."""
    segmented, line = _standard_hole(painter, utm_transform, gsd)

    result = classify.classify_corridor(segmented, line[:1], tee_sets=TEE_SETS)

    assert isinstance(result, Invalid), result
    assert result.field_name == "line"


def test_the_provenance_of_every_proposal_travels_with_it(
    painter, utm_transform, gsd
) -> None:
    """R5. A proposal names the imagery it came from, all the way to the client."""
    segmented, line = _standard_hole(painter, utm_transform, gsd)

    result = classify.classify_corridor(segmented, line, tee_sets=TEE_SETS)

    assert isinstance(result, Ok), result
    classified = result.value
    assert classified.acquired == dt.date(2023, 7, 4)
    assert classified.gsd_meters == pytest.approx(gsd)
    assert classified.model_id == "facebook/sam2-hiera-large"
    assert classified.source == naip.IMAGERY_SOURCE
    assert classified.line_length_meters == pytest.approx(LINE_LENGTH_METERS, abs=1.0)


@pytest.mark.heavy
@pytest.mark.network
def test_a_real_hole_classifies_its_green_bunkers_and_water() -> None:
    """The unit's stated verification, against real imagery and a real checkpoint.

    Marked `heavy` and `network`: it downloads a SAM 2 checkpoint and reads NAIP
    from Planetary Computer, so it runs only in the devcontainer U0 builds. The
    assertions are deliberately about presence and plausibility rather than exact
    geometry — the newest NAIP item over a bbox changes as the archive grows.

    Fairway is not asserted. It is the known-weak class (both it and rough are
    turf, and mowing pattern is the only cue at 0.6 m), and a test that failed
    intermittently on the weakest class would teach the team to ignore it.
    """
    from service import segment

    # TPC Sawgrass 17th: an island green ringed by water, with the tee complex
    # directly across it. If anything in this unit classifies water correctly, it
    # is this hole.
    hole_line = [(-81.3954, 30.1985), (-81.3949, 30.1979)]
    tee_sets = (
        classify.TeeSet(name="Players", yards=137.0),
        classify.TeeSet(name="Champion", yards=124.0),
        classify.TeeSet(name="Club", yards=110.0),
    )

    fetched = naip.fetch_corridor_raster(hole_line)
    assert isinstance(fetched, Ok), fetched
    segmented = segment.segment_corridor(fetched.value)
    assert isinstance(segmented, Ok), segmented

    result = classify.classify_corridor(segmented.value, hole_line, tee_sets=tee_sets, par=3)

    assert isinstance(result, Ok), result
    classified = result.value
    assert len(classified.of_kind(FeatureKind.GREEN)) == 1
    assert classified.of_kind(FeatureKind.WATER), "the island green's water was not found"
    assert all(0.0 <= f.confidence <= 1.0 for f in classified.features)
    # Every tee proposal either carries a scorecard set or says it has none; it
    # never carries one that belongs to another mask.
    assigned = [f.tee_set.name for f in classified.of_kind(FeatureKind.TEE) if f.tee_set]
    assert len(assigned) == len(set(assigned))
