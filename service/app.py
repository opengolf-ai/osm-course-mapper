"""The one typed endpoint the client calls, and the job lifecycle behind it.

This module is the seam between a contributor's drawn line and everything U1-U4
and U9 do with it. It owns four things and deliberately not a fifth:

1. **Input bounds.** Everything a request carries is bounded before any work
   starts — the line by U1's own caps, and `par` and `tee_sets` here, because
   those feed classification thresholds rather than being decoration. KTD11 puts
   access control at an identity proxy, which is precisely why the bounds live
   here: an *authenticated* contributor can still send a corridor, or a
   scorecard, large enough to exhaust the container.

2. **Spawn and poll, never a synchronous answer.** See `JobRunner` below. This
   is KTD6 and it is the single most consequential shape decision in the unit.

3. **Typed outcomes end to end.** Every response body is `results.py`'s
   vocabulary rendered as JSON, and the HTTP status is `failure.http_status` —
   one attribute lookup, not a chain of isinstance checks that drifts out of sync
   with the union. FastAPI's own request-validation failures are rewritten into
   the same envelope, so a client narrows on one `status` field and never has to
   ask which layer rejected it.

4. **Persistence through U9's store, and only on a contributor's word.** KTD1 is
   settled: every proposal reaches a human before it becomes a record. Nothing
   here writes a row that a contributor did not answer.

The fifth thing — authentication — is deliberately absent. KTD11 puts it at the
proxy in front of this service, so there is no token check, no session and no
contributor identity anywhere in this file. That is not an oversight to be fixed
later by adding a header read: U9's schema holds no contributor column *by
design*, and a proxy identity forwarded into the store would undo that quietly.
Permissive CORS is a local-development affordance behind an explicit flag. Note
that the endpoint URL is not a secret in either posture — the client convention
in `src/api/opengolf.ts` ships service base URLs in the browser bundle.

**What this module must not import.** `torch`, `segment-geospatial` and `modal`
are all absent from the base environment on purpose (see `service/pyproject.toml`
and `service/modal_deploy.py`). `segment.py` defers its model imports to call
time, and this module keeps that discipline: importing `service.app` costs no
gigabyte-scale dependency, which is what makes `pytest service/` a real gate.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Protocol

from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy.orm import Session

from service import holes, segment, vectorize
from service.classify import METERS_PER_YARD, FeatureKind, TeeSet, classify_corridor
from service.holes import FeatureOrigin, HoleFeatureKind, OsmAction
from service.models import DecisionOutcome, LineSource
from service.naip import (
    CORRIDOR_HALF_WIDTH_METERS,
    MAX_LINE_VERTICES,
    MAX_LINE_LENGTH_METERS,
    CorridorRaster,
    build_corridor,
    fetch_corridor_raster,
)
from service.results import Failure, Invalid, NoCoverage, Ok, Result, Timeout, Upstream, is_ok
from service.store import DecisionInput, HoleRef, decisions_for_course, decisions_for_hole
from service.store import record_decisions as record_decisions_in_store
from service.vectorize import Provenance

# --------------------------------------------------------------------------- #
# Budgets and bounds
# --------------------------------------------------------------------------- #

#: How long a warm request is allowed to take before the poll path reports a
#: typed timeout. Sixty seconds is generous against the measured shape of the
#: work — a corridor read, one SAM pass over a few megapixels, then pure
#: geometry — and mean against a request that has gone wrong.
DEFAULT_BUDGET_SECONDS = 60.0

#: Modal caps a web request at 150 s and past that issues a redirect its own docs
#: say does not work with CORS. This is a wall, not a target: a budget set near it
#: converts every slow request into a transport error the client cannot type,
#: which is the exact failure the spawn-and-poll shape exists to avoid. Enforced
#: rather than documented, because the failure is silent when it happens.
HARD_CEILING_SECONDS = 150.0

#: Real scorecards list four or five tee sets; eight is past any of them. The cap
#: exists because each set is a distance threshold the tee matcher searches
#: against, so an unbounded list is both a cost surface and a way to make the
#: classifier assign a tee to every mask it can reach.
MAX_TEE_SETS = 8

#: Yardage bounds. The ceiling is derived rather than chosen: a tee set that plays
#: further than the longest line this service accepts can never match a mask on
#: any line it accepts, so `MAX_LINE_LENGTH_METERS` is already the real limit and
#: restating it in yards keeps the two from drifting apart. The floor rules out
#: zero and negative yardages, which would place a tee at or past the green.
MIN_TEE_YARDS = 30.0
MAX_TEE_YARDS = MAX_LINE_LENGTH_METERS / METERS_PER_YARD

#: Par bounds. Par 3 to 5 covers essentially every hole ever built; 6 and 7 exist
#: (Satsuki's seventh is a par 7) and cost nothing to admit. Par is used in
#: exactly one place — lowering confidence in a fairway proposal on a par 3 — so
#: the bound is about refusing nonsense rather than about precision.
MIN_PAR = 3
MAX_PAR = 7

#: One review pass answers one hole's proposals. Twenty would be a busy hole;
#: two hundred is a cap that no honest client reaches and a runaway one does.
MAX_DECISIONS_PER_BATCH = 200

#: A proposal leaves this service under `vectorize.MAX_PROPOSAL_VERTICES` nodes.
#: A contributor may edit a shape before confirming it, so the write path accepts
#: much more than it emitted — but not an unbounded blob, since the geometry is
#: stored as JSON and read back by the training exporter.
MAX_GEOMETRY_COORDINATES = 10_000

#: A saved hole is one review's worth of confirmed and drawn shapes. Thirty is a
#: busy hole; two hundred matches the decision batch cap for the same reason.
MAX_FEATURES_PER_HOLE = 200

#: OSM tags a saved feature may carry. OSM itself caps keys and values at 255
#: characters; twenty tags is past any golf feature's real tag set.
MAX_OSM_TAGS = 20
MAX_OSM_TAG_LENGTH = 255

#: How many job records one container keeps. A container under scale-to-zero
#: serves many requests before it is reclaimed, so an unbounded map of finished
#: jobs is a leak with a long fuse. Finished jobs are evicted oldest-first; a
#: contributor polling a job evicted out from under them gets the same typed
#: "unknown reference" answer as one polling a job whose container is gone, which
#: is the case the client must handle anyway.
MAX_TRACKED_JOBS = 256


# --------------------------------------------------------------------------- #
# The detection pipeline
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class DetectionRequest:
    """One hole's detection request, validated and in the service's own types.

    Distinct from the pydantic body model on purpose. The body model is the wire
    format and belongs to HTTP; this is what crosses into the job — and under
    Modal that is a process boundary, so it holds only plain values and frozen
    dataclasses that pickle without dragging a request context along.
    """

    line: tuple[tuple[float, float], ...]
    par: int | None = None
    tee_sets: tuple[TeeSet, ...] = ()
    half_width_meters: float = CORRIDOR_HALF_WIDTH_METERS


@dataclass(frozen=True)
class Detection:
    """A finished detection, already JSON-ready.

    Everything here is a plain dict or tuple rather than a `VectorizedCorridor`,
    because the value has to survive a trip through Modal's result store and back
    into a different container. Serializing at the end of the job rather than at
    the edge of the response means the thing that crosses that boundary is data
    with no numpy array, no rasterio dataset and no CRS object hiding in it.
    """

    features: dict[str, Any]
    imagery: dict[str, Any]
    missing_tee_sets: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class Pipeline:
    """The four stages, injected so the endpoint is testable without the world.

    Two of these cannot run in the base environment — `fetch_raster` needs the
    network and `segment` needs torch — and both are the stages whose behaviour
    the endpoint's tests are least about. Injecting all four rather than only
    those two keeps one substitution mechanism instead of two, and lets a test
    run the *real* classifier and vectorizer over a painted scene, so an
    assertion about `kind` and `confidence` is an assertion about the pipeline.
    """

    fetch_raster: Callable[..., Result[Any]] = fetch_corridor_raster
    segment: Callable[[Any], Result[Any]] = segment.segment_corridor
    classify: Callable[..., Result[Any]] = classify_corridor
    vectorize: Callable[[Any], Result[Any]] = vectorize.vectorize_corridor


DEFAULT_PIPELINE = Pipeline()


def imagery_reference(raster: CorridorRaster) -> dict[str, Any]:
    """The corridor raster the model actually read, as the client receives it.

    This is U8's whole input and half of R13's provenance, and it is deliberately
    more than a URL:

    * `asset_href` is the **signed** href of the NAIP item. Planetary Computer
      serves NAIP from a private container and the SAS token this href carries is
      short-lived — on the order of an hour — so a client caching it past a
      session will find it expired. Re-running detection is the way back, and
      that is a better failure than an unsigned href that never worked at all.
    * `bounds_wgs84` is the extent of the **window that was read**, not of the
      whole item. A NAIP quad is thousands of times the size of one hole's
      corridor, so a client handed only the href would draw the wrong thing;
      handed the bounds, it clips to the exact pixels inference saw.
    * `crs`, `width` and `height` are what let a client georeference the read
      without re-deriving it, and they are what make "the exact pixels" checkable
      rather than approximate.

    None of this is the `usgs-naip` basemap the map component already offers.
    That is a live USGS NAIPPlus mosaic with no pinned version and no per-tile
    acquisition date; inference reads one dated Planetary Computer item. Showing
    the basemap instead would show the contributor different pixels than the
    model read, which satisfies neither R9 nor AE5.
    """
    _, height, width = raster.pixels.shape
    return {
        "source": raster.source,
        "item_id": raster.item_id,
        "acquired": raster.acquired.isoformat(),
        "gsd_meters": raster.gsd_meters,
        "asset_href": raster.asset_href,
        "bounds_wgs84": list(raster.bounds_wgs84),
        "crs": raster.crs.to_string(),
        "width": width,
        "height": height,
    }


def _with_imagery(failure: Failure, imagery: dict[str, Any] | None) -> Failure:
    """Attach the imagery that was read to a `NoCoverage` that came after it.

    A corridor whose imagery read fine and whose segmentation found nothing is a
    very different situation from a corridor outside NAIP's footprint, and the
    difference is worth carrying: with the raster reference attached, the
    contributor can put the exact pixels inference saw under the map and judge
    whether the model missed something or there was genuinely nothing there.
    Only `NoCoverage` is enriched — an `Upstream` failure means the read itself is
    suspect, and a `Timeout` never gets this far.
    """
    if imagery is None or not isinstance(failure, NoCoverage):
        return failure
    return dataclasses.replace(failure, detail={**failure.detail, "imagery": imagery})


def run_detection(request: DetectionRequest, pipeline: Pipeline) -> Result[Detection]:
    """Fetch, segment, classify, vectorize — the whole job, in one call.

    Any stage's failure short-circuits and is returned as it stands, which is what
    keeps five modules' worth of expected outcomes speaking one vocabulary
    (`results.py` says why). `NoCoverage` in particular is *not* an error here: a
    corridor outside NAIP's footprint, a corridor with no masks, and a corridor
    whose masks matched no rule are three legitimately empty answers, and each
    reaches the client as a success with its own status.

    The **playing line is passed to both** `fetch_raster` and `classify`, and
    that repetition is load-bearing rather than sloppy: the `Corridor` on the
    raster keeps only the buffered polygon, which has no way to say which end is
    the tee and which is the green, and the line's direction is the entire
    positional prior the classifier has.
    """
    fetched = pipeline.fetch_raster(request.line, half_width_meters=request.half_width_meters)
    if not is_ok(fetched):
        return fetched
    raster = fetched.value
    imagery = imagery_reference(raster)

    segmented = pipeline.segment(raster)
    if not is_ok(segmented):
        return _with_imagery(segmented, imagery)

    classified = pipeline.classify(
        segmented.value,
        request.line,
        tee_sets=request.tee_sets,
        par=request.par,
    )
    if not is_ok(classified):
        return _with_imagery(classified, imagery)

    vectorized = pipeline.vectorize(classified.value)
    if not is_ok(vectorized):
        return _with_imagery(vectorized, imagery)

    corridor = vectorized.value
    return Ok(
        Detection(
            features=corridor.to_feature_collection(),
            imagery=imagery,
            missing_tee_sets=tuple(
                {"name": tee.name, "yards": tee.yards, "key": tee.key}
                for tee in corridor.missing_tee_sets
            ),
        )
    )


# --------------------------------------------------------------------------- #
# The job lifecycle
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class JobStatus:
    """Where one job stands: still running, or finished with a typed outcome.

    `result is None` means "still running" and nothing else — a job that finished
    with a failure carries that failure here, not a null. Keeping `elapsed_seconds`
    alongside means the runner owns the budget rule (it is the only thing that
    knows when the job was submitted) while the endpoint owns the rendering.
    """

    job_id: str
    elapsed_seconds: float
    result: Result[Detection] | None = None


class JobRunner(Protocol):
    """Submit work, get a reference, poll the reference. KTD6's whole shape.

    The endpoint answers a *reference* rather than an answer because Modal caps
    web requests at 150 s and past that issues a redirect its own documentation
    says does not work with CORS. A cold GPU container spends tens of seconds on
    boot, torch import, CUDA init and checkpoint load before inference even
    starts, so a synchronous call would routinely surface a cold start as a
    failed fetch — a transport error with no status to read — where R12 requires
    a *typed* timeout the contributor's client can fold into its result union and
    fall back to hand-mapping on.

    The protocol is two methods so the Modal binding in `service/modal_deploy.py`
    is a thin adapter over `Function.spawn` and `FunctionCall.get(timeout=0)`
    rather than the thing under test. `InProcessJobRunner` below is what local
    development and every test in this repo actually run, which is what makes the
    poll path — including the timeout — genuinely testable in an environment with
    no Modal account.
    """

    def submit(self, request: DetectionRequest) -> str:
        """Enqueue a detection and return the reference the client polls."""
        ...

    def poll(self, job_id: str, budget_seconds: float) -> JobStatus:
        """Where that job stands now. Never blocks."""
        ...


def _daemon_thread(work: Callable[[], None]) -> None:
    """The shipped `start` hook: run the job off the request thread.

    A daemon thread rather than a pool, because the concurrency limit that
    matters is the container's — Modal scales by adding containers, and a local
    development server serving one contributor needs no queue. Daemon so a
    shutdown is not held open by a job nobody is waiting for any more.
    """
    threading.Thread(target=work, daemon=True, name="detect").start()


@dataclass
class _JobRecord:
    submitted_at: float
    result: Result[Detection] | None = None


class InProcessJobRunner:
    """Spawn-and-poll inside one process. The local and test implementation.

    `start` and `clock` are injected for the same reason the pipeline stages are:
    the behaviour worth testing is the *poll path*, and testing it against real
    threads and a real clock would mean a suite that sleeps out a 60 s budget to
    prove the timeout fires. With both injected a test drives the lifecycle by
    hand — submit, observe pending, run the work, observe the answer — and the
    timeout scenario advances a fake clock instead of waiting.

    **A timed-out job is not cancelled.** Python cannot safely kill a running
    thread, and Modal's own semantics are the same: the container keeps working
    and the client stops polling. That is the honest behaviour to mirror, and the
    result is still recorded — a contributor who polls again after a timeout gets
    the answer if it has since arrived, because an answer that exists helps
    nobody by being thrown away.
    """

    def __init__(
        self,
        detect: Callable[[DetectionRequest], Result[Detection]],
        *,
        start: Callable[[Callable[[], None]], None] | None = None,
        clock: Callable[[], float] | None = None,
        max_jobs: int = MAX_TRACKED_JOBS,
    ) -> None:
        self._detect = detect
        self._start = start or _daemon_thread
        self._clock = clock or time.monotonic
        self._max_jobs = max_jobs
        self._jobs: OrderedDict[str, _JobRecord] = OrderedDict()
        self._lock = threading.Lock()

    def submit(self, request: DetectionRequest) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._evict()
            self._jobs[job_id] = _JobRecord(submitted_at=self._clock())
        self._start(lambda: self._run(job_id, request))
        return job_id

    def poll(self, job_id: str, budget_seconds: float) -> JobStatus:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return JobStatus(
                    job_id=job_id,
                    elapsed_seconds=0.0,
                    result=Invalid(
                        "No detection job with that reference. It may have finished long "
                        "ago, or the container holding it may have been reclaimed. Submit "
                        "the line again, or map the hole by hand.",
                        field_name="job_id",
                        detail={"job_id": job_id},
                    ),
                )
            elapsed = self._clock() - record.submitted_at
            result = record.result

        if result is not None:
            return JobStatus(job_id=job_id, elapsed_seconds=elapsed, result=result)
        if elapsed > budget_seconds:
            return JobStatus(
                job_id=job_id,
                elapsed_seconds=elapsed,
                result=Timeout(
                    "Detection did not finish within the time budget. The hole is still "
                    "yours to map by hand.",
                    elapsed_seconds=elapsed,
                ),
            )
        return JobStatus(job_id=job_id, elapsed_seconds=elapsed)

    def _run(self, job_id: str, request: DetectionRequest) -> None:
        """Run the job and record its outcome, converting a crash into a result.

        The broad except is the point. This runs off the request thread, so an
        exception here has no HTTP response to escape into: without the catch it
        would be swallowed by the thread and the client would poll a job that
        never finishes, eventually reporting a timeout for what was actually a
        crash. A typed `Upstream` says what happened.
        """
        try:
            result: Result[Detection] = self._detect(request)
        except Exception as error:  # noqa: BLE001 - any crash is one typed outcome
            result = Upstream(
                "Detection failed unexpectedly.",
                source="pipeline",
                cause=f"{type(error).__name__}: {error}",
            )
        with self._lock:
            record = self._jobs.get(job_id)
            if record is not None:
                record.result = result

    def _evict(self) -> None:
        """Drop the oldest finished jobs once the map is full. Caller holds the lock.

        Finished jobs first, and only then the oldest running one — evicting a
        job that is still working would leave its thread writing into a record
        nobody can read, which reads to the contributor as a job that never
        completes rather than as one that was dropped.
        """
        while len(self._jobs) >= self._max_jobs:
            for job_id, record in self._jobs.items():
                if record.result is not None:
                    del self._jobs[job_id]
                    break
            else:
                self._jobs.popitem(last=False)


# --------------------------------------------------------------------------- #
# The wire format
# --------------------------------------------------------------------------- #


class TeeSetBody(BaseModel):
    """One scorecard tee set, as the client sends it.

    **This is the contract change the plan's "par and card yardage" understates.**
    Classification matches tee masks against *per-tee-set* yardages: one number
    can only ever place one tee, and a hole has four. `key` is the course
    record's own `tee_key` (`"blue-male"`), carried opaquely so the client can
    reconcile an assignment against the tee set it already holds.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    yards: float = Field(ge=MIN_TEE_YARDS, le=MAX_TEE_YARDS)
    key: str | None = Field(default=None, max_length=64)

    def to_tee_set(self) -> TeeSet:
        return TeeSet(name=self.name, yards=self.yards, key=self.key)


