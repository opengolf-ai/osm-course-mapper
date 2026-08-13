"""The inference endpoint: submit a line, poll a job reference, record decisions.

Three conventions run through this file, and each exists because of something the
endpoint would otherwise be able to fake its way past.

* **The scene is painted, the classifier is real.** Only the two stages this
  environment cannot run are substituted: the NAIP fetch (network) and SAM
  (torch). `classify_corridor` and `vectorize_corridor` run for real over a
  hand-painted corridor whose ground truth the test knows, so an assertion that
  the response carries `kind`, `confidence` and an acquisition date is an
  assertion about the real pipeline rather than about a stub that returned a
  dictionary shaped like one.

* **No sleeping, and no threads.** `InProcessJobRunner` takes both its `start`
  hook and its clock, so a test drives the job lifecycle by hand: submit, poll
  while pending, run the work, poll again. The timeout scenario advances a fake
  clock past the budget instead of waiting out a real one — a 60 s budget is not
  something a test suite can afford to observe honestly any other way. One test
  deliberately uses the real threaded default, because a hook that is only ever
  driven by hand proves nothing about the code that ships.

* **The store is SQLite standing in for PostgreSQL**, exactly as `test_store.py`
  documents. The gap is real and stated there; nothing in this file depends on a
  Postgres-only behaviour.

Neither `torch` nor `modal` is installed here, and `test_the_service_imports_with
_neither_torch_nor_modal` freezes that: `service/app.py` must stay importable in
the base environment, and `service/modal_deploy.py` must stay out of its import
graph.
"""

from __future__ import annotations

import datetime as dt
import sys
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pyproj import Transformer
from rasterio.crs import CRS
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from service import app as app_module
from service import classify, models, naip, store, vectorize
from service.classify import TeeSet
from service.models import DecisionOutcome
from service.results import Ok

# The same corridor geometry `test_classify.py` reasons about: 200 x 700 pixels
# at 0.6 m is 120 m across — U1's corridor width — and 420 m long, a real par 4.
HEIGHT, WIDTH = 200, 700
ITEM_CRS = CRS.from_epsg(32610)
ACQUIRED = dt.date(2023, 7, 4)
ITEM_ID = "ca_m_3812_2023"
MODEL_ID = "facebook/sam2-hiera-large"

# NAIP's R, G, B, NIR order. Signatures chosen so the expected class is
# unambiguous under the default thresholds.
TURF = (60, 90, 55, 200)
SAND = (205, 190, 165, 215)
WATER = (35, 45, 50, 20)

GREEN_BOX = (70, 130, 640, 700)
TEE_BACK_BOX = (90, 110, 20, 45)
TEE_MIDDLE_BOX = (70, 88, 50, 72)
FAIRWAY_BOX = (85, 115, 120, 560)
BUNKER_BOX = (40, 64, 600, 630)
POND_BOX = (140, 180, 300, 380)

INITIAL_ROWCOL = (100, 30)
TERMINAL_ROWCOL = (100, 670)

# 640 columns at 0.6 m = 384 m = 420 yd, which is where the tee yardages below
# come from: a set's tee sits `yards` back from the green.
TEE_SETS = (
    TeeSet(name="Black", yards=420.0, key="black-male"),
    TeeSet(name="Blue", yards=398.0, key="blue-male"),
    TeeSet(name="Red", yards=310.0, key="red-female"),
)

COURSE_ID = "opengolf-1234"
HOLE_NUMBER = 7
HOLE = store.HoleRef(course_id=COURSE_ID, hole_number=HOLE_NUMBER)


# --------------------------------------------------------------------------- #
# The painted corridor
# --------------------------------------------------------------------------- #


def _xy(transform, row: float, col: float) -> tuple[float, float]:
    """The projected centre of pixel (row, col)."""
    x = transform.c + transform.a * (col + 0.5) + transform.b * (row + 0.5)
    y = transform.f + transform.d * (col + 0.5) + transform.e * (row + 0.5)
    return (x, y)


