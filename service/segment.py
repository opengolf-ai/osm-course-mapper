"""Enumerate every mask in a NAIP corridor with SAM 2, and label none of them.

This is the model boundary. U1 hands it pixels; it hands U3 a list of unlabeled
regions with confidence scores attached, and U3 decides which one is a green.
Nothing here knows what a bunker is, and that separation is KTD3: SAM is
class-agnostic, no labeled golf training set exists, and pretending the model can
classify would put a wrong label in front of a contributor with a model's
confidence behind it.

**Automatic mask generation, never a prompt.** This is the single most important
decision in the unit and the easiest one to quietly undo. SAM's prompted paths
disambiguate *one* object: give it points and it returns what lies under them,
give it a box and it returns what fills the box. The drawn playing line is right
there and looks like an obvious prompt — and a prompted run would return the
fairway the line lies on, the green at its end, and nothing else, because a
greenside bunker twenty metres off the line has no prompt on it. Automatic
generation samples a grid over the whole corridor instead and enumerates
everything, which is exactly what R4 asks for. The line is U3's positional prior;
it is not a model input, and `segment_corridor` deliberately does not accept one.

Automatic generation is also the only samgeo path that returns `predicted_iou`
and `stability_score` per mask, and R5 requires a confidence to show the
contributor. The two are kept as separate fields all the way through rather than
folded into a single number, because U3 applies an area-based penalty on top of
them and a penalty applied to an already-collapsed score can neither be undone
nor explained.

**What is ours rather than the model's.** Three things happen to every mask after
SAM returns it, and none of them is something the model does:

1. A morphological open, then close, with a 3x3 element. Opening removes the
   single-pixel speckle that would otherwise survive U4's vectorization as
   one-pixel polygons a contributor has to reject by hand; closing fills the
   pinholes that would survive as interior rings. Neither pass moves the edge of
   a solid region, so a green does not lose a metre of perimeter to the cleanup.
2. Discarding masks that are nothing. Empty after opening, below any plausible
   feature size, covering essentially the whole corridor, or lying on the zeros
   U1's boundless read leaves where NAIP does not cover — see the constants for
   each rationale.
3. Deciding that no masks is an *answer*. A corridor of featureless turf comes
   back as `NoCoverage`, not `Ok([])`: SAM is not free to decline, so a scene
   with nothing in it still produces a mask and the likeliest one is the frame.
   `results.py` names this case explicitly and U5 answers it with its own status.

**Import discipline.** `torch` and `segment-geospatial` are gigabytes and live in
the `segmentation` extra, so this module must import — and its logic must be
testable — with neither installed. Everything model-shaped is therefore behind a
lazy import inside `Sam2MaskGenerator.generate`, the same pattern `naip.py` uses
for `planetary_computer`, and the generator itself is injectable so the tests
supply a fake.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from service.naip import CorridorRaster
from service.results import NoCoverage, Ok, Result, Upstream

#: The checkpoint, pinned. `SamGeo2` validates `model_id` against exactly these
#: four strings and raises `ValueError` on anything else — including every
#: `sam2.1-*` id, so the 2.1 line is not loadable through this library at all.
#: Pinning explicitly is what stops a library default moving underneath us and
#: changing every contributor's proposals with no code change of ours.
SAM2_ALLOWED_MODEL_IDS = (
    "facebook/sam2-hiera-tiny",
    "facebook/sam2-hiera-small",
    "facebook/sam2-hiera-base-plus",
    "facebook/sam2-hiera-large",
)
SAM2_MODEL_ID = "facebook/sam2-hiera-large"

#: Below this a mask cannot be any golf feature at any NAIP resolution — the
#: smallest bunker U3 will consider is roughly 40 m2 — so it is speckle the
#: morphological pass did not happen to catch. Deliberately well under U3's own
#: floor: U3 answers an out-of-range area with a confidence *penalty* rather than
#: a drop, and this threshold must not quietly preempt that.
MIN_MASK_AREA_SQ_METERS = 20.0

#: A mask covering essentially the entire corridor delineates nothing the caller
#: does not already know, because the corridor is the region the caller drew. The
#: fraction is measured against covered pixels rather than the whole frame, so a
#: corridor that is half NAIP-nodata is judged on the half that has imagery. A
#: fairway — the largest real feature — runs perhaps a quarter of a 120 m wide
#: corridor, so 90% costs nothing legitimate.
MAX_CORRIDOR_COVERAGE_FRACTION = 0.9

#: U1 reads boundless, so a corridor at the edge of a NAIP quad comes back padded
#: with zeros in all four bands. Those pixels are *absence of imagery*, not dark
#: ground: a mask sitting on them would reach U3 with low NIR and low visible
#: brightness and classify as a pond that is not there. Majority rather than
#: entirety, because a mask straddling the edge is dominated by the padding.
MAX_NODATA_FRACTION = 0.5

#: Three by three, applied once. Larger elements start rounding the corners of
#: real features — a bunker's lobe, a tee's rectangle — which is a worse trade
#: than leaving a little speckle for U4's simplification to absorb.
_STRUCTURING_ELEMENT_OFFSETS = tuple(
    (row, col) for row in range(3) for col in range(3)
)


@dataclass(frozen=True)
class CorridorMask:
    """One unlabeled region SAM found, on the corridor raster's own pixel grid.

    This is the contract U3 consumes. It carries geometry and confidence and
    nothing else — no feature kind, no spectral statistics — because KTD3 puts
    classification in U3, and because U3 needs the *raster* to compute spectral
    statistics anyway and can index it directly with `mask`.

    `mask` is boolean with the same (height, width) as `raster.pixels[0]`, so
    `raster.pixels[:, mask]` is the four-band sample under this region and
    `rasterio.features.shapes(..., mask=mask)` in U4 needs no translation.

    The two scores stay separate. `predicted_iou` is SAM's estimate of how well
    the mask matches the object it was trying to segment; `stability_score` is
    how little the mask changes as the mask-logit threshold moves. They mean
    different things, U3 penalises the pair rather than either one, and the
    contributor is shown a confidence derived from both — none of which survives
    collapsing them here.

    `bbox_pixels` is (row_start, row_stop, col_start, col_stop) with the stops
    exclusive, matching Python slicing and the `paint` helper the tests use,
    rather than SAM's own XYWH — one convention for pixel boxes across the
    service is worth the conversion.
    """

    mask: np.ndarray
    predicted_iou: float
    stability_score: float
    pixel_count: int
    area_sq_meters: float
    bbox_pixels: tuple[int, int, int, int]
    centroid_rowcol: tuple[float, float]


@dataclass(frozen=True)
class SegmentedCorridor:
    """Every mask found in one corridor, with the imagery they came from.

    The raster travels with the masks rather than being passed alongside them so
    that R5's provenance — the NAIP acquisition date each proposal was derived
    from — cannot be separated from the proposals it describes on the way to U3
    and U5. `model_id` is here for the same reason: when a contributor disputes a
    proposal months later, the checkpoint that produced it is part of the answer.
    """

    raster: CorridorRaster
    masks: tuple[CorridorMask, ...]
    model_id: str

    @property
    def acquired(self) -> dt.date:
        """The NAIP acquisition date behind every mask here (R5)."""
        return self.raster.acquired

    @property
    def gsd_meters(self) -> float:
        """The imagery's ground resolution, which U3 and U4 both need in metres."""
        return self.raster.gsd_meters


