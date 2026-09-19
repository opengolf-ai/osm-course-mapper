"""Saved holes and course boundaries: the mapped course, kept until it can upload.

These drive the four endpoints over HTTP against SQLite, exactly as
`test_app.py` drives the decision endpoints — and for the same reason the same
`StaticPool` engine: the store endpoints are plain `def`, Starlette runs them on
a worker thread, and an in-memory SQLite database is per-connection. The gap
between SQLite and PostgreSQL is the one `test_store.py` states; nothing here
depends on a Postgres-only behaviour (the latest-per-hole read uses a window
function both support).

What is asserted, in order: a whole hole round-trips with every field it was
sent; a re-save wins on read without erasing the one before; every rule for
"can this become OSM nodes" comes back as a typed 422 naming the field the
client can fix; a service with no store says so in the typed envelope; and a
boundary round-trips, reading back `null` rather than an error when none was
saved.
"""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from service import holes, models
from service.app import MAX_GEOMETRY_COORDINATES, create_app
from service.models import LineSource
from service.results import Invalid, Ok

COURSE_ID = "course-abc"


# --------------------------------------------------------------------------- #
# Fixtures and payloads
# --------------------------------------------------------------------------- #


@pytest.fixture
def engine():
    """One in-memory SQLite database shared across threads; see the docstring."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    models.Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def client(engine):
    return TestClient(create_app(session_factory=lambda: Session(engine)))


def _square(offset: float = 0.0) -> dict:
    x, y = -122.0 + offset, 37.0 + offset
    return {
        "type": "Polygon",
        "coordinates": [[[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]],
    }


def _line(offset: float = 0.0) -> dict:
    return {
        "type": "LineString",
        "coordinates": [[-122.0 + offset, 37.0], [-121.998 + offset, 37.002]],
    }


def _proposed_green() -> dict:
    return {
        "kind": "green",
        "geometry": _square(0.002),
        "origin": "proposed",
        "edited": True,
        "tee_sets": [],
        "label": None,
        "osm_tags": {"golf": "green"},
        "osm_id": None,
        "osm_action": "create",
        "proposal": {
            "confidence": 0.83,
            "provenance": {
                "acquired": "2023-07-04",
                "gsd_meters": 0.6,
                "source": "naip",
                "model_id": "sam2-hiera-large",
                "item_id": "ca_m_3712201_ne_10_060_20230704",
            },
        },
    }


def _drawn_tee() -> dict:
    return {
        "kind": "tee",
        "geometry": _square(),
        "origin": "drawn",
        "edited": False,
        "tee_sets": [
            {"key": "blue", "name": "Blue", "yards": 412.0},
            {"key": "red", "name": "Red", "yards": None},
        ],
        "label": "Back tee",
        "osm_tags": {"golf": "tee", "tee": "blue;red"},
        "proposal": None,
        "osm_id": None,
        "osm_action": "create",
    }


def _osm_tee() -> dict:
    """A tee box picked off the map: already a way in OpenStreetMap."""
    return {**_drawn_tee(), "origin": "osm", "osm_id": "way/500123", "edited": True, "osm_action": "modify"}


def _hole(hole_number: int = 7, **overrides) -> dict:
    body = {
        "course_id": COURSE_ID,
        "hole_number": hole_number,
        "par": 4,
        "playing_line": _line(),
        "line_source": "osm_edited",
        "osm_hole_id": "way/123",
        "features": [_drawn_tee(), _proposed_green()],
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- #
# Saving and reading holes
# --------------------------------------------------------------------------- #


def test_a_saved_hole_round_trips_with_every_field_it_was_sent(client) -> None:
    """The OSM upload will read this back, so nothing it needs may be dropped."""
    sent = _hole()

    saved = client.post("/v1/holes", json=sent)

    assert saved.status_code == 200, saved.text
    payload = saved.json()
    assert payload["status"] == "ok"
    hole = payload["hole"]
    assert isinstance(hole["id"], int)
    assert hole["saved_at"].endswith("+00:00")
    for key in ("course_id", "hole_number", "par", "playing_line", "line_source", "osm_hole_id"):
        assert hole[key] == sent[key], key
    assert hole["features"] == sent["features"]

    listed = client.get(f"/v1/holes/{COURSE_ID}")
    assert listed.status_code == 200, listed.text
    assert listed.json() == {"status": "ok", "holes": [hole]}


def test_a_tee_picked_off_openstreetmap_keeps_the_element_it_came_from(client) -> None:
    """The upload updates `way/500123` rather than drawing a second tee on top of it."""
    saved = client.post("/v1/holes", json=_hole(features=[_osm_tee()]))

    assert saved.status_code == 200, saved.text
    feature = saved.json()["hole"]["features"][0]
    assert feature["origin"] == "osm"
    assert feature["osm_id"] == "way/500123"
    assert feature["edited"] is True


@pytest.mark.parametrize(
    ("feature", "action"),
    [
        pytest.param({"kind": "bunker", "geometry": _square(), "origin": "drawn"}, "create", id="drawn"),
        pytest.param(
            {"kind": "green", "geometry": _square(), "origin": "osm", "osm_id": "way/1"}, "keep", id="osm-as-is"
        ),
        pytest.param(
            {"kind": "green", "geometry": _square(), "origin": "osm", "osm_id": "way/1", "edited": True},
            "modify",
            id="osm-edited",
        ),
        pytest.param(
            {"kind": "green", "geometry": _square(), "origin": "osm", "osm_id": "way/1", "osm_action": "dispute"},
            "dispute",
            id="osm-disputed",
        ),
    ],
)
def test_every_stored_feature_says_what_the_upload_has_to_do_with_it(client, feature, action) -> None:
    """An omitted `osm_action` is derived, so the upload never has to guess."""
    saved = client.post("/v1/holes", json=_hole(features=[feature]))

    assert saved.status_code == 200, saved.text
    assert saved.json()["hole"]["features"][0]["osm_action"] == action


def test_a_saved_hole_is_pending_until_the_upload_says_otherwise(client) -> None:
    """Our store, not OpenStreetMap: every save reads back as not synced yet."""
    saved = client.post("/v1/holes", json=_hole()).json()["hole"]

    assert saved["osm_sync_status"] == "pending"
    assert saved["osm_synced_at"] is None
    listed = client.get(f"/v1/holes/{COURSE_ID}").json()["holes"][0]
    assert listed["osm_sync_status"] == "pending"


def test_optional_feature_fields_are_filled_in_so_the_read_shape_is_always_complete(
    client,
) -> None:
    """A client may omit `edited`, `tee_sets`, `label` and `osm_tags`; the read never does."""
    minimal = {"kind": "bunker", "geometry": _square(), "origin": "drawn"}

    saved = client.post("/v1/holes", json=_hole(par=None, osm_hole_id=None, features=[minimal]))

    assert saved.status_code == 200, saved.text
    hole = saved.json()["hole"]
    assert hole["par"] is None and hole["osm_hole_id"] is None
    assert hole["features"] == [
        {
            **minimal,
            "edited": False,
            "tee_sets": [],
            "label": None,
            "osm_tags": {},
            "proposal": None,
            "osm_id": None,
            "osm_action": "create",
        }
    ]


def test_a_resave_wins_on_read_without_erasing_the_save_before_it(client, engine) -> None:
    """Append-only: the latest save is the hole's state, and the earlier one survives."""
    first = client.post("/v1/holes", json=_hole(7, line_source="osm", features=[]))
    other = client.post("/v1/holes", json=_hole(3, line_source="drawn", osm_hole_id=None))
    second = client.post("/v1/holes", json=_hole(7, line_source="osm_edited"))
    assert first.status_code == other.status_code == second.status_code == 200

    listed = client.get(f"/v1/holes/{COURSE_ID}").json()["holes"]

    assert [h["hole_number"] for h in listed] == [3, 7]
    assert listed[1]["id"] == second.json()["hole"]["id"]
    assert listed[1]["line_source"] == "osm_edited"
    assert len(listed[1]["features"]) == 2

    with Session(engine) as session:
        stored = session.scalar(select(func.count()).select_from(models.SavedHole))
    assert stored == 3


