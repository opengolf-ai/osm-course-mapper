"""Turn SAM's unlabeled masks into typed golf features, from spectra and position.

This is KTD3, and it is the cheapest high-leverage part of the system. U2 refused
to prompt the model with the drawn line, so the model returned regions with no
idea what any of them are. Everything that makes those regions *mean* something
happens here, out of two signals and nothing else:

1. **The spectrum, from NAIP's four bands.** Sand, water and turf separate cleanly
   in R/G/B/NIR without any classifier: sand is bright across the visible bands
   and barely vegetated; water absorbs near-infrared almost completely; turf
   reflects it strongly. Three rules, no training set, no labeled golf imagery
   that does not exist.
2. **The line the contributor drew, tee to green.** Green and tee boxes are the
   same grass, mown to different heights, and no combination of four 8-bit bands
   at 0.6 m separates them. What separates them is *where they are*: the green is
   at the line's terminal end, the tees at its initial end, and each tee set's
   card yardage says how far back from the green its tee should sit. This is the
   line earning its keep after U2 declined to use it as a prompt.

**Order matters, and it is spectrum first.** A greenside bunker sits at the
terminal point too, and a positional rule applied first would propose it as the
green with a model's confidence behind it. So every mask is given a *material*
first — turf, sand, water, or nothing we recognise — and the positional prior then
only chooses among the turf.

**Why a reversed line is refused rather than classified.** The positional prior
assumes tee-to-green ordering and has no way to notice on its own that it has been
handed the reverse: it would label the tee complex as the green, label the green
as a tee, attach a scorecard tee set to it, and present all of it as a confident
proposal. That is the most convincing wrong answer this system can produce, and it
would teach a contributor to distrust every proposal that follows. `_reversal`
below therefore looks for the one layout signature that is legible without knowing
the direction — several tee-sized turf masks clustered at one end, one larger turf
mask at the other — and returns `Invalid` when it points the wrong way.

**Area is a penalty, never a filter.** The green and bunker size ranges below come
from measured course geometry, and measured course geometry is wide: greens at the
Old Course average around 2,069 m2, and documented bunkers run from a few square
metres to well over a thousand. A mask outside the range is more likely a green
merged with its collar than a mistake, so it reaches the contributor as a
low-confidence proposal that one drag fixes, rather than as nothing at all.

**Fairway is the weak class, stated plainly.** Fairway and rough are the same
grass; at 0.6 m the only cue is the mowing pattern, and whether SAM cut a boundary
along it is luck. The fairway proposal is therefore a best-effort pick — the
largest elongated turf mask left over — and its confidence is capped below what
the model's own scores would give it. Nothing here pretends otherwise.

**Honesty about the thresholds.** The spectral cut points are *uncalibrated
starting values*. They are reasoned from how NAIP's bands behave over sand, water
and vegetation, not measured against labeled golf imagery, because no such imagery
exists for this project yet. Every one of them is a field on `SpectralThresholds`
rather than a module constant, so calibrating them later is a call-site change and
so a caller can disagree with any of them without editing this file.

**Scope boundary.** Water is classified as *water*. Whether that water is a
*hazard* is a golf judgment — whether a ball can find it — that R14 reserves for
the contributor and a later unit's review step. Nothing here marks a hazard, and
nothing here filters water by a guess about playability.
"""

from __future__ import annotations

import datetime as dt
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point

from service.naip import WGS84, CorridorRaster
from service.results import Invalid, NoCoverage, Ok, Result
from service.segment import CorridorMask, SegmentedCorridor

#: Card yardages are yards; every measurement in this module is metres. Stated
#: once, converted once.
METERS_PER_YARD = 0.9144


class FeatureKind(StrEnum):
    """What a mask is proposed as.

    Exactly the five kinds R4 names, plus `UNKNOWN` for a mask that matched no
    rule. `UNKNOWN` is deliberately not one of the five: it never reaches the
    review sequence as a proposal, it is carried separately so that "we proposed
    three features" stays distinguishable from "we understood three of six
    masks".

    `WATER`, not `WATER_HAZARD`. R14 reserves the in-play judgment for the
    contributor, and a kind that asserted it here would decide it silently.

    A `StrEnum` so U5 serializes `kind` straight to JSON with no mapping table.
    """

    GREEN = "green"
    TEE = "tee"
    BUNKER = "bunker"
    WATER = "water"
    FAIRWAY = "fairway"
    UNKNOWN = "unknown"


#: The kinds that are proposals. Anything else is carried on `unclassified`.
PROPOSED_KINDS = (
    FeatureKind.GREEN,
    FeatureKind.TEE,
    FeatureKind.BUNKER,
    FeatureKind.WATER,
    FeatureKind.FAIRWAY,
)


