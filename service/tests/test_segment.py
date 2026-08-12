"""Corridor segmentation: image preparation, morphology, and the degenerate cases.

Every test here injects a mask generator. That is not a convenience — it is the
only way this unit is testable at all in the default environment, because `torch`
and `segment-geospatial` live in the `segmentation` extra and are deliberately
absent from the base install (see `pyproject.toml`). The one test that would load
a real SAM 2 checkpoint carries the `heavy` marker and does not run here.

Two fakes, doing different jobs:

* `ThresholdMaskGenerator` actually segments the array it is handed, by
  brightness. It is what makes the blob tests non-tautological: if
  `corridor_rgb` transposed a (band, row, col) raster wrongly, or handed over
  NIR instead of red, the blob would come back at the wrong coordinates or not
  at all, and the assertions on extent would fail. samgeo's own
  `prepare_image_for_sam` defaults to `channel_axis=-1`, so it would read U1's
  (4, H, W) array as a 4-row image — that transpose is a real trap and this fake
  is what pins it shut.
* `StubMaskGenerator` returns masks dictated by the test, for the cases where
  the point is what *we* do to a mask afterwards — carry its scores, open away
  its speckle, discard it for covering the whole frame.

The mask dictionaries both fakes emit use SAM's own automatic-generation keys
(`segmentation`, `predicted_iou`, `stability_score`, `area`, `bbox`) so the
parsing under test is the parsing the real generator will exercise.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import numpy as np
import pytest
from rasterio.crs import CRS

from service import naip, segment
from service.results import NoCoverage, Ok, Upstream

# A US hole, so `build_corridor` produces a real corridor. The synthetic pixels
# below are not georeferenced to it; the corridor is here because
# `CorridorRaster` carries one, not because these tests assert on its geometry.
CALIFORNIA_LINE = [(-121.9490, 36.5680), (-121.9520, 36.5700)]

# Spectral signatures for the synthetic scenes, in NAIP's R, G, B, NIR order.
TURF = (60, 90, 55, 200)
SAND = (205, 190, 165, 215)


def _raster(pixels: np.ndarray, transform: Any, gsd: float) -> naip.CorridorRaster:
    """Wrap synthetic pixels in a `CorridorRaster` with plausible provenance."""
    built = naip.build_corridor(CALIFORNIA_LINE)
    assert isinstance(built, Ok)
    return naip.CorridorRaster(
        pixels=pixels,
        transform=transform,
        crs=CRS.from_epsg(32610),
        acquired=dt.date(2022, 6, 15),
        gsd_meters=gsd,
        item_id="ca-2022",
        asset_href="file:///synthetic.tif",
        corridor=built.value,
    )


def _components(binary: np.ndarray) -> list[np.ndarray]:
    """8-connected components of a boolean array, as boolean masks.

    Written out rather than imported because `scipy` is not a dependency of this
    service and adding one for a test helper would be a poor trade.
    """
    height, width = binary.shape
    seen = np.zeros_like(binary)
    found: list[np.ndarray] = []
    for seed in zip(*np.nonzero(binary), strict=True):
        if seen[seed]:
            continue
        component = np.zeros_like(binary)
        stack = [seed]
        seen[seed] = True
        component[seed] = True
        while stack:
            row, col = stack.pop()
            for row_offset in (-1, 0, 1):
                for col_offset in (-1, 0, 1):
                    neighbour_row, neighbour_col = row + row_offset, col + col_offset
                    if not (0 <= neighbour_row < height and 0 <= neighbour_col < width):
                        continue
                    if binary[neighbour_row, neighbour_col] and not seen[
                        neighbour_row, neighbour_col
                    ]:
                        seen[neighbour_row, neighbour_col] = True
                        component[neighbour_row, neighbour_col] = True
                        stack.append((neighbour_row, neighbour_col))
        found.append(component)
    return found


def _annotation(
    mask: np.ndarray, *, predicted_iou: float, stability_score: float
) -> dict[str, Any]:
    """A mask dictionary shaped like SAM 2's automatic mask generator output."""
    rows, cols = np.nonzero(mask)
    return {
        "segmentation": mask,
        "area": int(mask.sum()),
        "bbox": [
            int(cols.min()),
            int(rows.min()),
            int(cols.max() - cols.min()) + 1,
            int(rows.max() - rows.min()) + 1,
        ],
        "predicted_iou": predicted_iou,
        "stability_score": stability_score,
        "point_coords": [[float(cols.mean()), float(rows.mean())]],
    }


