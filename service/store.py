"""Write and read the contributor decisions that KTD10 makes durable.

This is the whole surface U5 talks to. The client never reaches the database
directly — it posts decisions to the endpoint and the endpoint calls the four
functions below — so the store's job is to be a small, typed, honest boundary
rather than a general-purpose data-access layer.

**Shapes in, shapes out.** `DecisionInput` is what the endpoint assembles from a
proposal the contributor answered: it holds exactly the proposal's own fields
(`kind`, `geometry`, `confidence`, `provenance`, all straight off
`vectorize.ProposedFeature`) plus the answer — the outcome, and for water the
contributor's in-play judgement, which no model produces. `RecordedDecision` is
what comes back, and it reassembles a `vectorize.Provenance` rather than
returning five flat columns — the caller already knows that type, and a store
that invented a second representation of provenance would put the mapping in the
endpoint.

**Session in, never a connection string.** Every function takes a `Session` the
caller opened. Nothing here reads an environment variable, at import time or at
all: U5 owns the engine, the pool and the request-scoped session, and the tests
supply their own SQLite session. `engine_for_url` exists as a one-line
convenience for whoever does own that lifecycle, and it takes the URL as an
argument.

**The one thing this module does own is the commit.** `record_decisions` commits,
because a decision store whose entire justification is "the record survives the
browser session" must not depend on a caller remembering to flush. There is
nothing to compose the write with — one call is one hole's review pass, which is
the transaction — and a lost commit would fail silently in exactly the way KTD10
exists to prevent. On any database error the session is rolled back so a partial
batch never lingers in it.

**Failures are `results.py` variants, not exceptions.** Malformed input comes
back as `Invalid` with the offending field named, and it is checked before a
single row is added: a batch that wrote three rows and failed on the fourth would
leave a record that reads as though the contributor stopped early. Anything
SQLAlchemy raises becomes `Upstream(source="postgres")`, which the endpoint maps
to a 502 mechanically instead of leaking a driver traceback as a 500.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from service.classify import FeatureKind
from service.models import DecisionOutcome, FeatureDecision
from service.results import Invalid, Ok, Result, Upstream
from service.vectorize import Provenance

#: The geometry types a proposal can be. U4 only ever emits `Polygon` — it
#: reduces multi-part masks to their largest part — but a contributor-edited
#: shape arriving as a `MultiPolygon` is a record worth keeping rather than a
#: reason to refuse the write.
STORABLE_GEOMETRY_TYPES = ("Polygon", "MultiPolygon")


@dataclass(frozen=True)
class HoleRef:
    """Which hole a batch of decisions is about.

    The course record's own identifiers, carried opaquely: `course_id` is the
    OpenGolf id the client already holds (`src/api/types.ts`), `hole_number` is
    the number on the card. Deliberately not a contributor, a device or a
    session — see the privacy note in `models.py` for why that matters here.
    """

    course_id: str
    hole_number: int


@dataclass(frozen=True)
class DecisionInput:
    """One answered proposal, as the endpoint hands it to the store.

    Every field is either the proposal's own (`kind`, `geometry`, `confidence`,
    `provenance` come off `vectorize.ProposedFeature` unchanged) or the answer
    itself. There is deliberately no field for a contributor, a session or a
    batch id: a client cannot supply one, so the schema's privacy decision cannot
    be undone by a caller passing an extra argument.
    """

    kind: FeatureKind
    outcome: DecisionOutcome
    geometry: dict[str, Any]
    confidence: float
    provenance: Provenance
    #: R14's in-play answer, when the contributor was asked one. `None` is not a
    #: default so much as a third state: the question is only put for water, so
    #: `None` means "never asked" and `False` means "asked, and a ball cannot
    #: find it". See `models.in_play` for why the distinction is kept.
    in_play: bool | None = None


@dataclass(frozen=True)
class RecordedDecision:
    """One decision as it exists in the store, on the way back out.

    A plain frozen dataclass rather than the ORM object so callers cannot lazily
    load, mutate or accidentally hold a row past its session — and so the
    endpoint serializes a value it can see the whole of.
    """

    id: int
    batch_id: uuid.UUID
    course_id: str
    hole_number: int
    kind: FeatureKind
    outcome: DecisionOutcome
    geometry: dict[str, Any]
    confidence: float
    provenance: Provenance
    in_play: bool | None
    recorded_at: dt.datetime


def engine_for_url(database_url: str, **engine_kwargs: Any) -> Engine:
    """An `Engine` for a database URL the caller supplies.

    A convenience, not a policy: the URL is an argument because nothing in this
    module may read configuration. `pool_pre_ping` is on by default because the
    service is deployed with scale-to-zero and a pooled connection that has been
    idle across a container's whole lifetime is the normal case, not the
    exception — without it the first write after a scale-up fails on a stale
    socket rather than reconnecting.
    """
    engine_kwargs.setdefault("pool_pre_ping", True)
    return create_engine(database_url, **engine_kwargs)


def _validate(hole: HoleRef, decisions: Sequence[DecisionInput]) -> Invalid | None:
    """Everything wrong with a batch, checked before anything is written.

    Returns the first problem or `None`. The checks are the ones a database
    constraint would otherwise raise as an opaque `IntegrityError` halfway
    through the batch: an unusable hole reference, a geometry that is not an
    area, a confidence outside the range U3 produces.
    """
    if not hole.course_id.strip():
        return Invalid(
            "A decision must say which course it is about.",
            field_name="course_id",
        )
    if hole.hole_number < 1:
        return Invalid(
            "Hole numbers start at 1.",
            field_name="hole_number",
            detail={"hole_number": hole.hole_number},
        )

    for index, decision in enumerate(decisions):
        geometry = decision.geometry
        if not isinstance(geometry, dict) or geometry.get("type") not in STORABLE_GEOMETRY_TYPES:
            return Invalid(
                "A decision's geometry must be a GeoJSON Polygon or MultiPolygon.",
                field_name="geometry",
                detail={"index": index, "type": (geometry or {}).get("type")},
            )
        if not geometry.get("coordinates"):
            return Invalid(
                "A decision's geometry has no coordinates.",
                field_name="geometry",
                detail={"index": index},
            )
        if not 0.0 <= decision.confidence <= 1.0:
            return Invalid(
                "Confidence is a probability between 0 and 1.",
                field_name="confidence",
                detail={"index": index, "confidence": decision.confidence},
            )
    return None


def _to_row(hole: HoleRef, decision: DecisionInput, batch_id: uuid.UUID) -> FeatureDecision:
    return FeatureDecision(
        batch_id=batch_id,
        course_id=hole.course_id,
        hole_number=hole.hole_number,
        kind=decision.kind,
        outcome=decision.outcome,
        geometry=decision.geometry,
        confidence=float(decision.confidence),
        in_play=decision.in_play,
        imagery_acquired=decision.provenance.acquired,
        imagery_gsd_meters=float(decision.provenance.gsd_meters),
        imagery_source=decision.provenance.source,
        imagery_item_id=decision.provenance.item_id,
        model_id=decision.provenance.model_id,
    )


def _from_row(row: FeatureDecision) -> RecordedDecision:
    return RecordedDecision(
        id=row.id,
        batch_id=row.batch_id,
        course_id=row.course_id,
        hole_number=row.hole_number,
        kind=FeatureKind(row.kind),
        outcome=DecisionOutcome(row.outcome),
        geometry=row.geometry,
        confidence=row.confidence,
        provenance=Provenance(
            acquired=row.imagery_acquired,
            gsd_meters=row.imagery_gsd_meters,
            source=row.imagery_source,
            model_id=row.model_id,
            item_id=row.imagery_item_id,
        ),
        in_play=row.in_play,
        recorded_at=as_utc(row.recorded_at),
    )


def as_utc(moment: dt.datetime) -> dt.datetime:
    """Guarantee an aware UTC timestamp on the way out.

    SQLite has no timestamp type and hands back whatever it stored, so a row
    written by something other than the ORM path — a hand-inserted fixture, the
    `server_default` — can come back naive. Postgres never does. Normalising
    here means a caller never has to ask which database it is talking to before
    comparing two timestamps.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=dt.UTC)
    return moment