class DetectBody(BaseModel):
    """A detection request.

    `line` is the WGS84 playing line, **tee to green**, as `[[lon, lat], ...]` —
    GeoJSON's axis order, which is what the rest of the pipeline speaks. The
    vertex cap is U1's, restated here so an over-long line is refused by the body
    model rather than by a geodesic computation; every other cap needs the
    geometry and is checked by `build_corridor` a moment later.

    `par` and `tee_sets` are both optional and both feed classification: omitting
    `tee_sets` costs only the tee assignments, and omitting `par` costs only the
    lowered confidence on a fairway proposed for a par 3. Neither changes a
    boundary.

    The corridor half-width is deliberately *not* a request field. It is the
    single knob that multiplies the imagery read and the model's work, and it is
    a service decision (U1's 60 m, wide enough for greenside bunkers and narrow
    enough to miss the neighbouring hole) rather than a contributor's. Operators
    can still move it through `create_app`.

    `extra="forbid"` so a typo'd field name is a typed validation error naming the
    field rather than a silently ignored parameter.
    """

    model_config = ConfigDict(extra="forbid")

    line: list[tuple[float, float]] = Field(min_length=2, max_length=MAX_LINE_VERTICES)
    par: int | None = Field(default=None, ge=MIN_PAR, le=MAX_PAR)
    tee_sets: list[TeeSetBody] = Field(default_factory=list, max_length=MAX_TEE_SETS)

    def to_request(self, half_width_meters: float) -> DetectionRequest:
        return DetectionRequest(
            line=tuple((float(lon), float(lat)) for lon, lat in self.line),
            par=self.par,
            tee_sets=tuple(tee.to_tee_set() for tee in self.tee_sets),
            half_width_meters=half_width_meters,
        )