def _line(transform, *rowcols: tuple[float, float]) -> list[list[float]]:
    """A WGS84 playing line through the given pixel positions, as JSON pairs."""
    to_wgs84 = Transformer.from_crs(ITEM_CRS, naip.WGS84, always_xy=True).transform
    return [list(to_wgs84(*_xy(transform, row, col))) for row, col in rowcols]


def _mask(box: tuple[int, int, int, int], gsd: float):
    row_start, row_stop, col_start, col_stop = box
    array = np.zeros((HEIGHT, WIDTH), dtype=bool)
    array[row_start:row_stop, col_start:col_stop] = True
    pixel_count = (row_stop - row_start) * (col_stop - col_start)
    from service.segment import CorridorMask

    return CorridorMask(
        mask=array,
        predicted_iou=0.92,
        stability_score=0.94,
        pixel_count=pixel_count,
        area_sq_meters=pixel_count * gsd * gsd,
        bbox_pixels=box,
        centroid_rowcol=((row_start + row_stop - 1) / 2, (col_start + col_stop - 1) / 2),
    )


def _scene(painter) -> np.ndarray:
    scene = np.zeros((4, HEIGHT, WIDTH), dtype=np.uint8)
    for band, value in enumerate(TURF):
        scene[band, :, :] = value
    painter(scene, BUNKER_BOX, SAND)
    painter(scene, POND_BOX, WATER)
    return scene


def _raster(painter, transform, gsd, line) -> naip.CorridorRaster:
    built = naip.build_corridor([(lon, lat) for lon, lat in line])
    assert isinstance(built, Ok), built
    return naip.CorridorRaster(
        pixels=_scene(painter),
        transform=transform,
        crs=ITEM_CRS,
        acquired=ACQUIRED,
        gsd_meters=gsd,
        item_id=ITEM_ID,
        asset_href="https://naipeuwest.blob.core.windows.net/naip/synthetic.tif?st=signed",
        corridor=built.value,
    )


def _segmented(raster, gsd):
    from service.segment import SegmentedCorridor

    masks = tuple(
        _mask(box, gsd)
        for box in (GREEN_BOX, TEE_BACK_BOX, TEE_MIDDLE_BOX, FAIRWAY_BOX, BUNKER_BOX, POND_BOX)
    )
    ordered = tuple(sorted(masks, key=lambda m: (-m.pixel_count, m.centroid_rowcol)))
    return SegmentedCorridor(raster=raster, masks=ordered, model_id=MODEL_ID)


# --------------------------------------------------------------------------- #
# Test doubles for the two stages this environment cannot run
# --------------------------------------------------------------------------- #


class FakeFetch:
    """Stands in for the NAIP read, and records whether it happened at all.

    `calls` is what the corridor-caps scenario asserts on: an over-cap line must
    be refused before any imagery is touched, and the only way to show that is to
    watch the fetch and find it never ran.
    """

    def __init__(self, outcome) -> None:
        self.outcome = outcome
        self.calls: list[tuple] = []

    def __call__(self, coordinates, *, half_width_meters=naip.CORRIDOR_HALF_WIDTH_METERS):
        self.calls.append((tuple(coordinates), half_width_meters))
        return self.outcome


class ManualStart:
    """A `start` hook that queues work instead of running it.

    Lets a test observe the pending state, then run the job, then observe the
    terminal state — the whole poll path, with no thread and no sleep.
    """

    def __init__(self) -> None:
        self.queued: list = []

    def __call__(self, work) -> None:
        self.queued.append(work)

    def run_all(self) -> None:
        while self.queued:
            self.queued.pop(0)()


