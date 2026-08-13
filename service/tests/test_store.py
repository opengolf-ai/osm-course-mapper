"""The decision store: what a contributor confirmed, what they rejected, durably.

**These tests run against SQLite, and production is PostgreSQL.** That is a real
gap and it is stated here rather than buried: the test image has no `psycopg` and
no Postgres server, so every behavioural assertion below is made against
SQLite standing in for Postgres. `service/models.py` is written so the two agree
on the things this file asserts — the geometry column is a dialect variant that
is genuinely `JSONB` on Postgres and plain `JSON` here, the primary key is a
variant that autoincrements on both, enums are stored as their string values
rather than as a Postgres native enum type, and the recorded-at default is
computed in Python so it does not depend on which server clock renders
`now()`. What SQLite cannot prove is named in the migration test at the bottom.

Two conventions run through the file:

* **A fresh session is not a fresh database.** The scenario R15 actually cares
  about is a record outliving the process that wrote it, so the persistence test
  uses a temp *file* database and a second `Engine`, not a second `Session` on
  the same in-memory connection. An in-memory SQLite database dies with its
  connection, so reading it back through the same engine would prove nothing.
* **The privacy decision is asserted, not just documented.** The schema
  deliberately holds no contributor or session identifier, and
  `test_no_contributor_or_session_identifier_is_stored` freezes that so a future
  column has to argue with a failing test rather than slip in.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import service
from service import models, store
from service.classify import FeatureKind
from service.models import DecisionOutcome
from service.results import Invalid, Ok, Upstream
from service.vectorize import Provenance

MIGRATIONS_DIR = Path(service.__file__).resolve().parent / "migrations"

HOLE = store.HoleRef(course_id="opengolf-1234", hole_number=7)


def _provenance(acquired: dt.date = dt.date(2023, 7, 4)) -> Provenance:
    return Provenance(
        acquired=acquired,
        gsd_meters=0.6,
        source="USDA NAIP via Microsoft Planetary Computer",
        model_id="facebook/sam2-hiera-large",
        item_id=f"ca_m_3812_{acquired.year}",
    )


def _square(offset: float = 0.0) -> dict:
    """A small WGS84 polygon. Offset so two features are distinguishable."""
    x, y = -123.0 + offset, 36.0 + offset
    return {
        "type": "Polygon",
        "coordinates": [
            [[x, y], [x + 0.001, y], [x + 0.001, y + 0.001], [x, y + 0.001], [x, y]]
        ],
    }


def _decision(
    kind: FeatureKind,
    outcome: DecisionOutcome,
    *,
    offset: float = 0.0,
    confidence: float = 0.86,
    acquired: dt.date = dt.date(2023, 7, 4),
) -> store.DecisionInput:
    return store.DecisionInput(
        kind=kind,
        outcome=outcome,
        geometry=_square(offset),
        confidence=confidence,
        provenance=_provenance(acquired),
    )


@pytest.fixture
def memory_engine():
    """An engine over an in-memory SQLite database with the ORM schema applied.

    Enough for every assertion that does not turn on outliving a connection.
    """
    engine = create_engine("sqlite://")
    models.Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session(memory_engine):
    with Session(memory_engine) as open_session:
        yield open_session


# --------------------------------------------------------------------------- #
# The two outcomes
# --------------------------------------------------------------------------- #


def test_a_confirmed_feature_and_a_rejected_proposal_on_one_hole_both_persist(session) -> None:
    """R10, R15. A rejection is a record, not a discard.

    The confirm/reject sequence is a labelling pipeline only if both answers are
    kept — a store that wrote confirmations and dropped rejections would keep
    exactly the half of the training set that teaches a model nothing about what
    it got wrong. Both rows come back with the geometry they were proposed with
    and the kind they were classified as.
    """
    written = store.record_decisions(
        session,
        HOLE,
        [
            _decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED),
            _decision(FeatureKind.BUNKER, DecisionOutcome.REJECTED, offset=0.01),
        ],
    )
    assert isinstance(written, Ok), written

    read = store.decisions_for_hole(session, HOLE)
    assert isinstance(read, Ok), read
    by_kind = {d.kind: d for d in read.value}
    assert set(by_kind) == {FeatureKind.GREEN, FeatureKind.BUNKER}
    assert by_kind[FeatureKind.GREEN].outcome is DecisionOutcome.CONFIRMED
    assert by_kind[FeatureKind.BUNKER].outcome is DecisionOutcome.REJECTED
    # Geometry survives as GeoJSON, not as a string or a shapely object.
    assert by_kind[FeatureKind.GREEN].geometry == _square()
    assert by_kind[FeatureKind.BUNKER].geometry == _square(0.01)
    assert by_kind[FeatureKind.GREEN].confidence == pytest.approx(0.86)
    # Both were submitted together, so both share one batch.
    assert len({d.batch_id for d in read.value}) == 1


def test_reads_are_scoped_to_one_hole_and_widen_to_the_whole_course(session) -> None:
    """A contributor works hole by hole; the reviewable record spans the round."""
    other_hole = store.HoleRef(course_id=HOLE.course_id, hole_number=8)
    elsewhere = store.HoleRef(course_id="opengolf-9999", hole_number=7)
    store.record_decisions(session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)])
    store.record_decisions(
        session, other_hole, [_decision(FeatureKind.TEE, DecisionOutcome.CONFIRMED)]
    )
    store.record_decisions(
        session, elsewhere, [_decision(FeatureKind.WATER, DecisionOutcome.REJECTED)]
    )

    one_hole = store.decisions_for_hole(session, HOLE)
    assert isinstance(one_hole, Ok), one_hole
    assert [d.kind for d in one_hole.value] == [FeatureKind.GREEN]

    whole_course = store.decisions_for_course(session, HOLE.course_id)
    assert isinstance(whole_course, Ok), whole_course
    assert sorted(d.hole_number for d in whole_course.value) == [7, 8]
    assert all(d.course_id == HOLE.course_id for d in whole_course.value)


# --------------------------------------------------------------------------- #
# Durability
# --------------------------------------------------------------------------- #


def test_records_survive_a_new_engine_and_a_new_session(tmp_path) -> None:
    """R15. Surviving hole navigation is not the bar; surviving the process is.

    KTD10 exists because browser-session state is cleared on hole navigation, so
    a session-only record would hold one hole at most. The corresponding server
    failure is a store whose "durability" is a live connection — which is why
    this uses a temp *file* database, disposes the engine that wrote it, and
    reads through an engine built from scratch.
    """
    url = f"sqlite:///{tmp_path / 'decisions.sqlite'}"

    writer = create_engine(url)
    models.Base.metadata.create_all(writer)
    with Session(writer) as first:
        written = store.record_decisions(
            first,
            HOLE,
            [
                _decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED),
                _decision(FeatureKind.BUNKER, DecisionOutcome.REJECTED, offset=0.01),
            ],
        )
        assert isinstance(written, Ok), written
    writer.dispose()

    reader = create_engine(url)
    with Session(reader) as second:
        read = store.decisions_for_hole(second, HOLE)
    reader.dispose()

    assert isinstance(read, Ok), read
    assert len(read.value) == 2
    assert {d.outcome for d in read.value} == {
        DecisionOutcome.CONFIRMED,
        DecisionOutcome.REJECTED,
    }
    assert {d.kind for d in read.value} == {FeatureKind.GREEN, FeatureKind.BUNKER}
    assert all(d.geometry["type"] == "Polygon" for d in read.value)
    assert all(d.recorded_at.tzinfo is not None for d in read.value)


# --------------------------------------------------------------------------- #
# Provenance
# --------------------------------------------------------------------------- #


def test_imagery_provenance_is_stored_and_a_training_run_can_filter_by_year(session) -> None:
    """R15. A label is only usable if you know which pixels produced it.

    NAIP flies a state every two or three years, and a model fine-tuned on 2019
    labels applied to 2023 imagery is learning last decade's turf. The
    acquisition date is therefore a first-class column rather than a blob inside
    the geometry JSON, so a training export can select a flight window in SQL.
    """
    store.record_decisions(
        session,
        HOLE,
        [
            _decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED, acquired=dt.date(2019, 6, 1)),
            _decision(
                FeatureKind.BUNKER,
                DecisionOutcome.REJECTED,
                offset=0.01,
                acquired=dt.date(2023, 7, 4),
            ),
        ],
    )

    everything = store.decisions_for_hole(session, HOLE)
    assert isinstance(everything, Ok), everything
    one = next(d for d in everything.value if d.kind is FeatureKind.GREEN)
    assert one.provenance.acquired == dt.date(2019, 6, 1)
    assert one.provenance.gsd_meters == pytest.approx(0.6)
    assert one.provenance.source == "USDA NAIP via Microsoft Planetary Computer"
    assert one.provenance.model_id == "facebook/sam2-hiera-large"
    assert one.provenance.item_id == "ca_m_3812_2019"

    recent = store.decisions_for_training(session, acquired_from=dt.date(2022, 1, 1))
    assert isinstance(recent, Ok), recent
    assert [d.kind for d in recent.value] == [FeatureKind.BUNKER]

    # And the outcome is selectable too, since positives and negatives are
    # exported as different halves of a training set.
    rejected = store.decisions_for_training(session, outcome=DecisionOutcome.REJECTED)
    assert isinstance(rejected, Ok), rejected
    assert [d.kind for d in rejected.value] == [FeatureKind.BUNKER]


def test_the_stored_kind_is_the_enum_value_not_its_python_name(session, memory_engine) -> None:
    """A guard on a SQLAlchemy default that would make the table unreadable.

    `sa.Enum` persists a PEP-435 member's *name* unless told otherwise, so a
    green would land in the column as `GREEN` while every other layer in this
    repo — GeoJSON properties, the client, the classifier — calls it `green`. A
    training exporter reading the table directly would then join against nothing.
    """
    store.record_decisions(session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)])
    session.commit()

    with memory_engine.connect() as connection:
        rows = connection.execute(text("SELECT kind, outcome FROM feature_decisions")).all()
    assert rows == [("green", "confirmed")]


def test_the_kind_and_outcome_columns_are_constrained_in_the_database(memory_engine) -> None:
    """The enum is an enum in the table, not only in Python.

    `native_enum=False` on its own produces a bare `VARCHAR` — SQLAlchemy has
    not emitted a CHECK constraint for a non-native enum by default since 1.4 —
    so the column would accept `grene` from anything that reaches the database
    without going through the ORM, which is exactly what a training exporter or
    a backfill script does.
    """
    with memory_engine.begin() as connection:
        with pytest.raises(IntegrityError):
            connection.execute(
                text(
                    "INSERT INTO feature_decisions "
                    "(batch_id, course_id, hole_number, kind, outcome, geometry, "
                    " confidence, imagery_acquired, imagery_gsd_meters, imagery_source, "
                    " imagery_item_id, model_id, recorded_at) "
                    "VALUES ('x', 'c', 1, 'grene', 'confirmed', '{}', 0.5, "
                    "'2023-07-04', 0.6, 's', 'i', 'm', '2023-07-04 00:00:00')"
                )
            )


# --------------------------------------------------------------------------- #
# What the store deliberately does not hold
# --------------------------------------------------------------------------- #


def test_no_contributor_or_session_identifier_is_stored() -> None:
    """KTD10, and the open question the plan left to this unit.

    The store holds what a training run needs and nothing that identifies a
    person. Production sits behind an authenticating identity proxy (KTD11), so
    a contributor identifier is one header away at all times — which is exactly
    why refusing it has to be structural. This test freezes the column set: an
    implementer adding `contributor_id` or `session_id` gets a failing test
    naming the decision rather than a silent new dataset about who mapped what.

    `batch_id` is the deliberate exception and is not a session identifier. It
    is a random UUID minted server-side per `record_decisions` call, so it groups
    one hole's review pass — which a training run needs, to tell a re-review from
    the original — and cannot link two passes to the same person. The input
    dataclass has no field for it, so a client cannot supply a stable one.
    """
    columns = set(models.FeatureDecision.__table__.columns.keys())
    assert columns == {
        "id",
        "batch_id",
        "course_id",
        "hole_number",
        "kind",
        "outcome",
        "geometry",
        "confidence",
        "imagery_acquired",
        "imagery_gsd_meters",
        "imagery_source",
        "imagery_item_id",
        "model_id",
        "recorded_at",
    }, "the decision record's field set is a deliberate privacy decision; see models.py"

    supplied = {field.name for field in dataclasses.fields(store.DecisionInput)}
    assert supplied == {"kind", "outcome", "geometry", "confidence", "provenance"}
    assert {field.name for field in dataclasses.fields(store.HoleRef)} == {
        "course_id",
        "hole_number",
    }


def test_each_write_call_mints_its_own_batch(session) -> None:
    """One batch is one review pass, not one contributor and not one session."""
    first = store.record_decisions(
        session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)]
    )
    second = store.record_decisions(
        session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.REJECTED, offset=0.02)]
    )
    assert isinstance(first, Ok) and isinstance(second, Ok)
    assert first.value[0].batch_id != second.value[0].batch_id


# --------------------------------------------------------------------------- #
# Failure modes
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("hole", "decision", "field_name"),
    [
        (store.HoleRef(course_id="", hole_number=7), None, "course_id"),
        (store.HoleRef(course_id="c", hole_number=0), None, "hole_number"),
        (HOLE, ("geometry", {"type": "Point", "coordinates": [0, 0]}), "geometry"),
        (HOLE, ("geometry", {"type": "Polygon", "coordinates": []}), "geometry"),
        (HOLE, ("confidence", 1.4), "confidence"),
    ],
)
def test_a_malformed_decision_is_rejected_before_anything_is_written(
    session, hole, decision, field_name
) -> None:
    """Typed rejection over a database constraint error, and nothing half-written.

    A batch is one hole's review pass; writing three rows and failing on the
    fourth would leave a partial record that reads as though the contributor
    stopped early.
    """
    candidate = _decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)
    if decision is not None:
        candidate = dataclasses.replace(candidate, **{decision[0]: decision[1]})

    result = store.record_decisions(session, hole, [candidate, candidate])

    assert isinstance(result, Invalid), result
    assert result.field_name == field_name
    assert store.decisions_for_course(session, hole.course_id).value == ()


def test_an_empty_batch_writes_nothing_and_is_not_an_error(session) -> None:
    """A hole a contributor opened and said nothing about is not a failure."""
    result = store.record_decisions(session, HOLE, [])
    assert isinstance(result, Ok), result
    assert result.value == ()


def test_a_database_failure_comes_back_as_upstream_rather_than_raising(memory_engine) -> None:
    """`results.py` names a database failure `Upstream(source="postgres")`.

    The endpoint maps that to a 502 mechanically. A raised `SQLAlchemyError`
    would instead surface as a 500 with a driver traceback, which tells a
    contributor nothing and tells an operator less than the source string does.
    """
    with memory_engine.begin() as connection:
        connection.execute(text("DROP TABLE feature_decisions"))

    with Session(memory_engine) as open_session:
        written = store.record_decisions(
            open_session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)]
        )
        read = store.decisions_for_hole(open_session, HOLE)

    assert isinstance(written, Upstream), written
    assert written.source == "postgres"
    assert written.cause
    assert isinstance(read, Upstream), read


# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #


def test_the_alembic_migration_builds_the_schema_the_orm_expects(tmp_path) -> None:
    """The migration is the schema in production; the ORM only describes it.

    Applied here against SQLite, which proves the revision runs and that the
    table it creates is the one `store.record_decisions` writes to. It does *not*
    prove the PostgreSQL rendering — `JSONB`, `BIGINT` identity, the timestamptz
    column — because there is no Postgres in this image. That is the one gap in
    this file that a deployment has to close.
    """
    url = f"sqlite:///{tmp_path / 'migrated.sqlite'}"
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")

    engine = create_engine(url)
    inspector = inspect(engine)
    assert "feature_decisions" in inspector.get_table_names()
    migrated = {column["name"] for column in inspector.get_columns("feature_decisions")}
    assert migrated == set(models.FeatureDecision.__table__.columns.keys())

    # And the migrated schema actually accepts a write from the store, which is
    # the assertion a column-name comparison alone would not make.
    with Session(engine) as open_session:
        written = store.record_decisions(
            open_session, HOLE, [_decision(FeatureKind.GREEN, DecisionOutcome.CONFIRMED)]
        )
        assert isinstance(written, Ok), written
        read = store.decisions_for_hole(open_session, HOLE)
    engine.dispose()

    assert isinstance(read, Ok), read
    assert read.value[0].geometry == _square()