def _run(
    session: Session, statement: Select[Any], what: str
) -> Result[tuple[RecordedDecision, ...]]:
    """Execute a read, folding driver failures into `Upstream`."""
    try:
        rows = session.execute(statement).scalars().all()
    except SQLAlchemyError as error:
        return Upstream(
            f"The decision store could not be read while {what}.",
            source="postgres",
            cause=str(error),
        )
    return Ok(tuple(_from_row(row) for row in rows))


def record_decisions(
    session: Session,
    hole: HoleRef,
    decisions: Iterable[DecisionInput],
) -> Result[tuple[RecordedDecision, ...]]:
    """Persist one hole's review pass: every confirmation and every rejection.

    Both outcomes are written. R10 is explicit that a rejection is a record
    rather than a discard — it is the half of the training set that says what the
    classifier got wrong — and a store that quietly kept only confirmations would
    satisfy the endpoint's tests and hollow out the requirement.

    The whole batch shares one `batch_id`, minted here and never taken from the
    caller. It marks "these were submitted together", so a later re-review of the
    same hole is distinguishable from the original pass instead of merging into
    it. It is not a session identifier and cannot be used as one; `models.py`
    says why that distinction is load-bearing.

    An empty batch is `Ok(())` and touches nothing. A hole a contributor opened
    and said nothing about is not a failure, and writing a marker row for it
    would put an un-labelled example into the training set.

    Commits on success, rolls back on failure — see the module docstring for why
    this function owns its transaction while the caller owns the session.
    """
    batch = list(decisions)
    invalid = _validate(hole, batch)
    if invalid is not None:
        return invalid
    if not batch:
        return Ok(())

    batch_id = uuid.uuid4()
    rows = [_to_row(hole, decision, batch_id) for decision in batch]
    try:
        session.add_all(rows)
        # Flush, read, then commit. The flush is what assigns the surrogate keys
        # and applies the Python-side defaults, so the rows can be converted
        # while they still hold their values — a `Session` expires its instances
        # on commit by default, and converting afterwards would issue one
        # re-SELECT per row to fetch back what we just wrote.
        session.flush()
        recorded = tuple(_from_row(row) for row in rows)
        session.commit()
    except SQLAlchemyError as error:
        session.rollback()
        return Upstream(
            "The decision store could not record this hole's decisions.",
            source="postgres",
            cause=str(error),
        )
    return Ok(recorded)


