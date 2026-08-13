"""Alembic's entry point for the decision store's schema.

This is the *one* place in the service that reads a database URL from the
environment, and that is deliberate rather than an exception to the rule. Every
other module takes a `Session` or an `Engine` from its caller because the
service owns its connection lifecycle; Alembic runs as its own process with no
caller to take one from, so it reads `DATABASE_URL` — unless the URL was set
programmatically on the config, which is how the tests point it at a temp
SQLite file.

`service.models.Base.metadata` is the comparison target, so `alembic revision
--autogenerate` sees the ORM's view of the schema. The revisions themselves are
written to be self-contained rather than to import from `models.py`: a migration
is a snapshot of what the schema was at that moment, and one that imported the
current model definitions would silently change meaning every time the model did.
"""

from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from service.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    """The URL to migrate: whatever the caller configured, else the environment."""
    configured = config.get_main_option("sqlalchemy.url")
    if configured:
        return configured
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "No database URL. Set DATABASE_URL, or set sqlalchemy.url on the "
            "Alembic config before running a migration."
        )
    return url


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of connecting.

    Kept because a production migration is often reviewed as SQL before it is
    applied, and `--sql` is how that review gets its input.
    """
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against a live connection."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # Type comparison on, because the columns this schema turns on are
            # exactly the ones a careless change would alter invisibly: JSONB
            # narrowed to JSON, or a timestamptz losing its zone.
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()

    connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