class ProvenanceBody(BaseModel):
    """The provenance a decision carries, echoed back from the proposal.

    Every field here appears verbatim in a proposal's GeoJSON `properties`, so a
    client assembles this by copying rather than by constructing. It is echoed
    rather than looked up server-side because a job's result does not outlive the
    container that produced it under scale-to-zero, and a decision recorded an
    hour later would otherwise have nothing to look up.
    """

    model_config = ConfigDict(extra="forbid")

    acquired: str
    gsd_meters: float = Field(gt=0.0, le=100.0)
    source: str = Field(min_length=1, max_length=200)
    model_id: str = Field(min_length=1, max_length=200)
    item_id: str = Field(min_length=1, max_length=200)

    def to_provenance(self) -> Provenance:
        return Provenance(
            acquired=dt.date.fromisoformat(self.acquired),
            gsd_meters=self.gsd_meters,
            source=self.source,
            model_id=self.model_id,
            item_id=self.item_id,
        )


class DecisionBody(BaseModel):
    """One answered proposal.

    `kind` and `outcome` are the service's own enums, so an unknown value is a
    typed validation error naming the field instead of a row the training
    exporter cannot join against. `geometry` stays a raw mapping — the store
    validates that it is an area with coordinates, and duplicating that here
    would put the same rule in two places.

    `in_play` is the one field here that no model produced. R14 has a proposed
    water body become a hazard only when a contributor says a ball can find it,
    and this model forbids extras, so omitting the field would make that answer
    a 422 the client swallows — the answer would appear to save and never exist.
    Optional rather than required because the question is only ever put for
    water: absent means never asked, which is not the same as answered "no".
    """

    model_config = ConfigDict(extra="forbid")

    kind: FeatureKind
    outcome: DecisionOutcome
    geometry: dict[str, Any]
    confidence: float = Field(ge=0.0, le=1.0)
    provenance: ProvenanceBody
    in_play: bool | None = None

    def to_input(self) -> DecisionInput:
        return DecisionInput(
            kind=self.kind,
            outcome=self.outcome,
            geometry=self.geometry,
            confidence=self.confidence,
            provenance=self.provenance.to_provenance(),
            in_play=self.in_play,
        )