def decisions_for_hole(session: Session, hole: HoleRef) -> Result[tuple[RecordedDecision, ...]]:
    """Every decision ever recorded on one hole, oldest first.

    Every decision, not the latest per feature: a contributor who rejected a
    bunker in one pass and confirmed it in the next has said two things, and the
    store's job is to have both. Deduplicating is the consumer's call, and the
    `batch_id` plus `recorded_at` are what it needs to make it.
    """
    statement = (
        select(FeatureDecision)
        .where(
            FeatureDecision.course_id == hole.course_id,
            FeatureDecision.hole_number == hole.hole_number,
        )
        .order_by(FeatureDecision.recorded_at, FeatureDecision.id)
    )
    return _run(session, statement, "reading a hole's decisions")


def decisions_for_course(
    session: Session, course_id: str
) -> Result[tuple[RecordedDecision, ...]]:
    """Every decision recorded across one course, by hole then by time.

    A contributor works hole by hole but the reviewable record is the round, so
    the endpoint needs this to answer "what has been mapped here so far" without
    eighteen round trips.
    """
    statement = (
        select(FeatureDecision)
        .where(FeatureDecision.course_id == course_id)
        .order_by(
            FeatureDecision.hole_number, FeatureDecision.recorded_at, FeatureDecision.id
        )
    )
    return _run(session, statement, "reading a course's decisions")


def decisions_for_training(
    session: Session,
    *,
    acquired_from: dt.date | None = None,
    acquired_to: dt.date | None = None,
    outcome: DecisionOutcome | None = None,
    kind: FeatureKind | None = None,
    limit: int | None = None,
) -> Result[tuple[RecordedDecision, ...]]:
    """The export path: decisions selected by imagery vintage, outcome and kind.

    This is the read KTD9's labelling-pipeline argument is actually about, and
    the filters are the ones a fine-tuning run needs rather than a generic query
    builder:

    * **Acquisition window.** NAIP re-flies a state every two or three years and
      the imagery changes materially between flights, so a run either pins a
      vintage or knowingly mixes them. Filtering on `imagery_acquired` is why
      provenance is a flat indexed column instead of a key inside the geometry
      JSON.
    * **Outcome.** Positives and negatives are different halves of a training
      set and are almost never wanted in one query.
    * **Kind.** A per-class run — "everything anyone has ever said about a
      bunker" — is the common shape.

    Ordered by acquisition then id so an export is reproducible across runs.
    Course and hole are deliberately not filters here: this read is about
    imagery and labels, and `decisions_for_course` already covers the other
    question.
    """
    statement = select(FeatureDecision)
    if acquired_from is not None:
        statement = statement.where(FeatureDecision.imagery_acquired >= acquired_from)
    if acquired_to is not None:
        statement = statement.where(FeatureDecision.imagery_acquired <= acquired_to)
    if outcome is not None:
        statement = statement.where(FeatureDecision.outcome == outcome)
    if kind is not None:
        statement = statement.where(FeatureDecision.kind == kind)
    statement = statement.order_by(FeatureDecision.imagery_acquired, FeatureDecision.id)
    if limit is not None:
        statement = statement.limit(limit)
    return _run(session, statement, "exporting decisions for training")