@dataclass(frozen=True)
class TeeSet:
    """One tee set from the hole's scorecard: a name and how far it plays.

    **This is the scorecard input this unit needs, and it is more than a single
    card yardage.** Matching four tee masks to four tee sets requires four
    yardages; one number can only ever place one tee. `name` is what the review
    step shows ("Blue", "Championship") and `key` is the course record's own
    identifier (`tee_key` / colour), carried through opaquely so the client can
    reconcile an assignment with the tee set it already knows about.

    `yards` because that is the unit every US scorecard and the client's course
    record are already in; converting at the boundary would mean two
    representations of the same fact in flight.
    """

    name: str
    yards: float
    key: str | None = None


@dataclass(frozen=True)
class SpectralStats:
    """What one mask looks like across NAIP's four bands.

    All three are **medians**, not means. A green with a rake mark across it, a
    bunker with a footprint, a pond with a reflected cloud — each puts a minority
    of wildly different pixels inside an otherwise uniform mask, and a mean moves
    with them while a median does not.

    `ndvi` is the per-pixel normalized difference of NIR against red, then the
    median of that, rather than the NDVI of the median bands: the two differ
    whenever a mask is mixed, and the per-pixel form is the one that means "most
    of this region is vegetated".

    `brightness` is the mean of the three visible bands per pixel, 0-255. Kept in
    the raster's own 8-bit scale rather than normalized, because that is the scale
    the thresholds are reasoned in and a normalized copy would invite someone to
    compare a 0-1 threshold against a 0-255 value.

    `sample_pixels` counts only pixels with imagery behind them: U1 reads
    boundless, so a corridor at a NAIP quad edge is padded with zeros, and zeros
    look exactly like deep water in every band.
    """

    ndvi: float
    brightness: float
    nir: float
    sample_pixels: int


@dataclass(frozen=True)
class SpectralThresholds:
    """The cut points separating turf, sand and water. **Uncalibrated.**

    These are reasoned starting values, not measurements. Nobody on this project
    has yet sampled NDVI over a known bunker in a known NAIP flight; what follows
    is derived from how the four bands behave physically, and each is stated with
    its reasoning so a later calibration knows what it is overturning.

    * `turf_min_ndvi = 0.25` — dense irrigated turf reads 0.5-0.8 in NAIP. The
      floor is set far below that on purpose: dormant, drought-stressed or
      recently top-dressed turf drops sharply, and a mask that fails this test
      does not become a different feature, it becomes nothing at all. Erring
      permissive costs a contributor one rejection; erring strict costs them the
      green.
    * `bunker_max_ndvi = 0.15` — dry sand reflects red and near-infrared at
      similar levels, so its NDVI sits near zero. The headroom is for the weeds
      and the grass lip that any real bunker mask includes at its edge.
    * `bunker_min_brightness = 145` — sand is the brightest thing on a golf hole
      in the visible bands, typically 170-230 of 255, while turf sits near 60-90.
      145 is placed in the wide gap between them rather than close to either.
    * `water_max_nir = 60` — this is the discriminating one. Water absorbs
      near-infrared nearly completely and reads very low, often under 40; turf
      reflects it strongly even in deep shade. The margin above 40 is for turbid
      or shallow water over a bright bottom.
    * `water_max_brightness = 90` — required *in addition* to low NIR, which is
      what stops asphalt and dark bare soil from classifying as ponds. Low NIR
      alone is not enough, and low brightness alone is much worse: shaded turf is
      dark in the visible bands and would flood a tree-lined hole with proposed
      water.
    """

    turf_min_ndvi: float = 0.25
    bunker_max_ndvi: float = 0.15
    bunker_min_brightness: float = 145.0
    water_max_nir: float = 60.0
    water_max_brightness: float = 90.0


@dataclass(frozen=True)
class AreaRanges:
    """Plausible ground area per feature kind, in square metres.

    From measured course geometry rather than intuition, and deliberately wide.
    Greens at the Old Course average around 2,069 m2 while a small modern green
    runs a few hundred; documented bunkers span from a few square metres to well
    over a thousand. Narrower bounds would discard correct features, and since
    these drive a confidence *penalty* rather than a filter, wide bounds cost only
    a missed warning while narrow ones cost a proposal.

    Only the two kinds the plan gives numbers for are listed. Tees, water and
    fairway have no stated range and get no area penalty, because inventing one
    would be a guess presented as a measurement.
    """

    green_min: float = 250.0
    green_max: float = 2_500.0
    bunker_min: float = 40.0
    bunker_max: float = 1_900.0