class FakeClock:
    """A monotonic clock a test advances by hand."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def engine():
    """One in-memory SQLite database shared across threads.

    `StaticPool` plus `check_same_thread=False` is not incidental setup. The
    endpoints that touch the store are plain `def`, so Starlette runs them in a
    worker thread — which is the correct shape for a blocking driver, and exactly
    what production does. Under SQLite's default pool each thread would open its
    own connection, and an in-memory database is per-connection, so the endpoint
    would find an empty schema while the test held the populated one. Sharing one
    connection makes the test observe the same database the request wrote to.
    """
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    models.Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine):
    return lambda: Session(engine)


@pytest.fixture
def corridor(painter, utm_transform, gsd):
    """The reference hole: line, raster, and the masks a model would have found."""
    line = _line(utm_transform, INITIAL_ROWCOL, TERMINAL_ROWCOL)
    raster = _raster(painter, utm_transform, gsd, line)
    return line, raster, _segmented(raster, gsd)


def _pipeline(fetch, segmented_outcome):
    """A pipeline with the network and the model replaced and nothing else."""
    return app_module.Pipeline(
        fetch_raster=fetch,
        segment=lambda raster: segmented_outcome,
        classify=classify.classify_corridor,
        vectorize=vectorize.vectorize_corridor,
    )


def _client(pipeline, *, start=None, clock=None, budget_seconds=60.0, session_factory=None, **kw):
    runner = app_module.InProcessJobRunner(
        lambda request: app_module.run_detection(request, pipeline),
        start=start,
        clock=clock,
    )
    application = app_module.create_app(
        pipeline=pipeline,
        runner=runner,
        budget_seconds=budget_seconds,
        session_factory=session_factory,
        **kw,
    )
    return TestClient(application)


def _submit(client, line, **extra):
    body = {"line": line, "par": 4, "tee_sets": [t.__dict__ for t in TEE_SETS], **extra}
    return client.post("/v1/detect", json=body)


# --------------------------------------------------------------------------- #
# Scenario: a valid line returns typed features
# --------------------------------------------------------------------------- #


def test_a_valid_line_returns_features_carrying_kind_confidence_and_acquisition_date(
    corridor,
) -> None:
    """R11, R13. The one typed endpoint, answered through the poll path.

    The classifier and the vectorizer here are the real ones, so `kind` and
    `confidence` are values the pipeline produced from the painted scene rather
    than constants a stub echoed back. The acquisition date rides on every
    feature, which is what lets a proposal carry its provenance after it has been
    lifted out of the collection.
    """
    line, raster, segmented = corridor
    start = ManualStart()
    client = _client(_pipeline(FakeFetch(Ok(raster)), Ok(segmented)), start=start)

    submitted = _submit(client, line)
    assert submitted.status_code == 202, submitted.text
    reference = submitted.json()
    assert reference["status"] == "pending"
    job_id = reference["job_id"]
    assert reference["poll_url"].endswith(job_id)

    # Nothing has run yet: the submit answered a reference, not an answer.
    pending = client.get(reference["poll_url"])
    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"

    start.run_all()

    done = client.get(reference["poll_url"])
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["status"] == "ok"

    features = body["features"]["features"]
    assert features, body
    kinds = {f["properties"]["kind"] for f in features}
    assert {"green", "tee", "bunker", "water"} <= kinds
    for feature in features:
        properties = feature["properties"]
        assert 0.0 <= properties["confidence"] <= 1.0
        assert properties["acquired"] == ACQUIRED.isoformat()
        assert feature["geometry"]["type"] in ("Polygon", "MultiPolygon")


def test_the_default_runner_answers_through_a_real_background_thread(corridor) -> None:
    """The shipped `start` hook, not the hand-driven one the other tests use.

    Every other test drives the job by hand, which would let a broken default
    hook pass the whole file. This one submits with the real threaded default and
    polls until the answer arrives, bounded so a hang fails rather than hangs.
    """
    line, raster, segmented = corridor
    client = _client(_pipeline(FakeFetch(Ok(raster)), Ok(segmented)))

    submitted = _submit(client, line)
    assert submitted.status_code == 202, submitted.text
    poll_url = submitted.json()["poll_url"]

    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        body = client.get(poll_url).json()
        if body["status"] != "pending":
            break
        time.sleep(0.02)
    assert body["status"] == "ok", body
    assert body["features"]["features"]


# --------------------------------------------------------------------------- #
# Scenario: malformed input is a typed validation error, never a 500
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"line": [[-122.0, 37.0]]}, "line"),  # one point is not a line
        ({"line": "not-a-line"}, "line"),
        ({"line": [[-122.0, 37.0], [-122.0, 91.0]]}, "line"),  # off the planet
        ({"line": [[-122.0, 37.0], [-122.001, 37.001]], "par": 42}, "par"),
        ({}, "line"),  # no line at all
    ],
)
def test_a_malformed_request_returns_the_typed_validation_error_not_a_500(body, field) -> None:
    """R11, R12. Bad input is an answer, not a crash.

    FastAPI's own 422 body is a list of pydantic error dicts under `detail`,
    which is a different shape from every other failure this service returns. A
    client that has to branch on which validator rejected it is a client that
    will get one of the branches wrong, so request-validation failures are
    rendered into the same `{status, message, field, detail}` envelope as
    `results.Invalid`.
    """
    fetch = FakeFetch(None)
    client = _client(_pipeline(fetch, None))

    response = client.post("/v1/detect", json=body)

    assert response.status_code == 422, response.text
    payload = response.json()
    assert payload["status"] == "invalid"
    assert payload["field"] == field
    assert payload["message"]
    assert fetch.calls == []


def test_a_line_past_the_corridor_caps_is_refused_without_an_imagery_read(corridor) -> None:
    """R11, KTD11. The caps run before anything is read, and this proves it.

    An authenticated contributor is still an untrusted source of corridor size,
    and the whole value of `build_corridor` bounds-checking without touching
    imagery is lost if the endpoint validates after spawning. The assertion that
    matters is `fetch.calls == []`: not merely that the request was refused, but
    that refusing it cost no STAC query, no SAS token and no COG read.
    """
    line, raster, segmented = corridor
    fetch = FakeFetch(Ok(raster))
    client = _client(_pipeline(fetch, Ok(segmented)))

    # Two points 2 km apart: well past MAX_LINE_LENGTH_METERS, and the corridor
    # around them past the area cap too.
    far = [[-122.0, 37.0], [-122.0, 37.018]]
    response = _submit(client, far)

    assert response.status_code == 422, response.text
    payload = response.json()
    assert payload["status"] == "invalid"
    assert payload["field"] == "line"
    assert payload["detail"]["cap_meters"] == naip.MAX_LINE_LENGTH_METERS
    assert fetch.calls == []


@pytest.mark.parametrize(
    "tee_sets",
    [
        [{"name": f"Set {i}", "yards": 400.0} for i in range(app_module.MAX_TEE_SETS + 1)],
        [{"name": "Blue", "yards": 9_000.0}],
        [{"name": "Blue", "yards": -10.0}],
    ],
)
def test_tee_sets_past_their_bounds_are_a_typed_validation_error(tee_sets) -> None:
    """R11, KTD11. The scorecard is input, so the scorecard is bounded.

    `tee_sets` is not decoration — the yardages feed the tee-matching thresholds
    in `classify_corridor`, so an unbounded list of absurd yardages is both a
    cost surface and a way to make the classifier answer nonsense confidently.
    Eight is past any real card, which lists four or five.
    """
    fetch = FakeFetch(None)
    client = _client(_pipeline(fetch, None))

    response = client.post(
        "/v1/detect",
        json={"line": [[-122.0, 37.0], [-122.001, 37.001]], "tee_sets": tee_sets},
    )

    assert response.status_code == 422, response.text
    assert response.json()["status"] == "invalid"
    assert response.json()["field"] == "tee_sets"
    assert fetch.calls == []


def test_an_unknown_job_reference_is_a_typed_error_rather_than_a_crash() -> None:
    """R12. A stale reference is the normal case, not an exceptional one.

    A contributor who reloads mid-poll, or whose job outlived the container that
    held it, sends a reference nothing knows about. That has to come back in the
    same envelope as every other failure so the client's one result-union handles
    it and the hole stays hand-mappable.
    """
    client = _client(_pipeline(FakeFetch(None), None))

    response = client.get("/v1/detect/does-not-exist")

    assert response.status_code == 422, response.text
    payload = response.json()
    assert payload["status"] == "invalid"
    assert payload["field"] == "job_id"


# --------------------------------------------------------------------------- #
# Scenario: the budget expires through the poll path
# --------------------------------------------------------------------------- #


def test_a_request_past_the_budget_returns_the_typed_timeout_through_the_poll_path(
    corridor,
) -> None:
    """R12, KTD6. The reason the call is asynchronous at all.

    Modal caps a web request at 150 s and redirects past that in a way its own
    docs say does not work with CORS, and a cold GPU container spends tens of
    seconds on boot, torch import, CUDA init and checkpoint load before inference
    begins. A synchronous call would surface that as a transport error — a failed
    fetch with no status to read — and R12 needs a *typed* timeout the client can
    fold into its result union.

    The clock is fake and the work never starts, so this asserts the budget rule
    rather than waiting 60 s to watch it fire.
    """
    line, raster, segmented = corridor
    clock = FakeClock()
    client = _client(
        _pipeline(FakeFetch(Ok(raster)), Ok(segmented)),
        start=lambda work: None,  # spawned and never scheduled: the cold start
        clock=clock,
        budget_seconds=60.0,
    )

    poll_url = _submit(client, line).json()["poll_url"]

    clock.advance(59.0)
    assert client.get(poll_url).json()["status"] == "pending"

    clock.advance(2.0)
    timed_out = client.get(poll_url)

    assert timed_out.status_code == 504, timed_out.text
    payload = timed_out.json()
    assert payload["status"] == "timeout"
    assert payload["elapsed_seconds"] == pytest.approx(61.0)
    assert payload["message"]


def test_the_budget_is_a_parameter_and_never_approaches_modals_hard_ceiling() -> None:
    """KTD6. 60 s is the budget; 150 s is the wall, and it is not a target.

    Stated as a test rather than a comment because the failure mode is silent: a
    budget nudged past Modal's cap turns every slow request into the redirect
    CORS cannot follow, which is exactly the transport error the poll path exists
    to avoid.
    """
    assert app_module.DEFAULT_BUDGET_SECONDS == 60.0
    assert app_module.HARD_CEILING_SECONDS == 150.0
    with pytest.raises(ValueError):
        app_module.create_app(budget_seconds=app_module.HARD_CEILING_SECONDS + 1)


# --------------------------------------------------------------------------- #
# Scenario: no coverage is a success with an empty answer
# --------------------------------------------------------------------------- #


def test_a_bbox_with_no_naip_coverage_returns_the_typed_no_coverage_result(corridor) -> None:
    """R11. NAIP is US-only, so "nothing here" is a routine correct answer.

    200 rather than an error status, with its own `status` string: folded into a
    failure it would tell a contributor mapping a course in Scotland that the
    service broke, and folded into `ok` with an empty feature list it would be
    indistinguishable from a silent bug.
    """
    line, _, _ = corridor
    from service.results import NoCoverage

    start = ManualStart()
    client = _client(
        _pipeline(FakeFetch(NoCoverage("No NAIP imagery covers this location.")), None),
        start=start,
    )

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    response = client.get(poll_url)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "no_coverage"
    assert "NAIP" in payload["message"]


def test_a_corridor_with_no_masks_is_no_coverage_and_still_names_the_imagery(corridor) -> None:
    """R11, R13. Zero masks is the other half of the no-coverage variant.

    Segmentation returning nothing is not a failed request either — a corridor
    over a featureless fairway legitimately holds no proposals. Unlike the
    US-only case the imagery *was* read, so the response still carries it: the
    contributor can put the exact pixels inference saw under the map and judge
    for themselves whether the model missed something or there was nothing there.
    """
    line, raster, _ = corridor
    from service.results import NoCoverage

    start = ManualStart()
    client = _client(
        _pipeline(FakeFetch(Ok(raster)), NoCoverage("No masks survived cleanup.")),
        start=start,
    )

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    payload = client.get(poll_url).json()

    assert payload["status"] == "no_coverage"
    assert payload["detail"]["imagery"]["item_id"] == ITEM_ID
    assert payload["detail"]["imagery"]["acquired"] == ACQUIRED.isoformat()


# --------------------------------------------------------------------------- #
# Scenario: provenance and the corridor raster reference
# --------------------------------------------------------------------------- #


def test_the_response_carries_the_imagery_source_and_the_corridor_raster_reference(
    corridor,
) -> None:
    """R13, and U8's whole input.

    Two separate obligations ride on this block. The *source string and date* are
    changeset provenance: an OSM changeset derived from these proposals has to
    name the imagery it came from. The *signed reference plus WGS84 bounds* is
    what lets U8 draw the exact pixels inference read, rather than the live USGS
    NAIPPlus mosaic the basemap offers — a different product, undated, and so a
    different picture than the model saw.
    """
    line, raster, segmented = corridor
    start = ManualStart()
    client = _client(_pipeline(FakeFetch(Ok(raster)), Ok(segmented)), start=start)

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    payload = client.get(poll_url).json()

    imagery = payload["imagery"]
    assert imagery["source"] == naip.IMAGERY_SOURCE
    assert imagery["acquired"] == ACQUIRED.isoformat()
    assert imagery["item_id"] == ITEM_ID
    assert imagery["asset_href"] == raster.asset_href
    assert imagery["gsd_meters"] == raster.gsd_meters
    assert imagery["crs"] == ITEM_CRS.to_string()

    west, south, east, north = imagery["bounds_wgs84"]
    assert west < east and south < north
    # The bounds are the window that was read, in lon/lat, not the whole item.
    assert imagery["width"] == WIDTH and imagery["height"] == HEIGHT
    expected = raster.bounds_wgs84
    assert [west, south, east, north] == pytest.approx(list(expected))

    # And the same provenance is on the collection, for a viewer that only reads
    # GeoJSON.
    assert payload["features"]["properties"]["source"] == naip.IMAGERY_SOURCE


def test_a_scorecard_tee_set_with_no_mask_is_reported_to_the_client(corridor) -> None:
    """AE7. "We could not find your red tee" is the prompt that gets it drawn.

    `missing_tee_sets` is surfaced at the top level of the response as well as
    inside the FeatureCollection's properties. The duplication is deliberate: the
    collection member is what a plain GeoJSON viewer sees, and the top-level one
    is what a client building a UI prompt should not have to dig into a
    properties bag to find.
    """
    line, raster, segmented = corridor
    start = ManualStart()
    client = _client(_pipeline(FakeFetch(Ok(raster)), Ok(segmented)), start=start)

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    payload = client.get(poll_url).json()

    missing = payload["missing_tee_sets"]
    assert isinstance(missing, list)
    assert missing == payload["features"]["properties"]["missing_tee_sets"]
    # Only two tee masks were painted, so at least one carded set is unmatched.
    assert {entry["name"] for entry in missing}
    assert all({"name", "yards", "key"} <= set(entry) for entry in missing)


# --------------------------------------------------------------------------- #
# Scenario: decisions persist, and nothing is confirmed without a contributor
# --------------------------------------------------------------------------- #


def _geometry(offset: float = 0.0) -> dict:
    x, y = -122.0 + offset, 37.0 + offset
    return {
        "type": "Polygon",
        "coordinates": [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]],
    }


def _provenance() -> dict:
    return {
        "acquired": ACQUIRED.isoformat(),
        "gsd_meters": 0.6,
        "source": naip.IMAGERY_SOURCE,
        "model_id": MODEL_ID,
        "item_id": ITEM_ID,
    }


def test_confirmations_and_rejections_both_persist_through_the_decision_store(
    session_factory, engine
) -> None:
    """R15, KTD10. The record outlives the browser session because it is server-side.

    Both outcomes are written. A rejection is half the training set — the half
    that says what the classifier got wrong — so an endpoint that posted only
    confirmations would satisfy a naive test and hollow out R10.
    """
    client = _client(_pipeline(FakeFetch(None), None), session_factory=session_factory)

    response = client.post(
        "/v1/decisions",
        json={
            "course_id": COURSE_ID,
            "hole_number": HOLE_NUMBER,
            "decisions": [
                {
                    "kind": "green",
                    "outcome": "confirmed",
                    "geometry": _geometry(),
                    "confidence": 0.86,
                    "provenance": _provenance(),
                },
                {
                    "kind": "bunker",
                    "outcome": "rejected",
                    "geometry": _geometry(0.01),
                    "confidence": 0.41,
                    "provenance": _provenance(),
                },
            ],
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ok"
    assert len(payload["recorded"]) == 2
    assert {d["outcome"] for d in payload["recorded"]} == {"confirmed", "rejected"}
    assert payload["recorded"][0]["provenance"]["item_id"] == ITEM_ID

    # And it is genuinely in the database, not only in the response.
    with Session(engine) as session:
        read = store.decisions_for_hole(session, HOLE)
    assert isinstance(read, Ok), read
    assert {d.outcome for d in read.value} == {
        DecisionOutcome.CONFIRMED,
        DecisionOutcome.REJECTED,
    }

    # The read path answers the same records back.
    listed = client.get(f"/v1/decisions/{COURSE_ID}", params={"hole": HOLE_NUMBER})
    assert listed.status_code == 200, listed.text
    assert len(listed.json()["decisions"]) == 2


def test_the_water_in_play_answer_is_accepted_and_read_back(session_factory, engine) -> None:
    """R14. The field the client sends must be a field this endpoint accepts.

    `DecisionBody` forbids extras, so an undeclared `in_play` makes the whole
    batch a 422 — and the client's send path swallows the failure, so a
    contributor would see "Marked in play." while nothing was stored. This posts
    the payload the client actually builds, then reads the row back out of the
    database rather than trusting the response, because a 200 that recorded the
    decision without its in-play answer is the same bug one layer down.

    The green in the same batch carries no answer and must come back `null`, not
    `false`: nobody asked whether a ball can find a green.
    """
    client = _client(_pipeline(FakeFetch(None), None), session_factory=session_factory)

    response = client.post(
        "/v1/decisions",
        json={
            "course_id": COURSE_ID,
            "hole_number": HOLE_NUMBER,
            "decisions": [
                {
                    "kind": "water",
                    "outcome": "confirmed",
                    "geometry": _geometry(),
                    "confidence": 0.72,
                    "in_play": True,
                    "provenance": _provenance(),
                },
                {
                    "kind": "green",
                    "outcome": "confirmed",
                    "geometry": _geometry(0.01),
                    "confidence": 0.9,
                    "provenance": _provenance(),
                },
            ],
        },
    )

    assert response.status_code == 200, response.text
    echoed = {d["kind"]: d["in_play"] for d in response.json()["recorded"]}
    assert echoed == {"water": True, "green": None}

    with Session(engine) as session:
        read = store.decisions_for_hole(session, HOLE)
    assert isinstance(read, Ok), read
    assert {d.kind.value: d.in_play for d in read.value} == {"water": True, "green": None}

    listed = client.get(f"/v1/decisions/{COURSE_ID}", params={"hole": HOLE_NUMBER})
    assert listed.status_code == 200, listed.text
    assert {d["kind"]: d["in_play"] for d in listed.json()["decisions"]} == {
        "water": True,
        "green": None,
    }


def test_a_malformed_decision_is_a_typed_validation_error(session_factory) -> None:
    """R15. The store's own guards, surfaced rather than leaked as a 500."""
    client = _client(_pipeline(FakeFetch(None), None), session_factory=session_factory)

    response = client.post(
        "/v1/decisions",
        json={
            "course_id": COURSE_ID,
            "hole_number": HOLE_NUMBER,
            "decisions": [
                {
                    "kind": "green",
                    "outcome": "confirmed",
                    "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
                    "confidence": 0.9,
                    "provenance": _provenance(),
                }
            ],
        },
    )

    assert response.status_code == 422, response.text
    assert response.json()["status"] == "invalid"
    assert response.json()["field"] == "geometry"


