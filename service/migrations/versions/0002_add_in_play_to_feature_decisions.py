"""Add in_play: the contributor's judgement that a ball can find this water.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-12

R14 has a proposed water body become a hazard only when a human says a ball can
find it. Spectral classification proposes the water and never decides whether it
counts, so this is the one column in the table that no model could have produced
— which is exactly why it has to be stored rather than re-derived later.

**Nullable, and the three states are genuinely three.** `NULL` means the question
was never asked: every non-water decision, and every row written before this
revision. `false` means it was asked and answered no — the water is real, but it
is not a hazard. `true` is the only value that makes it one. Backfilling `NULL`
to `false` would put a judgement in the training set that nobody ever made, so
the column is added without a default and without touching existing rows.

Adding a column, not an identity. `service/models.py` explains why this table
holds no contributor or session identifier; a feature the contributor judged is
not a fact about the contributor, and the exclusion is unchanged here.

Self-contained like revision 0001: the type is spelled out rather than imported
from `models.py`, so this revision keeps describing the schema as it was when it
was written. `sa.Boolean()` renders as `BOOLEAN` on PostgreSQL, and as `BOOLEAN`
with SQLAlchemy's integer affinity on SQLite, which is what the migration test
applies it to. No CHECK constraint is emitted — `Boolean.create_constraint`
defaults to False since SQLAlchemy 1.4 — which matches the model exactly and
keeps this an `ALTER TABLE ADD COLUMN` that SQLite can apply in place.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "feature_decisions",
        sa.Column("in_play", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("feature_decisions", "in_play")