def test_the_hole_filter_narrows_the_read_to_one_hole(client) -> None:
    client.post("/v1/holes", json=_hole(1))
    client.post("/v1/holes", json=_hole(2))
    client.post("/v1/holes", json=_hole(2, par=5))

    narrowed = client.get(f"/v1/holes/{COURSE_ID}", params={"hole": 2})

    assert narrowed.status_code == 200, narrowed.text
    holes_read = narrowed.json()["holes"]
    assert [(h["hole_number"], h["par"]) for h in holes_read] == [(2, 5)]


def test_reads_are_scoped_to_one_course(client) -> None:
    client.post("/v1/holes", json=_hole(1))
    client.post("/v1/holes", json=_hole(1, course_id="some-other-course"))

    listed = client.get(f"/v1/holes/{COURSE_ID}").json()["holes"]
    nothing = client.get("/v1/holes/never-mapped").json()

    assert [h["course_id"] for h in listed] == [COURSE_ID]
    assert nothing == {"status": "ok", "holes": []}


# --------------------------------------------------------------------------- #
# What a hole save refuses
# --------------------------------------------------------------------------- #


def _with_feature(**changes) -> dict:
    feature = {**_proposed_green(), **changes}
    return _hole(features=[_drawn_tee(), feature])


def _nudged(geometry: dict, position: list) -> dict:
    moved = copy.deepcopy(geometry)
    moved["coordinates"][0][1] = position
    return moved


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param(
            _hole(playing_line={"type": "LineString", "coordinates": [[-122.0, 37.0]]}),
            "playing_line",
            id="line-with-one-point",
        ),
        pytest.param(
            _hole(playing_line={"type": "LineString", "coordinates": [[-122.0, 37.0], [-122, 91]]}),
            "playing_line",
            id="line-latitude-off-the-globe",
        ),
        pytest.param(_with_feature(kind="rough"), "features", id="unknown-kind"),
        pytest.param(_with_feature(proposal=None), "features", id="proposed-without-proposal"),
        pytest.param(
            _hole(features=[{**_drawn_tee(), "proposal": _proposed_green()["proposal"]}]),
            "features",
            id="drawn-with-proposal",
        ),
        pytest.param(
            _hole(features=[{**_osm_tee(), "osm_id": None}]),
            "features",
            id="osm-without-its-id",
        ),
        pytest.param(
            _hole(features=[{**_drawn_tee(), "osm_id": "way/1"}]),
            "features",
            id="drawn-claiming-an-osm-id",
        ),
        pytest.param(
            _hole(features=[{**_osm_tee(), "proposal": _proposed_green()["proposal"]}]),
            "features",
            id="osm-with-proposal",
        ),
        pytest.param(
            _hole(features=[{**_osm_tee(), "osm_action": "create"}]),
            "features",
            id="osm-feature-created-again",
        ),
        pytest.param(
            _hole(features=[{**_drawn_tee(), "osm_action": "dispute"}]),
            "features",
            id="drawn-feature-disputed",
        ),
        pytest.param(
            _hole(features=[{**_drawn_tee(), "osm_action": "delete"}]),
            "features",
            id="unknown-osm-action",
        ),
        pytest.param(
            _with_feature(geometry=_nudged(_square(), [-122.0, 95.0])),
            "features",
            id="feature-latitude-out-of-range",
        ),
        pytest.param(
            _with_feature(geometry=_nudged(_square(), [-181.0, 37.0])),
            "features",
            id="feature-longitude-out-of-range",
        ),
        pytest.param(
            _with_feature(geometry={"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 0]]]}),
            "features",
            id="ring-too-short",
        ),
        pytest.param(
            _with_feature(geometry={"type": "LineString", "coordinates": [[0, 0], [1, 1]]}),
            "features",
            id="feature-not-an-area",
        ),
        pytest.param(_hole(contributor="someone"), "contributor", id="unknown-extra-field"),
        pytest.param(
            _with_feature(osm_tags={"golf": "green", "note": "x" * 256}),
            "features",
            id="osm-tag-value-too-long",
        ),
        pytest.param(_hole(line_source="guessed"), "line_source", id="unknown-line-source"),
        pytest.param(_hole(par=9), "par", id="par-out-of-range"),
        pytest.param(_hole(hole_number=0), "hole_number", id="hole-zero"),
    ],
)
def test_a_hole_that_cannot_become_osm_nodes_is_a_typed_422_naming_the_field(
    client, engine, body, field
) -> None:
    """Refused in the service's envelope, with the field the client can fix — and unwritten."""
    response = client.post("/v1/holes", json=body)

    assert response.status_code == 422, response.text
    payload = response.json()
    assert payload["status"] == "invalid"
    assert payload["field"] == field
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(models.SavedHole)) == 0