class MaskGenerator(Protocol):
    """The only thing this module needs from SAM.

    Deliberately one method taking one image and returning SAM's own annotation
    dictionaries — that is exactly the surface of
    `SAM2AutomaticMaskGenerator.generate`, so the real implementation is a thin
    delegate and a fake cannot drift from it. Note there is no prompt parameter,
    which is the protocol enforcing KTD2 rather than a comment asking for it.
    """

    def generate(self, image: np.ndarray, **kwargs: Any) -> Sequence[Mapping[str, Any]]:
        """Enumerate every mask in an (H, W, 3) uint8 RGB image."""
        ...


class Sam2MaskGenerator:
    """The real path: SAM 2 in automatic mode, constructed through samgeo.

    Built lazily and cached on the instance. Constructing `SamGeo2` downloads a
    multi-gigabyte checkpoint and allocates on the GPU, so it must not happen at
    import, must not happen for a request that failed validation upstream, and
    must not happen twice for a process serving many holes.
    """

    def __init__(self, model_id: str = SAM2_MODEL_ID, **sam_kwargs: Any) -> None:
        if model_id not in SAM2_ALLOWED_MODEL_IDS:
            # Raised rather than returned: this is a wiring mistake in our own
            # code, not an outcome of a request. Checked here so it surfaces at
            # construction instead of several gigabytes into a checkpoint load.
            raise ValueError(
                f"model_id must be one of {SAM2_ALLOWED_MODEL_IDS}; SamGeo2 rejects "
                f"every other id, including the whole sam2.1 line. Got {model_id!r}."
            )
        self._model_id = model_id
        self._sam_kwargs = sam_kwargs
        self._sam: Any = None

    def generate(self, image: np.ndarray, **kwargs: Any) -> Sequence[Mapping[str, Any]]:
        from samgeo import SamGeo2

        if self._sam is None:
            self._sam = SamGeo2(
                model_id=self._model_id,
                # The whole point. `automatic=False` builds an image predictor
                # that must be prompted and returns no per-mask scores.
                automatic=True,
                **self._sam_kwargs,
            )
        # `SamGeo2.generate` is annotated as returning the mask list and does
        # not: it returns `None` and stores the annotations on `self.masks`.
        # Reading the return value would silently produce zero masks for every
        # corridor, which would look exactly like featureless turf.
        self._sam.generate(image, **kwargs)
        return list(self._sam.masks or [])