class DecisionsBody(BaseModel):
    """One hole's review pass: which course, which hole, and what was said.

    Deliberately no contributor, device or session field. U9's schema holds no
    such column *by design* — a test there freezes the column set — and a client
    that could supply one would undo that decision from the outside. KTD11 does
    not change this: the identity the proxy authenticated stays at the proxy.
    """

    model_config = ConfigDict(extra="forbid")

    course_id: str = Field(min_length=1, max_length=128)
    hole_number: int = Field(ge=1, le=99)
    decisions: list[DecisionBody] = Field(
        default_factory=list, max_length=MAX_DECISIONS_PER_BATCH
    )


def _coordinate_count(value: Any, budget: int) -> int:
    """Count coordinate pairs in a GeoJSON coordinates member, stopping early.

    Bounded rather than exhaustive: the only question is "is this bigger than the
    cap", and a deliberately pathological nesting should not be walked in full to
    find that out.
    """
    if budget <= 0:
        return 0
    if not isinstance(value, (list, tuple)):
        return 0
    if value and all(isinstance(item, (int, float)) for item in value):
        return 1
    seen = 0
    for item in value:
        seen += _coordinate_count(item, budget - seen)
        if seen >= budget:
            break
    return seen


def _oversized_geometry(body: DecisionsBody) -> Invalid | None:
    """Refuse a decision whose geometry is larger than any edited shape.

    KTD11 again: an authenticated contributor is still an untrusted source of
    payload size, and this geometry is stored as JSON and read back by the
    training exporter. The cap is far above what this service emits — proposals
    leave under 80 nodes — because a contributor may reshape a proposal before
    confirming it and that edit must not be refused.
    """
    for index, decision in enumerate(body.decisions):
        count = _coordinate_count(
            decision.geometry.get("coordinates"), MAX_GEOMETRY_COORDINATES + 1
        )
        if count > MAX_GEOMETRY_COORDINATES:
            return Invalid(
                "That geometry has more coordinates than this service will store.",
                field_name="geometry",
                detail={"index": index, "cap_coordinates": MAX_GEOMETRY_COORDINATES},
            )
    return None