def test_a_feature_failure_says_which_feature_and_which_member(client) -> None:
    """`features` alone would leave the client guessing which of twenty shapes to fix."""
    response = client.post("/v1/holes", json=_with_feature(proposal=None))

    detail = response.json()["detail"]
    assert detail == {"index": 1, "member": "proposal"}


def test_a_nan_coordinate_is_refused_rather_than_stored(engine) -> None:
    """Python's JSON reader accepts `NaN`; OSM does not, so neither does the store."""
    line = {"type": "LineString", "coordinates": [[-122.0, 37.0], [float("nan"), 37.0]]}
    hole = holes.HoleInput(
        course_id=COURSE_ID,
        hole_number=1,
        par=None,
        playing_line=line,
        line_source=LineSource.DRAWN,
        osm_hole_id=None,
        features=(),
    )
    with Session(engine) as session:
        result = holes.save_hole(session, hole)
    assert isinstance(result, Invalid), result
    assert result.field_name == "playing_line"


def test_a_geometry_past_the_coordinate_cap_is_refused_before_it_is_walked(client) -> None:
    ring = [[-122.0, 37.0]] * (MAX_GEOMETRY_COORDINATES + 1)
    response = client.post(
        "/v1/holes",
        json=_with_feature(geometry={"type": "Polygon", "coordinates": [ring]}),
    )

    assert response.status_code == 422, response.text
    assert response.json()["field"] == "features"
    assert response.json()["detail"]["cap_coordinates"] == MAX_GEOMETRY_COORDINATES