def corridor_rgb(raster: CorridorRaster) -> np.ndarray:
    """The corridor's visible bands as a C-contiguous (H, W, 3) uint8 image.

    Built here rather than handed to samgeo as-is because samgeo's
    `prepare_image_for_sam` defaults to `channel_axis=-1`, and U1's array is
    (band, row, col). Passed straight through, a 4x2000x2000 corridor is read as
    a two-thousand-channel image four pixels tall — silently, with no error, and
    with masks that are garbage rather than absent.

    NIR is dropped because SAM 2 is a three-channel RGB model. It is not lost:
    NIR is the band that separates water from tree shadow and sand from turf, and
    U3 reads it from `raster.pixels` directly. The model finds the boundaries;
    the fourth band decides what is inside them.
    """
    rgb = np.moveaxis(raster.pixels[:3], 0, -1)
    return np.ascontiguousarray(rgb.astype(np.uint8, copy=False))


def _dilate(mask: np.ndarray) -> np.ndarray:
    """Binary dilation by a 3x3 square, in numpy.

    Edge-replicated padding rather than zero padding, in both this and `_erode`,
    so a feature running out of the corridor — a fairway leaving the frame — is
    not shaved along the frame edge by the cleanup. `scipy.ndimage` would do this
    in one call, but it is not a dependency of this service and adding one for
    nine array ORs would be a poor trade.
    """
    height, width = mask.shape
    padded = np.pad(mask, 1, mode="edge")
    out = np.zeros_like(mask)
    for row, col in _STRUCTURING_ELEMENT_OFFSETS:
        out |= padded[row : row + height, col : col + width]
    return out