class ThresholdMaskGenerator:
    """Segments the image it is given by brightness, and records how it was called.

    Deliberately class-agnostic, like SAM: it enumerates every bright region it
    can find with no notion of what any of them are, and no way to be steered
    toward one. `calls` and `call_kwargs` exist so a test can assert that no
    prompt — no point list, no box — was ever passed (KTD2).
    """

    def __init__(self, threshold: int = 130) -> None:
        self.threshold = threshold
        self.calls: list[np.ndarray] = []
        self.call_kwargs: list[dict[str, Any]] = []

    def generate(self, image: np.ndarray, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append(image)
        self.call_kwargs.append(kwargs)
        brightness = image.mean(axis=2)
        return [
            _annotation(component, predicted_iou=0.93, stability_score=0.97)
            for component in _components(brightness > self.threshold)
        ]


class StubMaskGenerator:
    """Returns exactly the annotations it was constructed with."""

    def __init__(self, annotations: list[dict[str, Any]]) -> None:
        self.annotations = annotations
        self.calls: list[np.ndarray] = []

    def generate(self, image: np.ndarray, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls.append(image)
        return list(self.annotations)


class ExplodingMaskGenerator:
    """Raises the way a checkpoint load or a CUDA allocation failure would."""

    def generate(self, image: np.ndarray, **kwargs: Any) -> list[dict[str, Any]]:
        raise RuntimeError("CUDA out of memory")


def test_a_single_bright_blob_returns_one_mask_covering_it(
    uniform_corridor, painter, utm_transform, gsd
) -> None:
    """The base case, and the one that pins the band order and the transpose."""
    painter(uniform_corridor, (80, 110, 100, 140), SAND)
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=ThresholdMaskGenerator())

    assert isinstance(result, Ok), result
    (mask,) = result.value.masks
    expected = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    expected[80:110, 100:140] = True
    assert np.array_equal(mask.mask, expected)
    assert mask.bbox_pixels == (80, 110, 100, 140)
    # 1,200 pixels at 0.6 m ground resolution. Computed from the raster's own
    # `gsd_meters` rather than a constant, because NAIP items are 0.6 m or 1.0 m.
    assert mask.area_sq_meters == pytest.approx(1200 * gsd * gsd)


def test_a_blob_well_away_from_the_drawn_line_still_returns_a_mask(
    uniform_corridor, painter, utm_transform, gsd
) -> None:
    """KTD2's whole reason for automatic generation over prompting.

    The drawn line runs along the corridor's centre. A prompted model — points on
    the line, or a box around the corridor — returns what sits under the prompt
    and would never reach the second blob here, which stands for a greenside
    bunker set off the line. Automatic generation has no prompt to miss it with,
    and this test asserts both halves: the off-line blob comes back, and the
    generator was handed nothing but the image.
    """
    height = uniform_corridor.shape[1]
    centre_row = height // 2
    painter(uniform_corridor, (centre_row - 10, centre_row + 10, 180, 220), SAND)  # on the line
    painter(uniform_corridor, (5, 25, 300, 340), SAND)  # at the corridor's edge
    raster = _raster(uniform_corridor, utm_transform, gsd)
    generator = ThresholdMaskGenerator()

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    assert len(result.value.masks) == 2

    off_line = [m for m in result.value.masks if abs(m.centroid_rowcol[0] - centre_row) > 20]
    assert len(off_line) == 1
    # "Well away" stated in metres rather than pixels, since that is what makes
    # it a bunker off the fairway rather than a rounding difference.
    offset_meters = abs(off_line[0].centroid_rowcol[0] - centre_row) * gsd
    assert offset_meters > 25.0

    # No prompt of any kind reached the model.
    assert generator.call_kwargs == [{}]


def test_confidence_scores_are_carried_through_per_mask(
    uniform_corridor, utm_transform, gsd
) -> None:
    """R5 surfaces confidence to the contributor, and U3 penalises one half of it.

    The two scores stay separate fields rather than being multiplied or averaged
    into one number: U3 applies an area penalty on top, and a penalty applied to
    an already-collapsed score cannot be undone or explained.
    """
    first = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    first[20:60, 20:80] = True
    second = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    second[120:170, 200:260] = True
    generator = StubMaskGenerator(
        [
            _annotation(first, predicted_iou=0.912, stability_score=0.874),
            _annotation(second, predicted_iou=0.633, stability_score=0.991),
        ]
    )
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    scores = {
        (round(m.predicted_iou, 3), round(m.stability_score, 3)) for m in result.value.masks
    }
    assert scores == {(0.912, 0.874), (0.633, 0.991)}


def test_a_mask_missing_its_confidence_scores_is_reported_rather_than_defaulted(
    uniform_corridor, utm_transform, gsd
) -> None:
    """Absent scores mean the generator is not in automatic mode (KTD2).

    Defaulting them to zero would ship every proposal to the contributor marked
    "no confidence" and look like a model quality problem rather than a wiring
    problem, so it is surfaced instead.
    """
    mask = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    mask[20:60, 20:80] = True
    annotation = _annotation(mask, predicted_iou=0.9, stability_score=0.9)
    del annotation["stability_score"]
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=StubMaskGenerator([annotation]))

    assert isinstance(result, Upstream)
    assert result.source == "sam2"
    assert "stability_score" in result.message