@dataclass(frozen=True)
class LayoutRules:
    """The geometric rules turning position along the line into a role.

    Distances in metres, all measured on the raster's own projected CRS.

    * `green_search_radius = 50` — how far the green's mask may sit from the
      line's terminal vertex when it does not contain it outright. A contributor
      aims at the middle of the green but stops the line early or wide, and the
      corridor is only 60 m to either side, so a radius near that is generous
      without being able to reach the next hole.
    * `tee_zone_meters = 120` — the fallback depth of the tee complex when no
      scorecard is supplied. Forward tees on a long hole sit a hundred metres up
      the line from the back tee the contributor started at. When tee sets *are*
      supplied the zone extends to cover the shortest of them instead, which is
      the scorecard sizing its own search window.
    * `tee_min_area = 30`, `tee_max_area = 2000` — a forward tee is perhaps
      8 x 6 m and a championship tee perhaps 50 x 25 m. The ceiling is what stops
      the start of the fairway, or the rough surrounding the complex, from being
      proposed as a tee box. This gates a *role*, not a kind: a turf mask that
      fails it is still turf, it just is not a tee.
    * `tee_match_tolerance = 40` — how far a tee mask may sit from where its card
      yardage puts it. Card yardage is measured from the tee markers to the centre
      of the green along the intended line of play; the contributor's drawn line
      approximates that line and its terminal vertex approximates that centre, so
      errors of 10-25 m are routine on a correctly drawn hole. Uncalibrated, like
      the spectral thresholds.
    * `fairway_min_elongation = 1.8` — measured along the tee-to-green axis
      against the perpendicular spread, so it does not depend on the hole's
      compass bearing. A fairway is a long strip; a patch of rough is not.
    * `fairway_min_area = 500` — a fairway 25 m wide over 100 m of corridor is
      2,500 m2. Below 500 m2, nothing that reaches a contributor labelled "the
      fairway" is credible.
    * `reversal_min_tee_masks = 2` — see `_reversal`. A tee *complex* is several
      boxes; one box is not evidence of anything.
    """

    green_search_radius_meters: float = 50.0
    tee_zone_meters: float = 120.0
    tee_min_area_sq_meters: float = 30.0
    tee_max_area_sq_meters: float = 2_000.0
    tee_match_tolerance_meters: float = 40.0
    fairway_min_elongation: float = 1.8
    fairway_min_area_sq_meters: float = 500.0
    reversal_min_tee_masks: int = 2


#: How far confidence may fall from an out-of-range area. A floor rather than an
#: unbounded decay, because the whole point of penalising instead of dropping is
#: that the proposal still reaches the contributor — and a proposal shown at
#: near-zero confidence is one a reviewer skips, which is a drop with extra steps.
AREA_PENALTY_FLOOR = 0.35

#: Fairway proposals are capped here regardless of what SAM thought of the mask.
#: Fairway and rough are the same grass and the mowing pattern is the only cue at
#: 0.6 m, so a high model score means the mask has a crisp boundary, not that the
#: boundary is the fairway's. See the module docstring.
FAIRWAY_CONFIDENCE_CEILING = 0.5

#: An extra fairway penalty on a par 3. Par 3 holes are commonly mapped tee to
#: green with no separately mown fairway, so a fairway-shaped turf mask on one
#: deserves more suspicion — but not suppression, since long par 3s do have them.
#: This is R6's "par shapes expectation" and it is the only place par is used.
PAR3_FAIRWAY_PENALTY = 0.6


@dataclass(frozen=True)
class ClassifiedFeature:
    """One proposal: a mask, what we think it is, and how much we believe it.

    This is the contract U4 vectorizes and U5 serializes.

    `mask` is U2's value verbatim, which is what keeps the raw `predicted_iou` and
    `stability_score` recoverable. `confidence` is the number a contributor sees;
    `model_confidence`, `area_penalty` and `kind_penalty` are its three factors,
    carried separately so the displayed number can be explained rather than just
    asserted. Their product *is* `confidence` — a caller can check the arithmetic.

    `tee_set` is set only on `TEE` features and only when a scorecard set matched.
    `None` on a tee means "we found a tee box and cannot say which set it is",
    which the review step shows as an unassigned slot for the contributor to name.

    `notes` are short human-readable reasons for anything unusual — an area
    outside its range, a capped fairway. They exist so the reason a proposal is
    low-confidence travels with it instead of living only in this module.
    """

    mask: CorridorMask
    kind: FeatureKind
    confidence: float
    model_confidence: float
    area_penalty: float
    kind_penalty: float
    spectral: SpectralStats
    distance_along_line_meters: float
    tee_set: TeeSet | None = None
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClassifiedCorridor:
    """Every proposal for one hole, with the imagery and the model behind them.

    `features` are the proposals; `unclassified` holds masks that matched no rule,
    kept apart so U4 does not vectorize them and U5 can still count them.
    `missing_tee_sets` are scorecard tee sets no mask matched — surfaced rather
    than dropped, because "we could not find your white tee" is exactly the prompt
    that gets a contributor to draw it.

    Provenance is reachable from here without going back to U2 (R5).
    """

    corridor: SegmentedCorridor
    features: tuple[ClassifiedFeature, ...]
    unclassified: tuple[ClassifiedFeature, ...] = ()
    missing_tee_sets: tuple[TeeSet, ...] = ()
    line_length_meters: float = 0.0
    thresholds: SpectralThresholds = field(default_factory=SpectralThresholds)

    @property
    def all_features(self) -> tuple[ClassifiedFeature, ...]:
        """Proposals and unrecognised masks together, for counting and debugging."""
        return self.features + self.unclassified

    def of_kind(self, kind: FeatureKind) -> tuple[ClassifiedFeature, ...]:
        """Every proposal of one kind, in proposal order."""
        return tuple(f for f in self.features if f.kind is kind)

    @property
    def acquired(self) -> dt.date:
        """The NAIP acquisition date behind every proposal here (R5)."""
        return self.corridor.acquired

    @property
    def gsd_meters(self) -> float:
        return self.corridor.gsd_meters

    @property
    def model_id(self) -> str:
        return self.corridor.model_id

    @property
    def source(self) -> str:
        return self.corridor.raster.source


