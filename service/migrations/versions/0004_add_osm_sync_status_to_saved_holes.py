"""Add osm_sync_status and osm_synced_at to saved_holes.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-19

A saved hole is in our store and not yet in OpenStreetMap: the upload path is
not built. These two columns say so per hole, so the upload can find what it
still owes and mark what it has sent. Every existing row is `pending`, which is
true — nothing has ever been uploaded.

What each feature needs the upload to *do* — create a way, modify one, leave one
alone, or look again at one the contributor disputed — lives in the feature JSON
as `osm_action`, beside the `osm_id` it applies to. No column is needed for it.

Self-contained like the revisions before it: the enum's values are literals here.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OSM_SYNC_STATUSES = ("pending", "synced")


def upgrade() -> None:
    with op.batch_alter_table("saved_holes") as batch:
        batch.add_column(
            sa.Column(
                "osm_sync_status",
                sa.Enum(
                    *OSM_SYNC_STATUSES,
                    name="osm_sync_status",
                    native_enum=False,
                    create_constraint=True,
                    length=32,
                ),
                nullable=False,
                server_default="pending",
            )
        )
        batch.add_column(sa.Column("osm_synced_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("saved_holes") as batch:
        # The enum's CHECK names the column, so it goes first — SQLite's table
        # rebuild otherwise carries a constraint over a column that is gone.
        batch.drop_constraint("osm_sync_status", type_="check")
        batch.drop_column("osm_synced_at")
        batch.drop_column("osm_sync_status")