def _erode(mask: np.ndarray) -> np.ndarray:
    """Binary erosion by a 3x3 square. See `_dilate` for the padding rationale."""
    height, width = mask.shape
    padded = np.pad(mask, 1, mode="edge")
    out = np.ones_like(mask)
    for row, col in _STRUCTURING_ELEMENT_OFFSETS:
        out &= padded[row : row + height, col : col + width]
    return out


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Open then close a boolean mask, killing speckle and filling pinholes.

    Order matters and is not symmetric. Opening first removes isolated pixels
    outright; closing first would connect them to their neighbours and make them
    permanent. Both passes leave a solid region's boundary exactly where it was,
    so this is a cleanup rather than a smoothing — the edge a contributor
    eventually confirms is the edge SAM found.
    """
    opened = _dilate(_erode(mask))
    return _erode(_dilate(opened))


def _read_annotation(
    annotation: Mapping[str, Any], shape: tuple[int, int]
) -> tuple[np.ndarray, float, float] | str:
    """Pull the mask and both scores out of one SAM annotation, or say what is wrong.

    Returns a message rather than raising because a malformed annotation is an
    upstream outcome the caller folds into `Upstream`, and because the message
    needs to name the missing key: a mask with no `predicted_iou` or
    `stability_score` almost always means the generator was built with
    `automatic=False`, and saying so beats a `KeyError` in a traceback.
    """
    segmentation = annotation.get("segmentation")
    if not isinstance(segmentation, np.ndarray):
        return (
            "a mask with no boolean 'segmentation' array; SAM 2 must run with "
            "output_mode='binary_mask' rather than an RLE mode"
        )
    if segmentation.shape != shape:
        return (
            f"a mask of shape {segmentation.shape}, which does not match the "
            f"corridor raster's {shape}"
        )

    for key in ("predicted_iou", "stability_score"):
        if annotation.get(key) is None:
            return (
                f"a mask with no '{key}'. Both scores are produced only by "
                "automatic mask generation, so the generator is prompted rather "
                "than automatic (KTD2)"
            )

    return (
        segmentation.astype(bool, copy=False),
        float(annotation["predicted_iou"]),
        float(annotation["stability_score"]),
    )


def _describe(
    mask: np.ndarray, predicted_iou: float, stability_score: float, gsd_meters: float
) -> CorridorMask:
    """Measure a cleaned mask on the raster's grid, in pixels and in metres.

    Area comes from the raster's own `gsd_meters`, never a constant: NAIP items
    are flown at 0.6 m or 1.0 m, and treating one as the other is a factor of 2.8
    in area — enough to turn every green in a corridor into an out-of-range mask
    that U3 penalises.
    """
    rows, cols = np.nonzero(mask)
    pixel_count = int(rows.size)
    return CorridorMask(
        mask=mask,
        predicted_iou=predicted_iou,
        stability_score=stability_score,
        pixel_count=pixel_count,
        area_sq_meters=pixel_count * gsd_meters * gsd_meters,
        bbox_pixels=(
            int(rows.min()),
            int(rows.max()) + 1,
            int(cols.min()),
            int(cols.max()) + 1,
        ),
        centroid_rowcol=(float(rows.mean()), float(cols.mean())),
    )


def segment_corridor(
    raster: CorridorRaster,
    *,
    mask_generator: MaskGenerator | None = None,
    model_id: str = SAM2_MODEL_ID,
) -> Result[SegmentedCorridor]:
    """Enumerate every mask in the corridor, unlabeled, with confidence scores.

    Takes no playing line, on purpose: see the module docstring. The generator is
    injected so this whole function runs offline under test with neither `torch`
    nor `segment-geospatial` installed; the default is the real SAM 2 path.

    Returns `Ok(SegmentedCorridor)` when at least one mask survives cleanup,
    `NoCoverage` when none does — a featureless corridor is a legitimately empty
    answer that U5 reports with its own status — or `Upstream` when the model
    raises or returns annotations that are not automatic-mode output.
    """
    if mask_generator is None:
        mask_generator = Sam2MaskGenerator(model_id=model_id)

    image = corridor_rgb(raster)
    shape = image.shape[:2]

    try:
        annotations = list(mask_generator.generate(image))
    except Exception as error:  # noqa: BLE001 - any model failure is one outcome
        return Upstream(
            "Could not segment the corridor imagery with SAM 2.",
            source="sam2",
            cause=str(error),
        )

    # Where NAIP does not cover, U1's boundless read left zeros in all four
    # bands. Computed from all four rather than from the RGB image alone, so a
    # genuinely black-in-visible feature with any NIR return is still real data.
    covered = raster.pixels.any(axis=0)
    covered_count = int(covered.sum())
    if covered_count == 0:
        return NoCoverage(
            "The NAIP imagery for this corridor is entirely uncovered pixels.",
            detail={"item_id": raster.item_id},
        )

    minimum_pixels = MIN_MASK_AREA_SQ_METERS / (raster.gsd_meters * raster.gsd_meters)
    kept: list[CorridorMask] = []

    for annotation in annotations:
        read = _read_annotation(annotation, shape)
        if isinstance(read, str):
            return Upstream(
                f"SAM 2 returned {read}.",
                source="sam2",
                cause=f"model_id={model_id}",
            )
        raw_mask, predicted_iou, stability_score = read

        mask = clean_mask(raw_mask)
        pixel_count = int(mask.sum())
        if pixel_count < minimum_pixels:
            continue
        if pixel_count > covered_count * MAX_CORRIDOR_COVERAGE_FRACTION:
            continue
        if int((mask & ~covered).sum()) > pixel_count * MAX_NODATA_FRACTION:
            continue

        kept.append(_describe(mask, predicted_iou, stability_score, raster.gsd_meters))

    if not kept:
        return NoCoverage(
            "SAM 2 found no distinct features in this corridor. The imagery may be "
            "featureless, obscured, or too coarse to separate them.",
            detail={
                "item_id": raster.item_id,
                "acquired": raster.acquired.isoformat(),
                "masks_before_filtering": len(annotations),
            },
        )

    # Largest first, with the centroid breaking ties, so two runs over one
    # corridor propose in the same order and a contributor re-reviewing a hole
    # sees the same sequence. SAM's own ordering is not specified.
    kept.sort(key=lambda m: (-m.pixel_count, m.centroid_rowcol))

    return Ok(SegmentedCorridor(raster=raster, masks=tuple(kept), model_id=model_id))