def test_detection_alone_records_nothing_because_only_a_contributor_confirms(
    corridor, session_factory, engine
) -> None:
    """KTD1. The endpoint must never mark anything confirmed on its own.

    Running the whole detection pipeline against a hole leaves the decision store
    empty. Every proposal reaches a human before it becomes a record, and this is
    the test that stops a future convenience — "persist the proposals so the
    review step can look them up" — from quietly writing rows nobody answered.
    """
    line, raster, segmented = corridor
    start = ManualStart()
    client = _client(
        _pipeline(FakeFetch(Ok(raster)), Ok(segmented)),
        start=start,
        session_factory=session_factory,
    )

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    assert client.get(poll_url).json()["status"] == "ok"

    with Session(engine) as session:
        read = store.decisions_for_hole(session, HOLE)
    assert isinstance(read, Ok), read
    assert read.value == ()


def test_a_service_with_no_decision_store_says_so_instead_of_crashing() -> None:
    """R12. A missing database is an operator fault reported in the typed envelope."""
    client = _client(_pipeline(FakeFetch(None), None), session_factory=None)

    response = client.post(
        "/v1/decisions",
        json={"course_id": COURSE_ID, "hole_number": HOLE_NUMBER, "decisions": []},
    )

    assert response.status_code == 502, response.text
    assert response.json()["status"] == "upstream"