DEFAULT_THRESHOLDS = SpectralThresholds()
DEFAULT_AREA_RANGES = AreaRanges()
DEFAULT_LAYOUT = LayoutRules()


@dataclass
class _Region:
    """Working state for one mask while it is being classified.

    Mutable and private, unlike everything this module returns: the kind and the
    tee assignment are decided in several passes (material, then green, then tees,
    then fairway), and threading an immutable value through four passes would be
    ceremony with no reader benefit.
    """

    mask: CorridorMask
    spectral: SpectralStats
    along_meters: float
    distance_to_initial: float
    distance_to_terminal: float
    contains_terminal: bool
    elongation: float
    kind: FeatureKind | str
    tee_set: TeeSet | None = None
    notes: list[str] = field(default_factory=list)


# `_Region.kind` holds a *material* between the spectral pass and the positional
# pass: turf masks are parked under this sentinel until the line decides whether
# each is a green, a tee, a fairway, or none of those. Kept out of `FeatureKind`
# because it is never a proposal and must never be serialized — and safe to
# compare against a `FeatureKind` with `==` precisely because no member has this
# value.
_TURF = "turf"


def _apply(transform, rows: np.ndarray, cols: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pixel centres to projected coordinates, vectorized.

    Written out rather than calling `rasterio.transform.xy`, which builds Python
    lists element by element — a fairway mask is tens of thousands of pixels and
    this runs once per mask.
    """
    x = transform.c + transform.a * (cols + 0.5) + transform.b * (rows + 0.5)
    y = transform.f + transform.d * (cols + 0.5) + transform.e * (rows + 0.5)
    return x, y


def _spectral_stats(raster: CorridorRaster, mask: np.ndarray) -> SpectralStats:
    """Median NDVI, visible brightness and NIR level under one mask.

    Restricted to pixels that carry imagery. U1's boundless read leaves all-zero
    pixels where NAIP does not cover, and those would read as NDVI 0, brightness 0
    and NIR 0 — a perfect pond. U2 already discards masks that are *mostly*
    nodata; this removes the minority that survives on a mask straddling the edge.
    """
    covered = raster.pixels.any(axis=0)
    sample = raster.pixels[:, mask & covered]
    if sample.shape[1] == 0:
        return SpectralStats(ndvi=0.0, brightness=0.0, nir=0.0, sample_pixels=0)

    values = sample.astype(np.float32)
    red, nir = values[0], values[3]
    # Denominator floored at 1 rather than guarded by a mask: red and NIR are
    # non-negative uint8, so the sum is only zero on a pixel that is zero in both,
    # whose NDVI is undefined and whose numerator is zero anyway.
    ndvi = (nir - red) / np.maximum(nir + red, 1.0)
    return SpectralStats(
        ndvi=float(np.median(ndvi)),
        brightness=float(np.median(values[:3].mean(axis=0))),
        nir=float(np.median(nir)),
        sample_pixels=int(sample.shape[1]),
    )


def _material(stats: SpectralStats, thresholds: SpectralThresholds) -> FeatureKind | str:
    """What a mask is made of, before the line has any say.

    Water is tested first because low NIR is very nearly unique to it, and a pond
    with a bright turbid edge could otherwise trip the bunker rule. Sand second.
    Turf last, as the broadest test.

    Returns `_TURF` for vegetation — the material, not a feature — because which
    turf feature a mask is depends entirely on where it sits along the line.
    """
    if (
        stats.nir <= thresholds.water_max_nir
        and stats.brightness <= thresholds.water_max_brightness
    ):
        return FeatureKind.WATER
    if (
        stats.brightness >= thresholds.bunker_min_brightness
        and stats.ndvi <= thresholds.bunker_max_ndvi
    ):
        return FeatureKind.BUNKER
    if stats.ndvi >= thresholds.turf_min_ndvi:
        return _TURF
    return FeatureKind.UNKNOWN


def _elongation(
    xs: np.ndarray, ys: np.ndarray, origin: tuple[float, float], axis: tuple[float, float]
) -> float:
    """How much longer a mask is along the tee-to-green axis than across it.

    Measured against the hole's own axis rather than the pixel grid, so a fairway
    running diagonally across the raster is as elongated as one running along a
    row — a bounding-box aspect ratio would call the diagonal one square.
    """
    dx = xs - origin[0]
    dy = ys - origin[1]
    along = dx * axis[0] + dy * axis[1]
    across = -dx * axis[1] + dy * axis[0]
    along_extent = float(along.max() - along.min())
    across_extent = float(across.max() - across.min())
    if across_extent <= 0.0:
        return math.inf
    return along_extent / across_extent


def _region(
    mask: CorridorMask,
    raster: CorridorRaster,
    line: LineString,
    initial: Point,
    terminal: Point,
    axis: tuple[float, float],
    thresholds: SpectralThresholds,
) -> _Region:
    """Measure one mask against the imagery and the line, once.

    Endpoint distances are to the mask's *nearest pixel*, not its centroid. A
    fairway's centroid can be two hundred metres from the green while the mask
    itself runs right up to it, and "is this mask at the end of the line" is a
    question about the mask, not about its middle.
    """
    rows, cols = np.nonzero(mask.mask)
    xs, ys = _apply(raster.transform, rows, cols)
    centroid_x, centroid_y = _apply(
        raster.transform,
        np.array([mask.centroid_rowcol[0]]),
        np.array([mask.centroid_rowcol[1]]),
    )
    centroid = (float(centroid_x[0]), float(centroid_y[0]))

    terminal_row, terminal_col = _rowcol(raster, terminal)
    contains_terminal = (
        0 <= terminal_row < mask.mask.shape[0]
        and 0 <= terminal_col < mask.mask.shape[1]
        and bool(mask.mask[terminal_row, terminal_col])
    )

    stats = _spectral_stats(raster, mask.mask)
    return _Region(
        mask=mask,
        spectral=stats,
        along_meters=float(line.project(Point(centroid))),
        distance_to_initial=float(np.min(np.hypot(xs - initial.x, ys - initial.y))),
        distance_to_terminal=float(np.min(np.hypot(xs - terminal.x, ys - terminal.y))),
        contains_terminal=contains_terminal,
        elongation=_elongation(xs, ys, (initial.x, initial.y), axis),
        kind=_material(stats, thresholds),  # type: ignore[arg-type]
    )


def _rowcol(raster: CorridorRaster, point: Point) -> tuple[int, int]:
    """The pixel a projected point falls in, flooring rather than rounding.

    Flooring is what makes the result the pixel that *contains* the point, which
    is the question a containment test is asking.
    """
    inverse = ~raster.transform
    col, row = inverse * (point.x, point.y)
    return int(math.floor(row)), int(math.floor(col))


def _reversal(
    regions: Sequence[_Region], layout: LayoutRules, ranges: AreaRanges
) -> dict[str, float] | None:
    """Evidence that the line was drawn green-to-tee. `None` means it was not.

    The signature that reads the same regardless of which way the line points is
    the *shape of each end*: a tee complex is several tee-sized turf masks
    clustered together, and a green is one larger turf mask on its own. So the
    line is reversed when all four of these hold at once:

    1. the terminal end holds at least `reversal_min_tee_masks` tee-sized turf
       masks — a complex, not a box;
    2. the initial end holds at most one — it does not look like a complex;
    3. the initial end holds a green-*plausible* turf mask, meaning one whose area
       falls inside the measured green range;
    4. and it is larger than any green-plausible turf mask at the terminal end,
       which on a genuinely reversed line there will not be one of.

    Conditions 3 and 4 are stated against the green range rather than against the
    largest turf mask at each end, and that distinction is load-bearing: the
    fairway reaches into the tee complex on most holes and is by far the largest
    turf mask near the initial point, so "largest turf" would call every correctly
    drawn hole reversed.

    The conjunction is deliberately conservative, and the asymmetry is the point:
    a false rejection blocks a contributor who did nothing wrong and has no
    recourse, while a missed reversal is caught by the very next question the
    review step asks ("is that the green?"). An ambiguous corridor — a green SAM
    split in two, a hole with one visible tee — fails one of the four and is
    accepted.
    """
    turf = [r for r in regions if r.kind == _TURF]
    if not turf:
        return None

    # Half the tee-zone depth: a mask further than that from an endpoint is not at
    # that end of the hole in any useful sense, and widening it would start
    # pulling the fairway into both groups at once.
    reach = layout.tee_zone_meters / 2
    at_initial = [r for r in turf if r.distance_to_initial <= reach]
    at_terminal = [r for r in turf if r.distance_to_terminal <= reach]

    def tee_like(group: Sequence[_Region]) -> int:
        return sum(
            1
            for r in group
            if layout.tee_min_area_sq_meters
            <= r.mask.area_sq_meters
            <= layout.tee_max_area_sq_meters
        )

    def largest_green_like(group: Sequence[_Region]) -> float:
        return max(
            (
                r.mask.area_sq_meters
                for r in group
                if ranges.green_min <= r.mask.area_sq_meters <= ranges.green_max
            ),
            default=0.0,
        )

    terminal_tees = tee_like(at_terminal)
    initial_tees = tee_like(at_initial)
    green_at_initial = largest_green_like(at_initial)
    green_at_terminal = largest_green_like(at_terminal)

    if (
        terminal_tees >= layout.reversal_min_tee_masks
        and initial_tees <= 1
        and green_at_initial > 0.0
        and green_at_initial > green_at_terminal
    ):
        return {
            "tee_like_masks_at_terminal_point": terminal_tees,
            "tee_like_masks_at_initial_point": initial_tees,
            "green_sized_turf_at_initial_point_sq_meters": green_at_initial,
            "green_sized_turf_at_terminal_point_sq_meters": green_at_terminal,
        }
    return None


def _assign_green(regions: Sequence[_Region], layout: LayoutRules) -> _Region | None:
    """The one turf mask the line ends in, or nearest to where it ends.

    Exactly one, because the review step asks about one shape. SAM routinely
    splits a green from its apron or its collar, so several turf masks can sit at
    the terminal end; containment wins over proximity, because the contributor
    drew the line *to the green* and its last vertex is the strongest statement
    they made about which shape that is.
    """
    candidates = [
        r
        for r in regions
        if r.kind == _TURF
        and (r.contains_terminal or r.distance_to_terminal <= layout.green_search_radius_meters)
    ]
    if not candidates:
        return None
    # Deterministic all the way down: containment, then distance, then the mask's
    # own pixel box, so two runs over one corridor pick the same green.
    candidates.sort(
        key=lambda r: (not r.contains_terminal, r.distance_to_terminal, r.mask.bbox_pixels)
    )
    green = candidates[0]
    green.kind = FeatureKind.GREEN
    return green


def _tee_zone_end(
    tee_sets: Sequence[TeeSet], line_length: float, layout: LayoutRules
) -> float:
    """How far up the line to look for tee boxes.

    When a scorecard is supplied it sizes its own window: the shortest tee set
    plays from the furthest point up the line, so the zone reaches that point plus
    the matching tolerance. Without a scorecard there is nothing to size it with
    and the fallback applies. The maximum of the two, never the minimum — a
    scorecard should only ever widen the search.
    """
    if not tee_sets:
        return layout.tee_zone_meters
    furthest_up = max(
        line_length - tee.yards * METERS_PER_YARD for tee in tee_sets
    )
    return max(layout.tee_zone_meters, furthest_up + layout.tee_match_tolerance_meters)


def _assign_tees(
    regions: Sequence[_Region],
    tee_sets: Sequence[TeeSet],
    line_length: float,
    layout: LayoutRules,
) -> list[_Region]:
    """Every remaining turf mask in the tee zone that is tee-sized.

    Size is a role gate rather than a kind filter: a turf mask too large to be a
    tee box is still turf, and goes on to be considered for the fairway. Without
    the ceiling the start of the fairway — which begins in the tee zone on most
    holes — would be proposed as a tee.
    """
    zone_end = _tee_zone_end(tee_sets, line_length, layout)
    tees = [
        r
        for r in regions
        if r.kind == _TURF
        and -layout.tee_match_tolerance_meters <= r.along_meters <= zone_end
        and layout.tee_min_area_sq_meters
        <= r.mask.area_sq_meters
        <= layout.tee_max_area_sq_meters
    ]
    for tee in tees:
        tee.kind = FeatureKind.TEE
    return tees


def _match_tee_sets(
    tees: Sequence[_Region],
    tee_sets: Sequence[TeeSet],
    line_length: float,
    layout: LayoutRules,
) -> tuple[TeeSet, ...]:
    """Pair tee masks with scorecard sets by distance along the line.

    A set's card yardage is measured from its markers to the green, so its tee
    belongs `yardage` back from the line's terminal end — that is, at
    `line length - yardage` along the line. The cost of a pairing is how far the
    mask actually sits from that point.

    Cheapest pair first, each mask and each set used once, nothing paired beyond
    the tolerance. Optimal assignment would be the textbook answer, but there are
    at most a handful of tees on either side and greedy differs from optimal only
    when two pairings are within a few metres of each other — in which case the
    card cannot distinguish them anyway. What matters far more is what greedy
    guarantees: **no mask takes a set that fits another mask better, and no set is
    assigned twice.** The client's tee slots are fixed at four, so a mask left over
    stays a tee with no assignment rather than overflowing into a slot that does
    not exist, and a set left over is reported as possibly missing.

    Returns the unmatched sets.
    """
    if not tee_sets or not tees:
        return tuple(tee_sets)

    pairs: list[tuple[float, int, int]] = []
    for mask_index, tee in enumerate(tees):
        for set_index, tee_set in enumerate(tee_sets):
            expected = line_length - tee_set.yards * METERS_PER_YARD
            cost = abs(tee.along_meters - expected)
            if cost <= layout.tee_match_tolerance_meters:
                pairs.append((cost, mask_index, set_index))
    # Ties broken by index in both directions, so the result does not depend on
    # dictionary or sort stability details.
    pairs.sort()

    used_masks: set[int] = set()
    used_sets: set[int] = set()
    for cost, mask_index, set_index in pairs:
        if mask_index in used_masks or set_index in used_sets:
            continue
        used_masks.add(mask_index)
        used_sets.add(set_index)
        tees[mask_index].tee_set = tee_sets[set_index]

    for tee in tees:
        if tee.tee_set is None:
            tee.notes.append(
                "No scorecard tee set matched this tee box by distance along the line."
            )
    return tuple(t for index, t in enumerate(tee_sets) if index not in used_sets)


def _assign_fairway(
    regions: Sequence[_Region], layout: LayoutRules, par: int | None
) -> _Region | None:
    """The largest elongated turf mask left over, and the weakest call here.

    Fairway and rough are the same grass. At 0.6 m the only cue is the mowing
    pattern, and whether SAM cut a boundary along it rather than along a shadow or
    a sprinkler line is not something this unit can check. So this is explicitly a
    best-effort pick, and its confidence is capped in `_confidence` regardless of
    what the model's scores say — a crisp boundary is evidence the mask is a
    *shape*, not evidence it is the fairway.
    """
    candidates = [
        r
        for r in regions
        if r.kind == _TURF
        and r.elongation >= layout.fairway_min_elongation
        and r.mask.area_sq_meters >= layout.fairway_min_area_sq_meters
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda r: (-r.mask.area_sq_meters, r.mask.bbox_pixels))
    fairway = candidates[0]
    fairway.kind = FeatureKind.FAIRWAY
    fairway.notes.append(
        "Fairway is the weakest classification here: fairway and rough are the same "
        "turf and only the mowing pattern separates them at this resolution."
    )
    if par == 3:
        fairway.notes.append(
            "Par 3: many par 3 holes have no separately mown fairway at all."
        )
    return fairway


def _area_penalty(region: _Region, ranges: AreaRanges) -> float:
    """How far outside its plausible size a mask is, as a confidence multiplier.

    1.0 inside the range. Outside it, the multiplier is the inverse of the ratio
    by which the range was missed — a green at twice the maximum halves its
    confidence — floored so the proposal stays visible. Never zero and never a
    drop: an oversized green is usually a green merged with its collar, which the
    contributor fixes with one drag but cannot fix at all if it never arrives.

    Only green and bunker have measured ranges. Every other kind returns 1.0
    rather than being penalised against a number nobody has measured.
    """
    area = region.mask.area_sq_meters
    if region.kind is FeatureKind.GREEN:
        low, high = ranges.green_min, ranges.green_max
    elif region.kind is FeatureKind.BUNKER:
        low, high = ranges.bunker_min, ranges.bunker_max
    else:
        return 1.0

    if low <= area <= high:
        return 1.0
    excess = area / high if area > high else low / max(area, 1e-6)
    region.notes.append(
        f"Area {area:.0f} m2 is outside the {low:.0f}-{high:.0f} m2 range typical of a "
        f"{region.kind.value}; proposed with reduced confidence rather than withheld."
    )
    return max(AREA_PENALTY_FLOOR, 1.0 / excess)


def _model_confidence(mask: CorridorMask) -> float:
    """SAM's two scores as one number, without losing either.

    Geometric mean rather than arithmetic: they measure different things — how
    well the mask matches the object, and how little it moves as the threshold
    moves — and a mask that is strong on one and weak on the other is not a
    confident mask. The geometric mean says that; the average does not. Both
    inputs remain on `ClassifiedFeature.mask` for anyone who needs them apart.
    """
    return math.sqrt(max(mask.predicted_iou, 0.0) * max(mask.stability_score, 0.0))


def _kind_penalty(region: _Region, par: int | None) -> float:
    """A ceiling for kinds we are structurally less sure about.

    Only the fairway has one today, for the reason `_assign_fairway` states. Par 3
    tightens it further, which is the whole of R6's "par shapes expectation" — par
    changes no boundary and no label, only how much the fairway proposal is
    believed.
    """
    if region.kind is not FeatureKind.FAIRWAY:
        return 1.0
    penalty = FAIRWAY_CONFIDENCE_CEILING
    if par == 3:
        penalty *= PAR3_FAIRWAY_PENALTY
    return penalty


def _finish(region: _Region, ranges: AreaRanges, par: int | None) -> ClassifiedFeature:
    """Freeze one region into the value U4 and U5 consume."""
    model = _model_confidence(region.mask)
    area = _area_penalty(region, ranges)
    kind = _kind_penalty(region, par)
    return ClassifiedFeature(
        mask=region.mask,
        kind=region.kind if isinstance(region.kind, FeatureKind) else FeatureKind.UNKNOWN,
        confidence=min(max(model * area * kind, 0.0), 1.0),
        model_confidence=model,
        area_penalty=area,
        kind_penalty=kind,
        spectral=region.spectral,
        distance_along_line_meters=region.along_meters,
        tee_set=region.tee_set,
        notes=tuple(region.notes),
    )


def classify_corridor(
    segmented: SegmentedCorridor,
    line: Sequence[tuple[float, float]],
    *,
    tee_sets: Sequence[TeeSet] = (),
    par: int | None = None,
    thresholds: SpectralThresholds = DEFAULT_THRESHOLDS,
    area_ranges: AreaRanges = DEFAULT_AREA_RANGES,
    layout: LayoutRules = DEFAULT_LAYOUT,
) -> Result[ClassifiedCorridor]:
    """Label U2's masks as golf features, from their spectra and the drawn line.

    `line` is the WGS84 playing line the contributor drew, **tee to green** — the
    same line U1 buffered into the corridor. It is passed explicitly rather than
    read off `raster.corridor`, which keeps only the buffered polygon and has no
    way to say which end is which.

    `tee_sets` is the hole's scorecard rows: a name and a yardage per set. One
    yardage cannot place four tees, so this is a sequence and not a number — see
    `TeeSet`. Omitting it costs only the tee assignments; every other
    classification is unaffected.

    `par` is optional and used in exactly one place, to lower confidence in a
    fairway proposal on a par 3. It changes no label and no boundary.

    Returns `Ok(ClassifiedCorridor)` when at least one mask became a proposal,
    `Invalid` when the line is unusable — too few points, zero length, or drawn
    green-to-tee — or `NoCoverage` when masks were found but none of them matched
    any rule, which is a legitimately empty answer rather than a failure.
    """
    coordinates = [(float(lon), float(lat)) for lon, lat in line]
    if len(coordinates) < 2:
        return Invalid(
            "A playing line needs at least two points before its endpoints can say "
            "which mask is the green and which are tees.",
            field_name="line",
            detail={"vertices": len(coordinates)},
        )

    raster = segmented.raster
    # Into the *item's* CRS, not the corridor's computed UTM zone. Planetary
    # Computer serves NAIP in NAD83 UTM and the raster's transform is expressed in
    # it, so every distance below is measured in the same frame as the pixels.
    to_raster = Transformer.from_crs(WGS84, raster.crs, always_xy=True).transform
    projected = LineString([to_raster(lon, lat) for lon, lat in coordinates])
    if projected.length <= 0.0:
        return Invalid(
            "A playing line must have some length; every point of this one is in the "
            "same place.",
            field_name="line",
            detail={"vertices": len(coordinates)},
        )

    initial = Point(projected.coords[0])
    terminal = Point(projected.coords[-1])
    span = math.hypot(terminal.x - initial.x, terminal.y - initial.y)
    # The straight tee-to-green axis, used only for elongation. A dogleg's chord
    # still points down the hole, which is all the measurement needs.
    axis = ((terminal.x - initial.x) / span, (terminal.y - initial.y) / span)

    regions = [
        _region(mask, raster, projected, initial, terminal, axis, thresholds)
        for mask in segmented.masks
    ]

    evidence = _reversal(regions, layout, area_ranges)
    if evidence is not None:
        return Invalid(
            "This playing line looks drawn from the green to the tee. Draw it from the "
            "tee to the green: the line's direction is what tells us which shape is the "
            "green and which are the tee boxes, and reversing it would label them the "
            "wrong way round.",
            field_name="line",
            detail=evidence,
        )

    _assign_green(regions, layout)
    tees = _assign_tees(regions, tee_sets, projected.length, layout)
    missing = _match_tee_sets(tees, tee_sets, projected.length, layout)
    _assign_fairway(regions, layout, par)

    # Turf that took no role is real grass with no golf feature attached to it —
    # rough, a surround, a practice area clipped by the corridor. It is not a
    # proposal, so it joins the unrecognised masks rather than being invented into
    # one of the five kinds.
    for region in regions:
        if region.kind == _TURF:
            region.kind = FeatureKind.UNKNOWN
            region.notes.append(
                "Turf that is not the green, a tee box, or the fairway by position."
            )

    features = tuple(
        _finish(r, area_ranges, par) for r in regions if r.kind in PROPOSED_KINDS
    )
    unclassified = tuple(
        _finish(r, area_ranges, par) for r in regions if r.kind not in PROPOSED_KINDS
    )

    if not features:
        return NoCoverage(
            "None of the regions found in this corridor matched a golf feature. The "
            "imagery may be obscured, or the corridor may not cover the hole.",
            detail={
                "item_id": raster.item_id,
                "acquired": raster.acquired.isoformat(),
                "masks": len(segmented.masks),
                "unclassified_masks": len(unclassified),
            },
        )

    return Ok(
        ClassifiedCorridor(
            corridor=segmented,
            features=features,
            unclassified=unclassified,
            missing_tee_sets=missing,
            line_length_meters=float(projected.length),
            thresholds=thresholds,
        )
    )