def test_a_service_with_no_store_answers_every_save_and_read_as_typed_upstream() -> None:
    """R12. A missing database is an operator fault, reported in the envelope."""
    client = TestClient(create_app(session_factory=None))

    responses = [
        client.post("/v1/holes", json=_hole()),
        client.get(f"/v1/holes/{COURSE_ID}"),
        client.post(f"/v1/courses/{COURSE_ID}/boundary", json={"geometry": _square()}),
        client.get(f"/v1/courses/{COURSE_ID}/boundary"),
    ]

    for response in responses:
        assert response.status_code == 502, response.text
        assert response.json()["status"] == "upstream"
        assert response.json()["source"] == "configuration"


# --------------------------------------------------------------------------- #
# Course boundaries
# --------------------------------------------------------------------------- #


def test_a_course_with_no_saved_boundary_reads_back_null_not_an_error(client) -> None:
    response = client.get(f"/v1/courses/{COURSE_ID}/boundary")

    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok", "boundary": None}


def test_a_corrected_boundary_round_trips_and_the_latest_save_wins(client) -> None:
    first = client.post(
        f"/v1/courses/{COURSE_ID}/boundary",
        json={"osm_id": "way/555", "geometry": _square(), "edited": False},
    )
    multipolygon = {"type": "MultiPolygon", "coordinates": [_square()["coordinates"]]}
    second = client.post(
        f"/v1/courses/{COURSE_ID}/boundary",
        json={"osm_id": "way/555", "geometry": multipolygon, "edited": True},
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    saved = second.json()["boundary"]
    assert saved["course_id"] == COURSE_ID
    assert saved["geometry"] == multipolygon
    assert saved["edited"] is True
    assert saved["saved_at"].endswith("+00:00")

    read = client.get(f"/v1/courses/{COURSE_ID}/boundary").json()

    assert read == {"status": "ok", "boundary": saved}
    assert client.get("/v1/courses/elsewhere/boundary").json()["boundary"] is None


def test_edited_defaults_to_true_and_osm_id_to_null_for_a_drawn_boundary(client) -> None:
    saved = client.post(f"/v1/courses/{COURSE_ID}/boundary", json={"geometry": _square()})

    assert saved.status_code == 200, saved.text
    assert saved.json()["boundary"]["edited"] is True
    assert saved.json()["boundary"]["osm_id"] is None


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"geometry": _nudged(_square(), [-122.0, -91.0])}, "geometry"),
        ({"geometry": {"type": "Point", "coordinates": [0, 0]}}, "geometry"),
        ({"geometry": _square(), "course_id": "x"}, "course_id"),
    ],
)
def test_a_boundary_that_cannot_become_osm_nodes_is_a_typed_422(client, body, field) -> None:
    response = client.post(f"/v1/courses/{COURSE_ID}/boundary", json=body)

    assert response.status_code == 422, response.text
    assert response.json()["status"] == "invalid"
    assert response.json()["field"] == field
    assert client.get(f"/v1/courses/{COURSE_ID}/boundary").json()["boundary"] is None


def test_the_store_functions_answer_ok_none_for_a_missing_boundary(engine) -> None:
    with Session(engine) as session:
        result = holes.latest_boundary(session, COURSE_ID)
    assert isinstance(result, Ok)
    assert result.value is None