# --------------------------------------------------------------------------- #
# Deployment posture
# --------------------------------------------------------------------------- #


def test_a_pipeline_that_raises_becomes_a_typed_upstream_failure(corridor) -> None:
    """R12. An unexpected exception inside the job is still an answer.

    The job runs off the request thread, so an exception there has no HTTP
    response to escape into — without this it would be swallowed and the client
    would poll a job that never finishes until the budget expired, reporting a
    timeout for what was actually a crash.
    """
    line, raster, _ = corridor

    def explode(_raster):
        raise RuntimeError("CUDA out of memory")

    start = ManualStart()
    client = _client(
        app_module.Pipeline(
            fetch_raster=FakeFetch(Ok(raster)),
            segment=explode,
            classify=classify.classify_corridor,
            vectorize=vectorize.vectorize_corridor,
        ),
        start=start,
    )

    poll_url = _submit(client, line).json()["poll_url"]
    start.run_all()
    response = client.get(poll_url)

    assert response.status_code == 502, response.text
    payload = response.json()
    assert payload["status"] == "upstream"
    assert "CUDA out of memory" in payload["cause"]


def test_permissive_cors_is_off_unless_local_development_asks_for_it() -> None:
    """KTD11. Access control lives at the identity proxy, not in the service.

    Permissive CORS is a local-development affordance and nothing else. Shipping
    it on by default would put a wildcard origin in front of a service whose only
    protection is the proxy in front of it — and the flag being explicit is what
    keeps "it works on my machine" from becoming the production posture.
    """
    origin = {"Origin": "http://localhost:5173"}
    closed = _client(_pipeline(FakeFetch(None), None))
    opened = _client(_pipeline(FakeFetch(None), None), allow_local_cors=True)

    assert "access-control-allow-origin" not in closed.get("/healthz", headers=origin).headers
    assert opened.get("/healthz", headers=origin).headers["access-control-allow-origin"] == "*"


def test_the_service_imports_with_neither_torch_nor_modal_installed() -> None:
    """U0's whole argument, held in place.

    `pytest service/` is a real gate only while the endpoint imports in the base
    environment. `segment.py` defers its torch import and `modal_deploy.py` is
    deliberately outside the app's import graph, so importing the app must pull
    in neither. Asserting on `sys.modules` catches the regression at the moment
    someone adds a convenient top-level import.
    """
    assert "service.app" in sys.modules
    assert "torch" not in sys.modules
    assert "modal" not in sys.modules
    assert "service.modal_deploy" not in sys.modules
