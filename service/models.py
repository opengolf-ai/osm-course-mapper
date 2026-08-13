"""The table one contributor decision lands in, and what it is allowed to say.

KTD10 puts confirmations and rejections in a database rather than in browser
state, for two reasons that pull in the same direction. Browser-session state is
cleared on hole navigation, so a session-only record would hold one hole at most
and the labelling-pipeline argument behind KTD9 would be notional. And a durable
record decouples *capturing* contributor work from *shipping* the OpenStreetMap
write path, which this plan defers: rows accumulate now, the upload path consumes
them whenever it lands.

This module is the schema and nothing else. The functions U5 calls live in
`store.py`, so nobody has to import a `Session` to look at what a decision is.

--------------------------------------------------------------------------- #
WHAT A DECISION RECORD MAY CARRY — the deliberate part
--------------------------------------------------------------------------- #

**This table holds no contributor identifier and no session identifier, and that
is a decision rather than an omission.**

R15 asks for geometry, classified kind and imagery provenance. R10 asks that
rejections be kept so they can seed later training. Neither needs to know *who*
decided — a fine-tuning run reads pixels, a polygon, a label and a flight date,
and an identity column would be dead weight in every query it ever runs.

The reason to say so loudly is that attaching one would be effortless and
invisible. Production sits behind an authenticating identity proxy (KTD11), so a
verified contributor identity is present on every request that reaches this
service. An implementer wiring the endpoint would only have to pass a header
through, and from that day the project would hold a contributor-behaviour dataset
— what each person accepted, what they rejected, how fast they worked, which
holes they gave up on — that it never decided to hold, and that would be
discoverable, breach-exposed and repurposable long after the reason for adding
the column was forgotten. Storing what the training use case needs and nothing
that identifies a person is the version of this table that can be justified from
first principles, so it is the version that exists.

Two consequences to accept with open eyes:

* **Decisions cannot be attributed or revoked per contributor.** If someone asks
  "delete everything I labelled", the answer is that nothing here is linked to
  them — which is also why the request cannot arise as a data-protection matter.
* **OSM attribution is unaffected.** Nothing uploads in this plan. When the write
  path lands it authenticates its own OSM user and the changeset carries that
  attribution; it does not need this table to remember one.

`batch_id` is the single grouping column, and it is deliberately *not* a session
identifier. `store.record_decisions` mints a fresh random UUID per call and the
input types have no field for one, so a client cannot supply a stable value. It
answers "these decisions were submitted together", which a training export needs
in order to tell a re-review of a hole from the original pass — and it cannot
link two passes to the same person.

`in_play` is a judgement the contributor made, not a fact about the contributor,
and the distinction is the whole line this schema draws. R14 needs to know that
*someone* said a ball can find this water; it never needs to know who, and the
column carries no way to find out.

`recorded_at` is the one field that carries any timing information. It is kept
because a store nobody can order or age out is not reviewable and not
operable, and because a training export selecting a flight window also wants to
know when the labels were made. Named here rather than left incidental: with no
identity column, a timestamp groups nothing about a person on its own.

--------------------------------------------------------------------------- #
POSTGRES IS THE TARGET; SQLITE IS WHAT THE TESTS HAVE
--------------------------------------------------------------------------- #

The database is PostgreSQL. The test image has no `psycopg` and no server, so
`service/tests/test_store.py` runs against SQLite. Every column below is chosen
so the two dialects agree on the behaviour those tests assert, and the three
places they would otherwise diverge are handled explicitly:

* **JSON.** `JSONB` on Postgres — indexable, binary, the right choice for
  geometry we will query later — and plain `JSON` elsewhere, via `with_variant`.
  Declared as a variant rather than as `JSON` everywhere so the production schema
  is genuinely JSONB rather than whatever the tests happened to need.
* **The primary key.** `BIGINT` on Postgres; SQLite only auto-assigns a rowid
  when the declared type is exactly `INTEGER`, so a bare `BigInteger` primary key
  would insert `NULL` there. The variant keeps both working.
* **Defaults.** `recorded_at` is computed in Python, not by the server. Postgres'
  `now()` returns an aware timestamptz and SQLite's `CURRENT_TIMESTAMP` returns a
  naive UTC string, so a server default would hand back two different types from
  the same code. A `server_default` is kept alongside it only so a row inserted
  by hand outside the ORM still gets a timestamp.

`geometry` is JSON rather than a PostGIS `geometry` column on purpose. PostGIS is
not a declared dependency and this table's job is fidelity of record, not spatial
query: rows are written once and read back as the GeoJSON they arrived as. If a
later use wants spatial indexing, the migration path is to add a generated
geometry column beside this one rather than to have stored a lossy conversion
from the start.
"""

from __future__ import annotations

import datetime as dt
import uuid
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    Index,
    Integer,
    String,
    Uuid,
    func,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from service.classify import FeatureKind


class DecisionOutcome(StrEnum):
    """What the contributor said about one proposal.

    Two values and no third. "Skipped" is not an outcome: a proposal a
    contributor never answered produces no row at all, and inventing a value for
    it would put un-labelled examples into a training set as though they were
    labelled ones.

    A `StrEnum` to match `FeatureKind`, so the endpoint serializes it to JSON
    with no mapping table.
    """

    CONFIRMED = "confirmed"
    REJECTED = "rejected"


#: GeoJSON storage: genuinely `JSONB` on PostgreSQL, plain `JSON` elsewhere.
#: See the module docstring for why the variant rather than one type everywhere.
GeoJSON = JSON().with_variant(postgresql.JSONB(), "postgresql")

