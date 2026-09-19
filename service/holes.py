"""Save and read back mapped holes and corrected course boundaries.

`store.py` is the training record — one row per answered proposal. This module
is the *mapping* record: the whole hole a contributor says is done (playing line
plus every polygon they confirmed or drew) and the course boundary they
corrected, kept with enough fidelity to become an OpenStreetMap changeset when
the write path lands. It is a sibling of `store.py` rather than more of it
because the two records answer different questions and are read by different
consumers; the conventions are the same:

**Session in, never a connection string.** Every function takes a `Session`
the caller opened and nothing here reads configuration.

**The write owns its commit.** One call is one save, which is the transaction,
and a save whose commit depended on the caller would fail silently in exactly
the way a durable record exists to prevent. Rolled back on any database error.

**Failures are `results.py` variants.** Everything wrong with a save is checked
before anything is added — geometry shape, coordinate ranges, the proposal/
origin pairing — and comes back as `Invalid` naming the top-level request field
the client can fix (`playing_line`, `features`, `geometry`), with the feature
index and the member inside it in `detail`. Anything SQLAlchemy raises becomes
`Upstream(source="postgres")`.

**Append-only.** A re-save is a new row; reads answer the latest. There is no
update path, so "they changed their mind" never destroys the version before it.

**No identity.** Same rule as `models.py`'s privacy note, and the input types
below have no field that could carry one.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from service.models import LineSource, OsmSyncStatus, SavedBoundary, SavedHole
from service.results import Invalid, Ok, Result, Upstream
from service.store import STORABLE_GEOMETRY_TYPES, as_utc


class HoleFeatureKind(StrEnum):
    """What a saved feature is, in the contributor's mapping vocabulary.

    Wider than `classify.FeatureKind` on purpose. That enum is what the model
    can *propose*; this one is what a contributor can *map*, which includes
    everything they draw by hand — trees, waste and native areas have no
    spectral rule, but they are real OSM `golf=*` / `natural=*` features and a
    saved hole that refused them would push the contributor to mislabel them.
    `other` exists so an unusual shape is saved honestly rather than forced
    into the nearest kind. Not a database column (features are one JSON list),
    so adding a kind needs no migration.
    """

    TEE = "tee"
    GREEN = "green"
    FAIRWAY = "fairway"
    BUNKER = "bunker"
    WATER = "water"
    TREES = "trees"
    WASTE_AREA = "waste_area"
    NATIVE_AREA = "native_area"
    OTHER = "other"


class FeatureOrigin(StrEnum):
    """Whether a saved feature started as a model proposal or a hand drawing.

    Kept because the OSM upload has to be able to say which shapes a model
    suggested — the Automated Edits code of conduct cares — and because a
    proposal carries confidence and imagery provenance that a drawing has none
    of.
    """

    PROPOSED = "proposed"
    DRAWN = "drawn"
    #: Already in OpenStreetMap: a shape the contributor picked off the map
    #: rather than drew or accepted from the model. Carries `osm_id`, so the
    #: upload can update that way instead of adding a duplicate beside it.
    OSM = "osm"


class OsmAction(StrEnum):
    """What the OpenStreetMap upload has to do with one saved feature.

    * `create` — a new way: the contributor drew it, or confirmed a proposal.
    * `keep` — already in OSM and confirmed as it is. Nothing to send.
    * `modify` — already in OSM, and the contributor moved its vertices.
    * `dispute` — already in OSM, and the contributor said it is not what this
      hole's step says it is ("that is not the green", "not sand"). Kept apart
      from a delete on purpose: an OSM green another hole owns is not wrong,
      only not this hole's, and the upload has to decide which.
    """

    CREATE = "create"
    KEEP = "keep"
    MODIFY = "modify"
    DISPUTE = "dispute"


@dataclass(frozen=True)
class HoleInput:
    """One hole save, as the endpoint hands it to this module.

    `playing_line` and `features` are plain JSON values — the wire models in
    `app.py` have already bounded their shape — and they are stored exactly as
    received so the read path answers the same shape back. There is
    deliberately no contributor or session field.
    """

    course_id: str
    hole_number: int
    par: int | None
    playing_line: dict[str, Any]
    line_source: LineSource
    osm_hole_id: str | None
    features: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class SavedHoleRecord:
    """One saved hole on the way back out. A value, never the ORM row."""

    id: int
    course_id: str
    hole_number: int
    par: int | None
    playing_line: dict[str, Any]
    line_source: LineSource
    osm_hole_id: str | None
    features: tuple[dict[str, Any], ...]
    osm_sync_status: OsmSyncStatus
    osm_synced_at: dt.datetime | None
    saved_at: dt.datetime


@dataclass(frozen=True)
class BoundaryInput:
    """One boundary save. No contributor field, by the same rule."""

    course_id: str
    osm_id: str | None
    geometry: dict[str, Any]
    edited: bool


@dataclass(frozen=True)
class SavedBoundaryRecord:
    """One saved boundary on the way back out."""

    id: int
    course_id: str
    osm_id: str | None
    geometry: dict[str, Any]
    edited: bool
    saved_at: dt.datetime


# --------------------------------------------------------------------------- #
# Geometry checks
# --------------------------------------------------------------------------- #
#
# Each returns a human-readable reason or `None`. They are deliberately plain
# walks over the GeoJSON rather than a shapely parse: the question is "can this
# be uploaded to OSM as WGS84 nodes", not "is this a valid simple polygon", and
# self-intersection is something a contributor can legitimately be mid-way
# through fixing on a later save. What they refuse is what OSM itself would:
# a non-number, a NaN or infinity (Python's JSON reader accepts both), a
# coordinate off the globe, a ring too short to enclose anything.


def _position_problem(position: Any) -> str | None:
    """One GeoJSON position: `[lng, lat]` or `[lng, lat, altitude]`, finite, on Earth."""
    if not isinstance(position, (list, tuple)) or not 2 <= len(position) <= 3:
        return "a position must be [longitude, latitude]"
    # `bool` is an `int` in Python; `true` is not a coordinate.
    if not all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in position):
        return "coordinates must be numbers"
    if not all(math.isfinite(n) for n in position):
        return "coordinates must be finite numbers"
    lng, lat = position[0], position[1]
    if not -180.0 <= lng <= 180.0:
        return "longitude must be between -180 and 180"
    if not -90.0 <= lat <= 90.0:
        return "latitude must be between -90 and 90"
    return None


def _positions_problem(positions: Any, minimum: int, what: str) -> str | None:
    if not isinstance(positions, (list, tuple)) or len(positions) < minimum:
        return f"{what} needs at least {minimum} positions"
    for position in positions:
        problem = _position_problem(position)
        if problem is not None:
            return problem
    return None


def line_problem(geometry: Any) -> str | None:
    """Why a playing line cannot be stored, or `None`."""
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString":
        return "the playing line must be a GeoJSON LineString"
    return _positions_problem(geometry.get("coordinates"), 2, "a playing line")


def _polygon_problem(rings: Any) -> str | None:
    if not isinstance(rings, (list, tuple)) or not rings:
        return "a polygon needs at least one ring"
    for ring in rings:
        # Four because a closed ring repeats its first position: a triangle is
        # the smallest thing that encloses an area.
        problem = _positions_problem(ring, 4, "a polygon ring")
        if problem is not None:
            return problem
    return None


def area_problem(geometry: Any) -> str | None:
    """Why an area geometry (feature or boundary) cannot be stored, or `None`."""
    if not isinstance(geometry, dict) or geometry.get("type") not in STORABLE_GEOMETRY_TYPES:
        return "the geometry must be a GeoJSON Polygon or MultiPolygon"
    coordinates = geometry.get("coordinates")
    if geometry["type"] == "Polygon":
        return _polygon_problem(coordinates)
    if not isinstance(coordinates, (list, tuple)) or not coordinates:
        return "a multipolygon needs at least one polygon"
    for polygon in coordinates:
        problem = _polygon_problem(polygon)
        if problem is not None:
            return problem
    return None


def _course_problem(course_id: str) -> Invalid | None:
    if not course_id.strip() or len(course_id) > 128:
        return Invalid(
            "A save must name the course it is about, in at most 128 characters.",
            field_name="course_id",
        )
    return None


def _feature_problem(index: int, feature: dict[str, Any]) -> Invalid | None:
    problem = area_problem(feature.get("geometry"))
    if problem is not None:
        return Invalid(
            f"Feature {index}: {problem}.",
            field_name="features",
            detail={"index": index, "member": "geometry", "reason": problem},
        )

    origin = feature.get("origin")
    proposal = feature.get("proposal")
    # The pairing is the provenance guarantee: a shape claimed as a model
    # proposal must say which model and which imagery, and a hand drawing must
    # not carry a confidence nobody computed.
    if origin == FeatureOrigin.PROPOSED and proposal is None:
        return Invalid(
            f"Feature {index} is a proposal but carries no proposal confidence or provenance.",
            field_name="features",
            detail={"index": index, "member": "proposal"},
        )
    if origin in (FeatureOrigin.DRAWN, FeatureOrigin.OSM) and proposal is not None:
        return Invalid(
            f"Feature {index} was not proposed by the model and cannot carry proposal provenance.",
            field_name="features",
            detail={"index": index, "member": "proposal"},
        )
    osm_id = feature.get("osm_id")
    if origin == FeatureOrigin.OSM and not osm_id:
        return Invalid(
            f"Feature {index} came from OpenStreetMap but does not say which element.",
            field_name="features",
            detail={"index": index, "member": "osm_id"},
        )
    action = feature.get("osm_action")
    if origin == FeatureOrigin.OSM and action == OsmAction.CREATE:
        return Invalid(
            f"Feature {index} is already in OpenStreetMap, so it cannot be created there.",
            field_name="features",
            detail={"index": index, "member": "osm_action"},
        )
    if origin != FeatureOrigin.OSM and action not in (None, OsmAction.CREATE):
        return Invalid(
            f"Feature {index} is not in OpenStreetMap, so the upload can only create it.",
            field_name="features",
            detail={"index": index, "member": "osm_action"},
        )
    if origin != FeatureOrigin.OSM and osm_id:
        return Invalid(
            f"Feature {index} carries an OpenStreetMap id but did not come from OpenStreetMap.",
            field_name="features",
            detail={"index": index, "member": "osm_id"},
        )
    if proposal is not None:
        acquired = (proposal.get("provenance") or {}).get("acquired")
        try:
            dt.date.fromisoformat(str(acquired))
        except ValueError:
            return Invalid(
                f"Feature {index}: the imagery acquisition date is not an ISO date.",
                field_name="features",
                detail={"index": index, "member": "proposal", "acquired": acquired},
            )
    return None


def _validate_hole(hole: HoleInput) -> Invalid | None:
    """Everything wrong with a hole save, checked before anything is written."""
    course = _course_problem(hole.course_id)
    if course is not None:
        return course
    if not 1 <= hole.hole_number <= 99:
        return Invalid(
            "Hole numbers run from 1 to 99.",
            field_name="hole_number",
            detail={"hole_number": hole.hole_number},
        )
    problem = line_problem(hole.playing_line)
    if problem is not None:
        return Invalid(
            f"The playing line cannot be saved: {problem}.",
            field_name="playing_line",
            detail={"reason": problem},
        )
    for index, feature in enumerate(hole.features):
        invalid = _feature_problem(index, feature)
        if invalid is not None:
            return invalid
    return None


# --------------------------------------------------------------------------- #
# Rows
# --------------------------------------------------------------------------- #


def _hole_from_row(row: SavedHole) -> SavedHoleRecord:
    return SavedHoleRecord(
        id=row.id,
        course_id=row.course_id,
        hole_number=row.hole_number,
        par=row.par,
        playing_line=row.playing_line,
        line_source=LineSource(row.line_source),
        osm_hole_id=row.osm_hole_id,
        features=tuple(row.features),
        osm_sync_status=OsmSyncStatus(row.osm_sync_status),
        osm_synced_at=as_utc(row.osm_synced_at) if row.osm_synced_at else None,
        saved_at=as_utc(row.saved_at),
    )


def _boundary_from_row(row: SavedBoundary) -> SavedBoundaryRecord:
    return SavedBoundaryRecord(
        id=row.id,
        course_id=row.course_id,
        osm_id=row.osm_id,
        geometry=row.geometry,
        edited=row.edited,
        saved_at=as_utc(row.saved_at),
    )


# --------------------------------------------------------------------------- #
# The four operations
# --------------------------------------------------------------------------- #


def save_hole(session: Session, hole: HoleInput) -> Result[SavedHoleRecord]:
    """Save one whole hole as a new row. Commits on success, rolls back on failure."""
    invalid = _validate_hole(hole)
    if invalid is not None:
        return invalid

    row = SavedHole(
        course_id=hole.course_id,
        hole_number=hole.hole_number,
        par=hole.par,
        playing_line=hole.playing_line,
        line_source=hole.line_source,
        osm_hole_id=hole.osm_hole_id,
        features=list(hole.features),
    )
    try:
        session.add(row)
        session.flush()
        saved = _hole_from_row(row)
        session.commit()
    except SQLAlchemyError as error:
        session.rollback()
        return Upstream("The store could not save this hole.", source="postgres", cause=str(error))
    return Ok(saved)


def latest_holes(
    session: Session, course_id: str, hole_number: int | None = None
) -> Result[tuple[SavedHoleRecord, ...]]:
    """The most recent save of each hole on a course, by hole number.

    One query with a window function rather than every save pulled back and
    folded in Python: a hole re-saved thirty times carries thirty copies of its
    geometry, and only one of them is ever wanted here. `saved_at` orders the
    saves and `id` breaks a tie between two saves in the same microsecond.
    Both SQLite (3.25+) and PostgreSQL support `ROW_NUMBER() OVER`.
    """
    ranked = select(
        SavedHole.id.label("id"),
        func.row_number()
        .over(
            partition_by=SavedHole.hole_number,
            order_by=(SavedHole.saved_at.desc(), SavedHole.id.desc()),
        )
        .label("rank"),
    ).where(SavedHole.course_id == course_id)
    if hole_number is not None:
        ranked = ranked.where(SavedHole.hole_number == hole_number)
    ranked_subquery = ranked.subquery()

    statement = (
        select(SavedHole)
        .join(ranked_subquery, SavedHole.id == ranked_subquery.c.id)
        .where(ranked_subquery.c.rank == 1)
        .order_by(SavedHole.hole_number)
    )
    try:
        rows = session.execute(statement).scalars().all()
    except SQLAlchemyError as error:
        return Upstream(
            "The store could not read this course's saved holes.",
            source="postgres",
            cause=str(error),
        )
    return Ok(tuple(_hole_from_row(row) for row in rows))


def save_boundary(session: Session, boundary: BoundaryInput) -> Result[SavedBoundaryRecord]:
    """Save a course boundary as a new row. Commits on success, rolls back on failure."""
    course = _course_problem(boundary.course_id)
    if course is not None:
        return course
    problem = area_problem(boundary.geometry)
    if problem is not None:
        return Invalid(
            f"The boundary cannot be saved: {problem}.",
            field_name="geometry",
            detail={"reason": problem},
        )

    row = SavedBoundary(
        course_id=boundary.course_id,
        osm_id=boundary.osm_id,
        geometry=boundary.geometry,
        edited=boundary.edited,
    )
    try:
        session.add(row)
        session.flush()
        saved = _boundary_from_row(row)
        session.commit()
    except SQLAlchemyError as error:
        session.rollback()
        return Upstream(
            "The store could not save this course boundary.", source="postgres", cause=str(error)
        )
    return Ok(saved)


def latest_boundary(session: Session, course_id: str) -> Result[SavedBoundaryRecord | None]:
    """The most recent boundary saved for a course, or `Ok(None)` if none was.

    `None` is a success, not a failure: most courses will never have a
    corrected boundary, and "nothing saved" is the ordinary answer.
    """
    statement = (
        select(SavedBoundary)
        .where(SavedBoundary.course_id == course_id)
        .order_by(SavedBoundary.saved_at.desc(), SavedBoundary.id.desc())
        .limit(1)
    )
    try:
        row = session.execute(statement).scalars().first()
    except SQLAlchemyError as error:
        return Upstream(
            "The store could not read this course's boundary.",
            source="postgres",
            cause=str(error),
        )
    return Ok(None if row is None else _boundary_from_row(row))