# --- Saved holes and boundaries --------------------------------------------- #
#
# The mapping record, as opposed to the training record above. Shapes are
# bounded here (enums, lengths, the tag map) and *geometrically* validated in
# `holes.py` — finite coordinates on the globe, rings that can enclose an area,
# the proposal/origin pairing — so the rule for "can this become OSM nodes" lives
# in one place and is testable without HTTP. Every model forbids extras, for the
# same reason `DetectBody` does, and none has a contributor or session field.

OsmTagText = Annotated[str, StringConstraints(min_length=1, max_length=MAX_OSM_TAG_LENGTH)]


class LineGeometryBody(BaseModel):
    """A GeoJSON LineString. `coordinates` is checked by `holes.line_problem`."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["LineString"]
    coordinates: list[Any]


class AreaGeometryBody(BaseModel):
    """A GeoJSON Polygon or MultiPolygon. Checked by `holes.area_problem`."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["Polygon", "MultiPolygon"]
    coordinates: list[Any]


class SavedTeeSetBody(BaseModel):
    """A tee set a saved tee box serves.

    Unlike `TeeSetBody`, `yards` may be null: a contributor can place the blue
    tee from the card's name alone when the card gives no yardage, and an
    invented number would be worse than an absent one.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=64)
    yards: float | None = Field(default=None, ge=MIN_TEE_YARDS, le=MAX_TEE_YARDS)


class ProposalBody(BaseModel):
    """What a proposed feature carries that a drawn one cannot."""

    model_config = ConfigDict(extra="forbid")

    confidence: float = Field(ge=0.0, le=1.0)
    provenance: ProvenanceBody


class SavedFeatureBody(BaseModel):
    """One confirmed or drawn polygon on a saved hole.

    `edited` records that a contributor moved vertices of a proposed shape —
    the difference between "the model was right" and "the model was close",
    which the training record and the OSM changeset comment both want.
    """

    model_config = ConfigDict(extra="forbid")

    kind: HoleFeatureKind
    geometry: AreaGeometryBody
    origin: FeatureOrigin
    edited: bool = False
    tee_sets: list[SavedTeeSetBody] = Field(default_factory=list, max_length=MAX_TEE_SETS)
    label: str | None = Field(default=None, max_length=200)
    osm_tags: dict[OsmTagText, OsmTagText] = Field(default_factory=dict, max_length=MAX_OSM_TAGS)
    proposal: ProposalBody | None = None
    #: The OpenStreetMap element, e.g. "way/500123", when `origin` is `osm`.
    osm_id: str | None = Field(default=None, max_length=64)
    #: What the upload has to do with it; see `holes.OsmAction`. Filled in when
    #: omitted — `create` for a new shape, `keep` or `modify` for an OSM one by
    #: whether it was edited — so every stored feature says it explicitly.
    osm_action: OsmAction | None = None

    @model_validator(mode="after")
    def _default_osm_action(self) -> "SavedFeatureBody":
        if self.osm_action is None:
            if self.origin == FeatureOrigin.OSM:
                self.osm_action = OsmAction.MODIFY if self.edited else OsmAction.KEEP
            else:
                self.osm_action = OsmAction.CREATE
        return self


class HoleBody(BaseModel):
    """One whole hole, saved. Append-only: a re-save is a new row."""

    model_config = ConfigDict(extra="forbid")

    course_id: str = Field(min_length=1, max_length=128)
    hole_number: int = Field(ge=1, le=99)
    par: int | None = Field(default=None, ge=MIN_PAR, le=MAX_PAR)
    playing_line: LineGeometryBody
    line_source: LineSource
    osm_hole_id: str | None = Field(default=None, max_length=64)
    features: list[SavedFeatureBody] = Field(default_factory=list, max_length=MAX_FEATURES_PER_HOLE)

    def to_input(self) -> holes.HoleInput:
        # `mode="json"` so what is stored is exactly the JSON the read path
        # answers: enums as their values, defaults filled in.
        return holes.HoleInput(
            course_id=self.course_id,
            hole_number=self.hole_number,
            par=self.par,
            playing_line=self.playing_line.model_dump(mode="json"),
            line_source=self.line_source,
            osm_hole_id=self.osm_hole_id,
            features=tuple(feature.model_dump(mode="json") for feature in self.features),
        )


class BoundaryBody(BaseModel):
    """A corrected (or confirmed) course boundary. The course is in the path.

    `edited` defaults to true because the ordinary reason to save a boundary is
    that the contributor changed it; a confirmation of OSM's shape says `false`.
    """

    model_config = ConfigDict(extra="forbid")

    osm_id: str | None = Field(default=None, max_length=64)
    geometry: AreaGeometryBody
    edited: bool = True


def _oversized(coordinates: Any, field_name: str, **detail: Any) -> Invalid | None:
    """The `MAX_GEOMETRY_COORDINATES` cap applied to one geometry of a save."""
    count = _coordinate_count(coordinates, MAX_GEOMETRY_COORDINATES + 1)
    if count > MAX_GEOMETRY_COORDINATES:
        return Invalid(
            "That geometry has more coordinates than this service will store.",
            field_name=field_name,
            detail={**detail, "cap_coordinates": MAX_GEOMETRY_COORDINATES},
        )
    return None


def _oversized_hole(body: HoleBody) -> Invalid | None:
    """The coordinate cap, per feature and for the line, before any walk of them.

    Checked ahead of `holes.py`'s per-position validation so a pathological
    payload is refused by a bounded count rather than a full walk.
    """
    line = _oversized(body.playing_line.coordinates, "playing_line")
    if line is not None:
        return line
    for index, feature in enumerate(body.features):
        found = _oversized(feature.geometry.coordinates, "features", index=index)
        if found is not None:
            return found
    return None


# --------------------------------------------------------------------------- #
# Rendering typed outcomes as HTTP
# --------------------------------------------------------------------------- #


def failure_body(failure: Failure) -> dict[str, Any]:
    """A failure variant as JSON, mechanically.

    `dataclasses.asdict` rather than a per-variant branch: every field of every
    variant reaches the client without this function having to know which variant
    it holds, so adding a variant to `results.py` cannot leave a field silently
    unserialized here. The single rename is `field_name` to `field` — the
    dataclass has to avoid colliding with `dataclasses.field`, and the wire does
    not.

    `http_status` is a `ClassVar` and so is correctly absent from `asdict`; it is
    read directly where the status code is set.
    """
    body = dataclasses.asdict(failure)
    if "field_name" in body:
        body["field"] = body.pop("field_name")
    return body


def failure_response(failure: Failure, **extra: Any) -> JSONResponse:
    """One failure, one status code, no isinstance chain.

    The mapping is `failure.http_status` and nothing else — `results.py` puts the
    code on the variant precisely so this stays one attribute lookup that cannot
    drift out of sync with the union.
    """
    return JSONResponse(status_code=failure.http_status, content={**extra, **failure_body(failure)})


def _detection_body(detection: Detection) -> dict[str, Any]:
    """A successful detection as JSON.

    `missing_tee_sets` appears here *and* inside the FeatureCollection's
    properties, and the duplication is deliberate. The collection member is what a
    plain GeoJSON viewer renders and what travels if the collection is saved on
    its own; the top-level member is what a client builds the "we could not find
    your white tee — draw it?" prompt from, and making it dig through a properties
    bag for a first-class piece of the answer would be a worse contract.
    """
    return {
        "status": "ok",
        "features": detection.features,
        "imagery": detection.imagery,
        "missing_tee_sets": [dict(tee) for tee in detection.missing_tee_sets],
    }


def _status_response(status: JobStatus, budget_seconds: float) -> JSONResponse:
    """Render a poll: pending, or whichever typed outcome the job produced."""
    base = {"job_id": status.job_id, "elapsed_seconds": round(status.elapsed_seconds, 3)}

    if status.result is None:
        return JSONResponse(
            status_code=200,
            content={**base, "status": "pending", "budget_seconds": budget_seconds},
        )
    if is_ok(status.result):
        body = {**base, **_detection_body(status.result.value)}
        return JSONResponse(status_code=200, content=body)
    return failure_response(status.result, **base)


def _validation_field(errors: Sequence[dict[str, Any]]) -> str | None:
    """The request field a pydantic error is about.

    The first element of `loc` after `"body"`, which is the top-level field even
    when the error is deep inside a list — a bad yardage on the second tee set is
    reported against `tee_sets`, because that is the field the client sent and
    the one it can fix.
    """
    for error in errors:
        location = error.get("loc") or ()
        if len(location) >= 2 and location[0] == "body":
            return str(location[1])
    return None


# --------------------------------------------------------------------------- #
# The application
# --------------------------------------------------------------------------- #

SessionFactory = Callable[[], AbstractContextManager[Session]]


def create_app(
    *,
    pipeline: Pipeline = DEFAULT_PIPELINE,
    runner: JobRunner | None = None,
    session_factory: SessionFactory | None = None,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
    half_width_meters: float = CORRIDOR_HALF_WIDTH_METERS,
    allow_local_cors: bool = False,
) -> FastAPI:
    """Build the service. Every collaborator is an argument; nothing reads the env.

    No import-time configuration anywhere in this module is a deliberate repo
    convention (`store.engine_for_url` takes its URL the same way): a module that
    read `DATABASE_URL` at import would make importing it in a test a
    configuration question, and would make the deployment's failure mode an
    import error rather than a typed response.

    `session_factory` is optional. A service deployed without a database still
    detects — that is the whole of R11 — and answers the decision endpoints with a
    typed `Upstream` saying so, rather than failing to start or raising a 500 at
    the first write.

    `allow_local_cors` is KTD11's local-development affordance and nothing more.
    Production sits behind an authenticating identity proxy that owns both access
    control and its own CORS policy, so the default is off: a wildcard origin
    shipped by default would be a posture rather than a convenience.
    """
    if not 0 < budget_seconds < HARD_CEILING_SECONDS:
        raise ValueError(
            f"The request budget must be positive and below Modal's {HARD_CEILING_SECONDS:.0f} s "
            f"web-request ceiling, which redirects in a way CORS cannot follow; got "
            f"{budget_seconds}."
        )

    if runner is None:
        runner = InProcessJobRunner(lambda request: run_detection(request, pipeline))

    app = FastAPI(
        title="Golf hole feature detection",
        version="0.1.0",
        summary="Segment a hole's corridor from public-domain NAIP imagery.",
    )

    if allow_local_cors:
        # Wildcard, and only here. There are no cookies and no credentials in this
        # protocol — the proxy in front of production holds the session — so a
        # permissive origin costs nothing locally and is never enabled remotely.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.exception_handler(RequestValidationError)
    async def _typed_validation_error(_request: Any, error: RequestValidationError) -> JSONResponse:
        """Render FastAPI's own validation failure in this service's envelope.

        FastAPI answers a 422 whose body is a list of pydantic error dicts under
        `detail` — a shape unlike every other failure here. A client forced to
        branch on which layer rejected it will get one of the branches wrong, and
        R12 depends on the client reliably recognising a rejected request so the
        hole stays hand-mappable. One envelope, narrowed on one `status`.
        """
        errors = [
            {
                "loc": [str(part) for part in (item.get("loc") or ())],
                "message": item.get("msg", ""),
                "type": item.get("type", ""),
            }
            for item in error.errors()
        ]
        return failure_response(
            Invalid(
                errors[0]["message"] if errors else "The request could not be read.",
                field_name=_validation_field(error.errors()),
                detail={"errors": errors},
            )
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        """Liveness only, and the one endpoint declared `async`.

        Deliberately does not touch imagery, the model or the database: a health
        check that fetches a NAIP tile would wake a scale-to-zero container on a
        schedule and bill for it. `async` because it must still answer when every
        threadpool worker is busy inside a corridor read — a liveness probe that
        queues behind real work reports the container dead and gets it killed
        mid-detection.

        Every other endpoint below is a plain `def` on purpose. Starlette runs a
        sync endpoint in a worker thread and an `async` one directly on the event
        loop, and everything else here blocks: shapely and pyproj in
        `build_corridor`, and SQLAlchemy's synchronous driver in the decision
        paths. Declared `async`, those would stall the loop — and with it every
        poll from every other contributor — for the duration.
        """
        return {"status": "ok"}

    @app.post("/v1/detect", status_code=202)
    def detect(body: DetectBody) -> JSONResponse:
        """Enqueue a detection and answer the reference to poll.

        **Validation happens before the spawn**, synchronously. `build_corridor`
        bounds-checks a line without touching imagery, so an over-cap request
        costs one geodesic length computation instead of a STAC query, a SAS
        token, a multi-megapixel COG read and a GPU container. It also means the
        contributor learns their line is too long immediately rather than after a
        poll round trip.

        202 rather than 200: the work has been accepted, not done.
        """
        request = body.to_request(half_width_meters)

        built = build_corridor(request.line, request.half_width_meters)
        if not is_ok(built):
            return failure_response(built)

        job_id = runner.submit(request)
        return JSONResponse(
            status_code=202,
            content={
                "status": "pending",
                "job_id": job_id,
                "poll_url": f"/v1/detect/{job_id}",
                "budget_seconds": budget_seconds,
            },
        )

    @app.get("/v1/detect/{job_id}")
    def poll_detection(job_id: str) -> JSONResponse:
        """Where a detection stands. Never blocks, and always answers typed.

        Polling rather than a long-lived connection is KTD6: a cold container's
        boot, torch import, CUDA init and checkpoint load can approach Modal's
        150 s web-request ceiling, past which it redirects in a way CORS cannot
        follow. The timeout the contributor sees comes from here, with a status
        they can read, rather than from a fetch that simply failed.
        """
        return _status_response(runner.poll(job_id, budget_seconds), budget_seconds)

    def _store_unavailable() -> JSONResponse:
        return failure_response(
            Upstream(
                "This service is running without a store, so nothing can be recorded, "
                "saved or read back.",
                source="configuration",
            )
        )

    @app.post("/v1/decisions")
    def record(body: DecisionsBody) -> JSONResponse:
        """Persist one hole's review pass — every confirmation and every rejection.

        Both outcomes are written, because R10 is explicit that a rejection is a
        record rather than a discard: it is the half of the training set that says
        what the classifier got wrong.

        Nothing reaches this store without a contributor having answered it. KTD1
        is settled — inference proposes, a human confirms — so there is
        deliberately no path here that writes an unanswered proposal, and
        `DecisionOutcome` has no value that could express one.

        The decision carries its own geometry and provenance rather than a job
        reference, because a job's result does not outlive the container that
        produced it under scale-to-zero: a contributor reviewing at their own pace
        would otherwise find the proposals they were shown unrecoverable.
        """
        if session_factory is None:
            return _store_unavailable()

        oversized = _oversized_geometry(body)
        if oversized is not None:
            return failure_response(oversized)

        hole = HoleRef(course_id=body.course_id, hole_number=body.hole_number)
        with session_factory() as session:
            written = record_decisions_in_store(
                session, hole, [decision.to_input() for decision in body.decisions]
            )
        if not is_ok(written):
            return failure_response(written)
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "recorded": [_recorded(d) for d in written.value]},
        )

    @app.get("/v1/decisions/{course_id}")
    def read(
        course_id: str,
        hole: int | None = Query(default=None, ge=1, le=99),
    ) -> JSONResponse:
        """Everything recorded for a course, or for one hole of it.

        Every decision, not the latest per feature — a contributor who rejected a
        bunker in one pass and confirmed it in the next has said two things, and
        `batch_id` plus `recorded_at` are what let a consumer decide which to
        honour.
        """
        if session_factory is None:
            return _store_unavailable()

        with session_factory() as session:
            found = (
                decisions_for_course(session, course_id)
                if hole is None
                else decisions_for_hole(session, HoleRef(course_id=course_id, hole_number=hole))
            )
        if not is_ok(found):
            return failure_response(found)
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "decisions": [_recorded(d) for d in found.value]},
        )

    @app.post("/v1/holes")
    def save_hole(body: HoleBody) -> JSONResponse:
        """Save one whole hole: the playing line and every polygon kept on it.

        Append-only. A contributor who comes back to a hole saves it again and
        the read below answers the newest save; the earlier one stays, so an
        undo on the client is never an erasure on the server.
        """
        if session_factory is None:
            return _store_unavailable()

        oversized = _oversized_hole(body)
        if oversized is not None:
            return failure_response(oversized)

        with session_factory() as session:
            saved = holes.save_hole(session, body.to_input())
        if not is_ok(saved):
            return failure_response(saved)
        return JSONResponse(
            status_code=200, content={"status": "ok", "hole": _saved_hole(saved.value)}
        )

    @app.get("/v1/holes/{course_id}")
    def read_holes(
        course_id: str,
        hole: int | None = Query(default=None, ge=1, le=99),
    ) -> JSONResponse:
        """The latest save of each hole on a course, by hole number.

        Only the newest save per hole — unlike the decision read, where every
        answer is a label worth having. A saved hole is a *state*, and the state
        of a hole is its latest save.
        """
        if session_factory is None:
            return _store_unavailable()

        with session_factory() as session:
            found = holes.latest_holes(session, course_id, hole)
        if not is_ok(found):
            return failure_response(found)
        return JSONResponse(
            status_code=200,
            content={"status": "ok", "holes": [_saved_hole(h) for h in found.value]},
        )

    @app.post("/v1/courses/{course_id}/boundary")
    def save_boundary(course_id: str, body: BoundaryBody) -> JSONResponse:
        """Save a course boundary the contributor corrected. Append-only."""
        if session_factory is None:
            return _store_unavailable()

        oversized = _oversized(body.geometry.coordinates, "geometry")
        if oversized is not None:
            return failure_response(oversized)

        boundary = holes.BoundaryInput(
            course_id=course_id,
            osm_id=body.osm_id,
            geometry=body.geometry.model_dump(mode="json"),
            edited=body.edited,
        )
        with session_factory() as session:
            saved = holes.save_boundary(session, boundary)
        if not is_ok(saved):
            return failure_response(saved)
        return JSONResponse(
            status_code=200, content={"status": "ok", "boundary": _saved_boundary(saved.value)}
        )

    @app.get("/v1/courses/{course_id}/boundary")
    def read_boundary(course_id: str) -> JSONResponse:
        """The latest saved boundary, or `null` — nothing saved is not an error."""
        if session_factory is None:
            return _store_unavailable()

        with session_factory() as session:
            found = holes.latest_boundary(session, course_id)
        if not is_ok(found):
            return failure_response(found)
        boundary = None if found.value is None else _saved_boundary(found.value)
        return JSONResponse(status_code=200, content={"status": "ok", "boundary": boundary})

    return app


def _recorded(decision: Any) -> dict[str, Any]:
    """One `RecordedDecision` as JSON.

    `provenance` is nested rather than flattened, matching the shape the client
    sent and the shape `ProvenanceBody` reads — a round trip a client can make
    without a translation table in the middle. `in_play` is echoed for the same
    reason and keeps its `null`: a client rebuilding a hole's hazards from this
    read has to be able to tell "no water question was asked" from "asked, and
    the answer was no".
    """
    return {
        "id": decision.id,
        "batch_id": str(decision.batch_id),
        "course_id": decision.course_id,
        "hole_number": decision.hole_number,
        "kind": str(decision.kind),
        "outcome": str(decision.outcome),
        "geometry": decision.geometry,
        "confidence": decision.confidence,
        "provenance": decision.provenance.as_properties(),
        "in_play": decision.in_play,
        "recorded_at": decision.recorded_at.isoformat(),
    }


def _saved_hole(hole: holes.SavedHoleRecord) -> dict[str, Any]:
    """One saved hole as JSON: the request's shape, plus `id` and `saved_at`."""
    return {
        "id": hole.id,
        "course_id": hole.course_id,
        "hole_number": hole.hole_number,
        "par": hole.par,
        "playing_line": hole.playing_line,
        "line_source": str(hole.line_source),
        "osm_hole_id": hole.osm_hole_id,
        "features": list(hole.features),
        # Not in OpenStreetMap until the upload says so; see `models.OsmSyncStatus`.
        "osm_sync_status": str(hole.osm_sync_status),
        "osm_synced_at": hole.osm_synced_at.isoformat() if hole.osm_synced_at else None,
        "saved_at": hole.saved_at.isoformat(),
    }


def _saved_boundary(boundary: holes.SavedBoundaryRecord) -> dict[str, Any]:
    """One saved boundary as JSON."""
    return {
        "id": boundary.id,
        "course_id": boundary.course_id,
        "osm_id": boundary.osm_id,
        "geometry": boundary.geometry,
        "edited": boundary.edited,
        "saved_at": boundary.saved_at.isoformat(),
    }


#: The module-level application, for `uvicorn service.app:app`. Built with every
#: default — the real pipeline, an in-process runner, no decision store and no
#: permissive CORS — so importing this module never reaches a database or a
#: network. A deployment that wants a store calls `create_app` with one; see
#: `service/modal_deploy.py`.
app = create_app()
