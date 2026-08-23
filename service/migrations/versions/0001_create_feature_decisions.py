"""Create feature_decisions: the durable record of every contributor decision.

Revision ID: 0001
Revises:
Create Date: 2026-08-12

The first and, at the time of writing, only table the detection service owns.
See `service/models.py` for what this schema deliberately does and does not
hold — in particular, **there is no contributor or session identifier here, and
that is a decision.** Adding one is a schema change that should have to argue
for itself in review rather than appear as a nullable column somebody found
convenient.

Written self-contained: the column types are spelled out here rather than
imported from `models.py`, because a migration records what the schema was at
this revision and one that read the current model definitions would change
meaning every time the model did.

The two dialect variants below exist for the same reason they exist in the
model. `JSONB` is the right geometry column on PostgreSQL, which is what this
service deploys against; `JSON` is what SQLite has, which is what the test image
can apply this revision to. `BIGINT` is the right surrogate key on PostgreSQL;
SQLite only auto-assigns a rowid to a column declared exactly `INTEGER`, so a
bare `BigInteger` primary key would insert NULL there and the migration test
would prove nothing about a schema anyone can write to.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Kept as literals rather than imported from `service.classify` so this
#: revision keeps describing the kinds that existed when it was written. A later
#: kind is a later migration.
FEATURE_KINDS = ("green", "tee", "bunker", "water", "fairway", "unknown")
DECISION_OUTCOMES = ("confirmed", "rejected")


def upgrade() -> None:
    op.create_table(
        "feature_decisions",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.String(length=128), nullable=False),
        sa.Column("hole_number", sa.Integer(), nullable=False),
        # native_enum=False plus create_constraint=True renders VARCHAR with a
        # CHECK on both dialects, so adding a kind is an ordinary constraint
        # change rather than an ALTER TYPE against a separate PostgreSQL enum
        # object. `create_constraint` is not redundant: since SQLAlchemy 1.4 a
        # non-native Enum emits no constraint unless it is asked to, which would
        # leave a bare VARCHAR that accepts any string.
        sa.Column(
            "kind",
            sa.Enum(
                *FEATURE_KINDS,
                name="feature_kind",
                native_enum=False,
                create_constraint=True,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "outcome",
            sa.Enum(
                *DECISION_OUTCOMES,
                name="decision_outcome",
                native_enum=False,
                create_constraint=True,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "geometry",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            nullable=False,
        ),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("imagery_acquired", sa.Date(), nullable=False),
        sa.Column("imagery_gsd_meters", sa.Float(), nullable=False),
        sa.Column("imagery_source", sa.String(length=255), nullable=False),
        sa.Column("imagery_item_id", sa.String(length=255), nullable=False),
        sa.Column("model_id", sa.String(length=255), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # The endpoint's read path: one hole, and the whole course by prefix.
    op.create_index(
        "ix_feature_decisions_hole", "feature_decisions", ["course_id", "hole_number"]
    )
    # The training export's read path: a NAIP flight window.
    op.create_index(
        "ix_feature_decisions_imagery_acquired", "feature_decisions", ["imagery_acquired"]
    )


def downgrade() -> None:
    op.drop_index("ix_feature_decisions_imagery_acquired", table_name="feature_decisions")
    op.drop_index("ix_feature_decisions_hole", table_name="feature_decisions")
    op.drop_table("feature_decisions")