def test_single_pixel_noise_is_removed_by_the_morphological_pass(
    uniform_corridor, utm_transform, gsd
) -> None:
    """Speckle survives vectorization as one-pixel polygons a contributor must reject.

    The opening also must not shave the blob it is cleaning — a green eroded by a
    pixel all the way round is a metre of area lost at every edit.
    """
    mask = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    mask[60:100, 120:180] = True
    for speckle in ((10, 10), (11, 300), (190, 20), (150, 390)):
        mask[speckle] = True
    generator = StubMaskGenerator([_annotation(mask, predicted_iou=0.9, stability_score=0.9)])
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    (cleaned,) = result.value.masks
    expected = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    expected[60:100, 120:180] = True
    assert np.array_equal(cleaned.mask, expected)
    assert cleaned.pixel_count == 40 * 60


def test_a_mask_that_is_nothing_but_noise_is_discarded_entirely(
    uniform_corridor, utm_transform, gsd
) -> None:
    """Opening it away leaves an empty mask, which is not a proposal."""
    mask = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    for speckle in ((10, 10), (40, 90), (120, 200), (180, 350)):
        mask[speckle] = True
    generator = StubMaskGenerator([_annotation(mask, predicted_iou=0.9, stability_score=0.9)])
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, NoCoverage)


def test_the_closing_pass_fills_pinholes_left_in_a_solid_feature(
    uniform_corridor, utm_transform, gsd
) -> None:
    """A hole in a bunker mask becomes an interior ring U4 would carry all the way
    to OSM, so it is closed here rather than explained later."""
    mask = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    mask[60:100, 120:180] = True
    mask[80, 150] = False
    generator = StubMaskGenerator([_annotation(mask, predicted_iou=0.9, stability_score=0.9)])
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    (cleaned,) = result.value.masks
    assert cleaned.mask[80, 150]
    assert cleaned.pixel_count == 40 * 60


def test_an_all_uniform_corridor_returns_no_masks_rather_than_one_covering_everything(
    uniform_corridor, utm_transform, gsd
) -> None:
    """Featureless turf is a legitimately empty answer, not a full-frame proposal.

    SAM is not free to decline: given a scene with nothing in it, automatic
    generation still returns a mask, and the most likely one is the frame itself.
    A mask covering the whole corridor delineates nothing the caller did not
    already know — it is the corridor, which the caller drew.
    """
    whole_frame = np.ones(uniform_corridor.shape[1:], dtype=bool)
    generator = StubMaskGenerator(
        [_annotation(whole_frame, predicted_iou=0.88, stability_score=0.95)]
    )
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, NoCoverage)
    assert "no" in result.message.lower()


def test_no_masks_at_all_is_a_no_coverage_result_not_an_empty_success(
    uniform_corridor, utm_transform, gsd
) -> None:
    """U5 answers this with its own status; an empty `Ok` would be a silent bug."""
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=StubMaskGenerator([]))

    assert isinstance(result, NoCoverage)


def test_a_mask_lying_on_uncovered_pixels_is_discarded(
    uniform_corridor, painter, utm_transform, gsd
) -> None:
    """U1 reads boundless, so a corridor at a NAIP quad edge is padded with zeros.

    All-zero pixels are absence of imagery, not dark ground. Left in, the region
    would reach U3 with low NIR and low brightness and classify as a pond.
    """
    painter(uniform_corridor, (0, 200, 300, 400), (0, 0, 0, 0))
    hole = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    hole[40:120, 310:390] = True
    real = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    real[40:120, 60:140] = True
    generator = StubMaskGenerator(
        [
            _annotation(hole, predicted_iou=0.99, stability_score=0.99),
            _annotation(real, predicted_iou=0.80, stability_score=0.80),
        ]
    )
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    (kept,) = result.value.masks
    assert kept.predicted_iou == pytest.approx(0.80)


def test_the_generator_receives_a_contiguous_uint8_rgb_image_in_row_column_order(
    uniform_corridor, painter, utm_transform, gsd
) -> None:
    """samgeo's `prepare_image_for_sam` defaults to `channel_axis=-1`.

    Hand it U1's (4, height, width) array and it reads a 4-row image, silently.
    The RGB image is therefore built here, and this asserts its shape, dtype,
    contiguity and band order rather than trusting the library to guess.
    """
    painter(uniform_corridor, (10, 20, 30, 40), SAND)
    raster = _raster(uniform_corridor, utm_transform, gsd)
    generator = ThresholdMaskGenerator()

    segment.segment_corridor(raster, mask_generator=generator)

    (image,) = generator.calls
    assert image.shape == (200, 400, 3)
    assert image.dtype == np.uint8
    assert image.flags["C_CONTIGUOUS"]
    # Red, green, blue — not NIR, which is band 4 and stays behind for U3.
    assert tuple(image[15, 35]) == SAND[:3]
    assert tuple(image[150, 350]) == TURF[:3]


