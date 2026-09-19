"""Local development entrypoint: the service with a SQLite file as its store.

    uvicorn service.local:app --reload      # http://localhost:8000

`service.app:app` is built with no store at all, so on a laptop every save and
decision endpoint answers a typed "no store configured". This module wires the
same `create_app` to a SQLite file instead, so the frontend (whose default
service address is http://localhost:8000) can save holes, boundaries and
decisions end to end without a Postgres server.

**This module reads the environment at import, and that is deliberate.** The
rest of the service never does — `create_app` takes every collaborator as an
argument so importing the library is never a configuration question. This file
is not the library; it is the process entrypoint for local development, the
same role `modal_deploy.fastapi_app` plays in production, and reading config is
what entrypoints are for. `LOCAL_DB_PATH` names the SQLite file (default
`.local/mapper.db`, relative to the working directory, which `.gitignore`
excludes); its directory is created if missing.

Permissive CORS is on here and only here, via `allow_local_cors` — the Vite dev
server runs on a different port.
"""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session

from service.app import create_app

DEFAULT_LOCAL_DB_PATH = ".local/mapper.db"

db_path = Path(os.environ.get("LOCAL_DB_PATH") or DEFAULT_LOCAL_DB_PATH)
db_path.parent.mkdir(parents=True, exist_ok=True)

# `check_same_thread=False` because the store endpoints are plain `def` and
# Starlette runs them on worker threads; SQLite otherwise refuses a connection
# used from a thread other than the one that opened it.
engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

# The same migrations production runs, so a schema change reaches the local
# file on the next start instead of failing with "no such column". A file built
# by an earlier version of this module with `create_all` has the tables but no
# revision stamp; its schema is exactly revision 0003's, so it is stamped there
# and upgraded forward rather than rebuilt.
_migrations = Config()
_migrations.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
_migrations.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
_tables = set(inspect(engine).get_table_names())
if "saved_holes" in _tables and "alembic_version" not in _tables:
    command.stamp(_migrations, "0003")
command.upgrade(_migrations, "head")

app = create_app(session_factory=lambda: Session(engine), allow_local_cors=True)
