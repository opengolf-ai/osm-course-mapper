"""Add saved_holes and saved_boundaries: the mapped course, awaiting upload.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-19

`feature_decisions` is the training record — one row per answered proposal.
These two tables are the mapping record: a whole hole as the contributor saved
it (playing line plus every polygon they kept, with tee sets, OSM tags and, for
proposals, confidence and imagery provenance) and a course boundary they
corrected. Both are append-only; the read path answers the latest save.

**The privacy rule is unchanged and applies to both tables.** No contributor,
session or device identifier — see the note in `service/models.py`. A saved hole
is a fact about a golf course, and the OSM upload will authenticate its own user
when it lands.

Self-contained like 0001 and 0002: every type is spelled out here rather than
imported from `models.py`, with the same dialect variants (`JSONB` on
PostgreSQL, `JSON` on SQLite; `BIGINT` keys that still autoincrement on SQLite)
and the same non-native, CHECK-constrained enum for `line_source`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Literals, not an import of `models.LineSource`, so this revision keeps
#: describing the values that existed when it was written.
LINE_SOURCES = ("drawn", "osm", "osm_edited")


def _key() -> sa.types.TypeEngine:
    return sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _json() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "saved_holes",
        sa.Column("id", _key(), autoincrement=True, nullable=False),
        sa.Column("course_id", sa.String(length=128), nullable=False),
        sa.Column("hole_number", sa.Integer(), nullable=False),
        sa.Column("par", sa.Integer(), nullable=True),
        sa.Column("playing_line", _json(), nullable=False),
        sa.Column(
            "line_source",
            sa.Enum(
                *LINE_SOURCES,
                name="line_source",
                native_enum=False,
                create_constraint=True,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("osm_hole_id", sa.String(length=64), nullable=True),
        sa.Column("features", _json(), nullable=False),
        sa.Column(
            "saved_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # The only read: the latest save of each hole on one course.
    op.create_index("ix_saved_holes_hole", "saved_holes", ["course_id", "hole_number"])

    op.create_table(
        "saved_boundaries",
        sa.Column("id", _key(), autoincrement=True, nullable=False),
        sa.Column("course_id", sa.String(length=128), nullable=False),
        sa.Column("osm_id", sa.String(length=64), nullable=True),
        sa.Column("geometry", _json(), nullable=False),
        sa.Column("edited", sa.Boolean(), nullable=False),
        sa.Column(
            "saved_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_saved_boundaries_course", "saved_boundaries", ["course_id"])


def downgrade() -> None:
    op.drop_index("ix_saved_boundaries_course", table_name="saved_boundaries")
    op.drop_table("saved_boundaries")
    op.drop_index("ix_saved_holes_hole", table_name="saved_holes")
    op.drop_table("saved_holes")