#: A 64-bit surrogate key on PostgreSQL that still autoincrements on SQLite,
#: which only assigns a rowid to a column declared exactly `INTEGER`.
SurrogateKey = BigInteger().with_variant(Integer(), "sqlite")


def _string_enum(enum_class: type[StrEnum], name: str) -> Enum:
    """A portable enum column storing the member's *value*, not its name.

    Two defaults are overridden, and both would bite:

    * `values_callable` — SQLAlchemy persists a PEP-435 member's `.name` unless
      told otherwise, so `FeatureKind.GREEN` would land in the column as `GREEN`
      while GeoJSON properties, the client and the classifier all say `green`. A
      training exporter reading the table directly would join against nothing.
    * `native_enum=False` — a Postgres native `ENUM` type is a separate object
      that needs its own `ALTER TYPE` migration every time a kind is added, and a
      `VARCHAR` with a `CHECK` constraint gives the same validation with an
      ordinary constraint change.
    * `create_constraint=True` — and this one is not redundant with the line
      above. Since SQLAlchemy 1.4 a non-native `Enum` defaults to emitting *no*
      constraint at all, so `native_enum=False` on its own buys a bare `VARCHAR`
      that will accept `"grene"` forever. The check is what makes the column an
      enum on both dialects rather than only in Python.
    """
    return Enum(
        enum_class,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=32,
        validate_strings=True,
        values_callable=lambda members: [member.value for member in members],
    )


class Base(DeclarativeBase):
    """Declarative base for the decision store.

    Its own base rather than one shared with anything else: this is the only
    persistent table the detection service owns, and `Base.metadata` is what the
    Alembic migration compares against.
    """


class FeatureDecision(Base):
    """One contributor decision about one proposed feature on one hole.

    The grain is deliberately per *feature*, not per hole and not per review
    session. R7 has the contributor confirm one proposal at a time, so one
    decision is the smallest thing a human actually said — and a per-hole row
    would have to fold five yeses and two noes into a blob that no training query
    could filter.

    Rows are append-only in practice. A contributor who re-reviews a hole writes
    a second batch rather than updating the first, because "they changed their
    mind" is itself a label worth keeping and an in-place update would erase it.
    Nothing enforces that here beyond the absence of an update path in
    `store.py`.
    """

    __tablename__ = "feature_decisions"

    id: Mapped[int] = mapped_column(SurrogateKey, primary_key=True, autoincrement=True)

    #: Groups the decisions submitted in one `record_decisions` call. Minted
    #: server-side, never accepted from a client. See the module docstring for
    #: why this is not a session identifier.
    batch_id: Mapped[uuid.UUID] = mapped_column(Uuid(), nullable=False, default=uuid.uuid4)

    #: Hole identity, as the course record already expresses it: the OpenGolf
    #: course id (an opaque string, see `src/api/types.ts`) and the hole number.
    #: Stored as two plain columns rather than a foreign key because the course
    #: catalogue is a different service's data and this table must not need it to
    #: be reachable in order to accept a write.
    course_id: Mapped[str] = mapped_column(String(128), nullable=False)
    hole_number: Mapped[int] = mapped_column(Integer(), nullable=False)

    kind: Mapped[FeatureKind] = mapped_column(
        _string_enum(FeatureKind, "feature_kind"), nullable=False
    )
    outcome: Mapped[DecisionOutcome] = mapped_column(
        _string_enum(DecisionOutcome, "decision_outcome"), nullable=False
    )

    #: R14's in-play answer: whether a ball can find this water. Nullable, and
    #: the three states are genuinely three. `NULL` means the question was never
    #: asked — every non-water decision, and the water rows written before this
    #: column existed. `False` means it was asked and answered no: the water is
    #: real but it is not a hazard. `True` is the only value that makes it one.
    #: Collapsing `NULL` into `False` would tell a training run that a green was
    #: judged out of play, which nobody ever said. Only a human can answer this —
    #: spectral classification proposes water and never decides whether it counts
    #: — so it is stored beside the outcome rather than derived from the kind.
    in_play: Mapped[bool | None] = mapped_column(Boolean(), nullable=True)

    #: The GeoJSON Polygon in WGS84 exactly as it was proposed and shown — the
    #: shape the contributor answered about, not a re-derived one.
    geometry: Mapped[dict[str, Any]] = mapped_column(GeoJSON, nullable=False)

    #: U3's confidence for the proposal, kept because the interesting training
    #: signal is where confidence and outcome disagree: high-confidence
    #: rejections are where the classifier is confidently wrong.
    confidence: Mapped[float] = mapped_column(Float(), nullable=False)

    #: Imagery provenance, flattened rather than nested in the geometry JSON so a
    #: training export can filter a flight window in SQL. `imagery_acquired` is
    #: the column that scenario turns on and is indexed below.
    imagery_acquired: Mapped[dt.date] = mapped_column(Date(), nullable=False)
    imagery_gsd_meters: Mapped[float] = mapped_column(Float(), nullable=False)
    imagery_source: Mapped[str] = mapped_column(String(255), nullable=False)
    imagery_item_id: Mapped[str] = mapped_column(String(255), nullable=False)

    #: The segmentation model that produced the mask. Provenance in the same
    #: sense as the imagery: a label is only reproducible if you know which model
    #: proposed the shape a human was answering about.
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)

    recorded_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: dt.datetime.now(dt.UTC),
        server_default=func.now(),
    )

    __table_args__ = (
        # The read path U5 calls on every hole, and the one it calls to show a
        # contributor the round so far.
        Index("ix_feature_decisions_hole", "course_id", "hole_number"),
        # The training export: "every decision on imagery flown since 2022".
        Index("ix_feature_decisions_imagery_acquired", "imagery_acquired"),
    )