def test_a_generator_failure_surfaces_as_a_typed_upstream_result(
    uniform_corridor, utm_transform, gsd
) -> None:
    """A CUDA or checkpoint exception is not a contract any client can read."""
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=ExplodingMaskGenerator())

    assert isinstance(result, Upstream)
    assert result.source == "sam2"
    assert "CUDA out of memory" in (result.cause or "")


def test_masks_come_back_largest_first_and_carry_their_provenance(
    uniform_corridor, utm_transform, gsd
) -> None:
    """Ordering is fixed so two runs over one corridor propose in the same order.

    Provenance rides along because R5 requires every proposal to name the NAIP
    acquisition date it was derived from, and U3 must not have to go looking for
    it.
    """
    small = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    small[10:40, 10:40] = True
    large = np.zeros(uniform_corridor.shape[1:], dtype=bool)
    large[100:180, 200:320] = True
    generator = StubMaskGenerator(
        [
            _annotation(small, predicted_iou=0.99, stability_score=0.99),
            _annotation(large, predicted_iou=0.50, stability_score=0.50),
        ]
    )
    raster = _raster(uniform_corridor, utm_transform, gsd)

    result = segment.segment_corridor(raster, mask_generator=generator)

    assert isinstance(result, Ok), result
    segmented = result.value
    assert [m.pixel_count for m in segmented.masks] == [80 * 120, 30 * 30]
    assert segmented.acquired == dt.date(2022, 6, 15)
    assert segmented.gsd_meters == pytest.approx(gsd)
    assert segmented.model_id == segment.SAM2_MODEL_ID
    assert segmented.raster is raster


def test_the_pinned_checkpoint_is_one_samgeo_will_accept() -> None:
    """`SamGeo2` validates `model_id` against four ids and rejects every `sam2.1-*`.

    Asserted here rather than left to the devcontainer because the failure mode
    is a `ValueError` raised only once a real run reaches the constructor — long
    after the corridor has been fetched, and only in an environment that cannot
    run in CI.
    """
    assert segment.SAM2_MODEL_ID == "facebook/sam2-hiera-large"
    assert segment.SAM2_MODEL_ID in segment.SAM2_ALLOWED_MODEL_IDS
    assert not any("sam2.1" in model_id for model_id in segment.SAM2_ALLOWED_MODEL_IDS)


@pytest.mark.heavy
@pytest.mark.network
def test_a_real_hole_corridor_returns_masks_for_its_green_and_bunkers() -> None:
    """The unit's stated verification, against a real checkpoint and real imagery.

    Marked `heavy` *and* `network`: it downloads a multi-gigabyte SAM 2 checkpoint
    and reads NAIP from Planetary Computer, so it runs only in the devcontainer
    built by U0. Assertions are about plausibility rather than exact geometry —
    the newest NAIP item over a bbox changes as the archive grows, and SAM's mask
    count is not a stable number to assert on.

    The real check the unit calls for is visual, and cannot be automated: the
    masks must correspond to the hole's green and its bunkers, *including bunkers
    set off the playing line*. `off_line_masks` below is the machine-checkable
    part of that — if automatic generation had silently degraded to a prompted
    path, every mask would sit on the line.
    """
    # Pebble Beach's 7th: short, cliff-side, with bunkers ringing the green well
    # off the tee-to-green line.
    line = [(-121.9503, 36.5665), (-121.9509, 36.5659)]

    fetched = naip.fetch_corridor_raster(line)
    assert isinstance(fetched, Ok), fetched
    raster = fetched.value

    result = segment.segment_corridor(raster)

    assert isinstance(result, Ok), result
    segmented = result.value
    assert len(segmented.masks) >= 2
    assert all(0.0 <= m.predicted_iou <= 1.0 for m in segmented.masks)
    assert all(0.0 <= m.stability_score <= 1.0 for m in segmented.masks)
    # Greens and bunkers are tens to hundreds of square metres, not the corridor.
    assert all(10.0 <= m.area_sq_meters <= 20_000.0 for m in segmented.masks)

    centre_row = raster.pixels.shape[1] / 2
    off_line_masks = [
        m
        for m in segmented.masks
        if abs(m.centroid_rowcol[0] - centre_row) * raster.gsd_meters > 20.0
    ]
    assert off_line_masks, "every mask sat on the drawn line; automatic generation regressed"
