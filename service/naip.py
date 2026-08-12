"""Fetch a georeferenced NAIP raster covering the corridor around a playing line.

This is the imagery boundary of the detection service. Everything downstream —
segmentation, spectral classification, vectorization — reads the array this
module returns and nothing else, which is what keeps KTD4's separation honest:
NAIP is what inference sees, and the licensed Esri basemap the contributor sees
never reaches the server at all.

The shape of the work, and why each step is where it is:

1. **Bounds-check first.** The caps run before buffering, before STAC, before
   any byte of imagery is read, so an oversized request costs one geodesic
   length computation rather than a multi-gigabyte windowed read. A golf hole
   supplies natural limits — the longest hole ever played is well under a
   kilometre and a hand-drawn line has a few dozen vertices — so caps of 200
   vertices, 1,200 m and a 1 km2 corridor cost no legitimate use. KTD11 is the
   reason they exist despite the endpoint sitting behind an identity proxy: an
   authenticated contributor can still send a corridor large enough to exhaust
   the container.

2. **Buffer in UTM, not in degrees.** A degree of longitude is 111 km at the
   equator and 85 km at the northern edge of the contiguous states, so a
   fixed-degree buffer would be a different width in Florida than in Montana and
   a different width east-west than north-south everywhere. Projecting the line
   to its own UTM zone makes the half-width an actual number of metres. NAIP is
   US-only, so the Norway/Svalbard zone exceptions never apply and the zone can
   be computed arithmetically.

3. **Newest item wins (KTD5).** Planetary Computer's `naip` collection stacks
   every flight year with no default ordering, so the search sorts by
   acquisition datetime descending — and then sorts again locally, because a
   catalog that quietly ignores `sortby` would otherwise hand back an arbitrary
   year and nothing would notice.

4. **The item's own ground resolution travels with the raster.** NAIP items are
   served at 0.6 m or 1.0 m depending on the flight. U3's absolute area filters
   ("a green runs 250-2,500 m2") and U4's pixel-based simplification tolerance
   are both silently wrong when a caller assumes one and gets the other, so the
   value is returned rather than left to be guessed.

Expected failures come back as `service.results` variants rather than
exceptions, matching the client-side convention in `src/api/opengolf.ts`. The
catalog, the signer and the raster opener are all injectable so the tests need
no network.
"""

from __future__ import annotations

import datetime as dt
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
import rasterio
from pyproj import Geod, Transformer
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import transform_bounds
from rasterio.windows import Window
from rasterio.windows import transform as window_transform
from shapely.geometry import LineString, Polygon
from shapely.ops import transform as shapely_transform

from service.results import Invalid, NoCoverage, Ok, Result, Upstream

WGS84 = CRS.from_epsg(4326)

#: Half-width of the corridor buffered around the playing line, in metres. Wide
#: enough to take in greenside bunkers and the fairway's flanks — which sit off
#: the line and are exactly what a line-prompted model would miss (KTD2) —
#: without pulling in the neighbouring hole.
CORRIDOR_HALF_WIDTH_METERS = 60.0

#: Input caps. Deliberately generous against real golf geometry and deliberately
#: hard against anything else. See the module docstring for the reasoning; the
#: three are separate checks because none of them implies the others — a short
#: line with a huge half-width blows the area cap while passing the length cap,
#: and a dense zig-zag blows the vertex cap while passing both.
MAX_LINE_VERTICES = 200
MAX_LINE_LENGTH_METERS = 1_200.0
MAX_CORRIDOR_AREA_SQ_METERS = 1_000_000.0

#: Planetary Computer exposes a single `naip` collection whose `image` asset is
#: 4-band RGB+NIR for every year it carries. `naip-analytic`,
#: `naip-visualization` and `naip-source` are AWS bucket names at a different,
#: requester-pays provider — they are not assets here and must not be used.
NAIP_COLLECTION = "naip"
IMAGE_ASSET_KEY = "image"

#: Recorded per response for changeset provenance (R13).
IMAGERY_SOURCE = "USDA NAIP via Microsoft Planetary Computer"

STAC_API_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"

#: NAIP's band order. NIR is the band that separates water from tree shadow and
#: turf from sand, so a product without it would fail U3 outright — hence the
#: hard check on band count rather than a best-effort read.
BAND_COUNT = 4

_GEOD = Geod(ellps="WGS84")


@dataclass(frozen=True)
class Corridor:
    """The buffered region around a playing line, in two CRSs at once.

    Both representations are kept because both are needed and converting between
    them is lossy enough to be worth doing exactly once: the UTM polygon is what
    the area cap and any downstream metre-based measurement use, and the WGS84
    bbox is what STAC is queried with.
    """

    polygon_utm: Polygon
    polygon_wgs84: Polygon
    utm_crs: CRS
    bbox_wgs84: tuple[float, float, float, float]
    bbox_utm: tuple[float, float, float, float]
    area_sq_meters: float
    half_width_meters: float


@dataclass(frozen=True)
class CorridorRaster:
    """A windowed NAIP read plus everything downstream needs to interpret it.

    `pixels` is (4, height, width) uint8 in NAIP's R, G, B, NIR order. `crs` is
    the *item's* CRS, not the corridor's computed UTM zone — Planetary Computer
    serves NAIP in NAD83 UTM, which is metre-based but not identical to the
    WGS84 UTM the buffer was built in, and pretending otherwise would put every
    vectorized polygon a couple of metres off.
    """

    pixels: np.ndarray
    transform: Affine
    crs: CRS
    acquired: dt.date
    gsd_meters: float
    item_id: str
    asset_href: str
    corridor: Corridor
    source: str = IMAGERY_SOURCE

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(left, bottom, right, top) in `crs`."""
        _, height, width = self.pixels.shape
        left, top = self.transform * (0, 0)
        right, bottom = self.transform * (width, height)
        return (left, bottom, right, top)

    @property
    def bounds_wgs84(self) -> tuple[float, float, float, float]:
        """The same extent in lon/lat, for U5 to hand the client as an overlay."""
        return transform_bounds(self.crs, WGS84, *self.bounds, densify_pts=21)


class NaipCatalog(Protocol):
    """The only thing this module needs from a STAC catalog.

    Narrowed to one method so tests substitute a list rather than a client: the
    interesting behaviour here is item *selection*, and a protocol this small
    means a fake cannot accidentally satisfy it by being a real client.
    """

    def search(self, bbox: tuple[float, float, float, float]) -> Sequence[Any]:
        """Return every `naip` item intersecting `bbox`, newest first if possible."""
        ...


class PlanetaryComputerCatalog:
    """The real catalog. Constructed lazily so importing this module is offline."""

    def __init__(self, url: str = STAC_API_URL, max_items: int = 20) -> None:
        self._url = url
        # A handful of items is plenty: only the newest is read, and the rest
        # exist so the local re-sort has something to prove. Fetching the whole
        # multi-year stack for a bbox would be pure waste.
        self._max_items = max_items
        self._client: Any = None

    def search(self, bbox: tuple[float, float, float, float]) -> Sequence[Any]:
        from pystac_client import Client

        if self._client is None:
            self._client = Client.open(self._url)
        search = self._client.search(
            collections=[NAIP_COLLECTION],
            bbox=list(bbox),
            # Ask the API to sort even though the result is re-sorted locally:
            # when the API honours it, `max_items` truncates the oldest items
            # rather than an arbitrary slice.
            sortby=[{"field": "properties.datetime", "direction": "desc"}],
            max_items=self._max_items,
        )
        return list(search.items())


def _default_sign(href: str) -> str:
    """Sign an asset href with an anonymously-obtained SAS token.

    Imported at call time rather than module scope so `planetary_computer` — and
    the network call it eventually makes — is never touched by a request that
    was rejected during validation.
    """
    import planetary_computer

    return str(planetary_computer.sign(href))


def utm_crs_for_line(coordinates: Sequence[tuple[float, float]]) -> CRS:
    """The UTM zone containing the line's midpoint.

    Computed arithmetically rather than looked up: NAIP is US-only and the UTM
    zone exceptions all sit around Norway and Svalbard, so the formula is exact
    over every coordinate this service can legitimately receive. The midpoint of
    the bounding box, not the first vertex, so a line straddling a zone boundary
    picks the zone holding most of it.
    """
    lons = [lon for lon, _ in coordinates]
    lats = [lat for _, lat in coordinates]
    lon = (min(lons) + max(lons)) / 2
    lat = (min(lats) + max(lats)) / 2

    zone = math.floor((lon + 180.0) / 6.0) + 1
    zone = min(max(zone, 1), 60)
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return CRS.from_epsg(epsg)


def _validate_line(coordinates: Sequence[tuple[float, float]]) -> Invalid | None:
    """Reject a line before anything expensive happens. `None` means it passed."""
    if len(coordinates) < 2:
        return Invalid(
            "A playing line needs at least two points.",
            field_name="line",
            detail={"vertices": len(coordinates)},
        )

    if len(coordinates) > MAX_LINE_VERTICES:
        return Invalid(
            f"A playing line may have at most {MAX_LINE_VERTICES} points.",
            field_name="line",
            detail={"vertices": len(coordinates), "cap_vertices": MAX_LINE_VERTICES},
        )

    for lon, lat in coordinates:
        if not (math.isfinite(lon) and math.isfinite(lat)):
            return Invalid(
                "A playing line contains a non-finite coordinate.",
                field_name="line",
                detail={"point": [lon, lat]},
            )
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            return Invalid(
                "A playing line contains a coordinate outside the WGS84 range.",
                field_name="line",
                detail={"point": [lon, lat]},
            )

    lons = [lon for lon, _ in coordinates]
    lats = [lat for _, lat in coordinates]
    length = _GEOD.line_length(lons, lats)
    if length > MAX_LINE_LENGTH_METERS:
        return Invalid(
            f"A playing line may be at most {MAX_LINE_LENGTH_METERS:.0f} m long.",
            field_name="line",
            detail={"length_meters": length, "cap_meters": MAX_LINE_LENGTH_METERS},
        )

    return None


def build_corridor(
    coordinates: Sequence[tuple[float, float]],
    half_width_meters: float = CORRIDOR_HALF_WIDTH_METERS,
) -> Result[Corridor]:
    """Validate a WGS84 line and buffer it into a corridor, or say why not.

    Separated from the fetch so U5 can bounds-check a request without touching
    imagery, and so the caps are testable without a catalog.
    """
    coordinates = [(float(lon), float(lat)) for lon, lat in coordinates]

    invalid = _validate_line(coordinates)
    if invalid is not None:
        return invalid

    if not math.isfinite(half_width_meters) or half_width_meters <= 0:
        return Invalid(
            "The corridor half-width must be a positive number of metres.",
            field_name="half_width_meters",
            detail={"half_width_meters": half_width_meters},
        )

    utm_crs = utm_crs_for_line(coordinates)
    to_utm = Transformer.from_crs(WGS84, utm_crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(utm_crs, WGS84, always_xy=True).transform

    line_wgs84 = LineString(coordinates)
    line_utm = shapely_transform(to_utm, line_wgs84)

    # Flat caps and mitre joins: a round cap would extend the corridor a full
    # half-width past the tee and past the green, and the green is precisely the
    # feature that must not be clipped.
    polygon_utm = line_utm.buffer(half_width_meters, cap_style="flat", join_style="mitre")
    minx, miny, maxx, maxy = polygon_utm.bounds
    area = (maxx - minx) * (maxy - miny)

    if area > MAX_CORRIDOR_AREA_SQ_METERS:
        return Invalid(
            "The corridor around that line is larger than this service will read.",
            field_name="line",
            detail={
                "area_sq_meters": area,
                "cap_sq_meters": MAX_CORRIDOR_AREA_SQ_METERS,
                "half_width_meters": half_width_meters,
            },
        )

    polygon_wgs84 = shapely_transform(to_wgs84, polygon_utm)
    return Ok(
        Corridor(
            polygon_utm=polygon_utm,
            polygon_wgs84=polygon_wgs84,
            utm_crs=utm_crs,
            bbox_wgs84=tuple(polygon_wgs84.bounds),  # type: ignore[arg-type]
            bbox_utm=(minx, miny, maxx, maxy),
            area_sq_meters=area,
            half_width_meters=half_width_meters,
        )
    )


def _acquisition_date(item: Any) -> dt.date | None:
    """The item's acquisition date, from `datetime` or the start of its range.

    STAC items may carry either a single `datetime` or a `start_datetime` /
    `end_datetime` pair with `datetime` null. NAIP uses the former, but reading
    both costs one branch and turns a would-be crash into a skip.
    """
    stamp = getattr(item, "datetime", None)
    if stamp is None:
        raw = getattr(item, "properties", {}).get("start_datetime")
        if isinstance(raw, str):
            stamp = dt.datetime.fromisoformat(raw)
    if stamp is None:
        return None
    return stamp.date()


def _newest(items: Sequence[Any]) -> Any | None:
    """The most recently acquired item, sorting locally.

    The STAC search already asks for descending order, but a catalog is free to
    ignore `sortby`, and "newest item wins" silently degrading to "whichever
    item the API listed first" would show contributors imagery years older than
    what exists — with a confident acquisition date attached. Cheap insurance.
    """
    dated = [(date, item) for item in items if (date := _acquisition_date(item)) is not None]
    if not dated:
        return None
    return max(dated, key=lambda pair: pair[0])[1]


def _covering_window(
    dataset: Any, bounds: tuple[float, float, float, float]
) -> Window:
    """The smallest whole-pixel window whose extent contains `bounds`.

    rasterio's own `round_offsets`/`round_lengths` floor the offsets but round
    the lengths to nearest, which can end the window *inside* the requested
    extent. The corridor is the region the model will see, so it is rounded
    outward explicitly here rather than trusted to nearest-rounding.
    """
    left, bottom, right, top = bounds
    (row_start, row_stop), (col_start, col_stop) = rasterio.transform.rowcol(
        dataset.transform,
        [left, right],
        [top, bottom],
        op=lambda value: value,  # keep fractional pixel coordinates
    )
    col_off = math.floor(min(col_start, col_stop))
    row_off = math.floor(min(row_start, row_stop))
    width = math.ceil(max(col_start, col_stop)) - col_off
    height = math.ceil(max(row_start, row_stop)) - row_off
    return Window(col_off, row_off, max(width, 1), max(height, 1))


def fetch_corridor_raster(
    coordinates: Sequence[tuple[float, float]],
    *,
    half_width_meters: float = CORRIDOR_HALF_WIDTH_METERS,
    catalog: NaipCatalog | None = None,
    sign_href: Callable[[str], str] = _default_sign,
    open_raster: Callable[[str], Any] = rasterio.open,
) -> Result[CorridorRaster]:
    """Read the newest NAIP imagery covering the corridor around a playing line.

    `coordinates` is the WGS84 playing line, drawn tee-to-green. The catalog,
    the signer and the opener are injected so this whole function runs offline
    under test; the defaults are the real Planetary Computer path.

    Returns `Ok(CorridorRaster)`, `Invalid` for a line that fails the caps,
    `NoCoverage` when no NAIP item intersects the corridor — NAIP is US-only, so
    this is the normal answer for a non-US course — or `Upstream` when STAC, the
    SAS token endpoint or the COG read fails.
    """
    built = build_corridor(coordinates, half_width_meters)
    if not isinstance(built, Ok):
        return built
    corridor = built.value

    if catalog is None:
        catalog = PlanetaryComputerCatalog()

    try:
        items = list(catalog.search(corridor.bbox_wgs84))
    except Exception as error:  # noqa: BLE001 - any client failure is one outcome
        return Upstream(
            "Could not search Planetary Computer for NAIP imagery.",
            source="stac",
            cause=str(error),
        )

    item = _newest(items)
    if item is None:
        return NoCoverage(
            "No NAIP imagery covers this location. NAIP is flown over the United States only.",
            detail={"bbox": list(corridor.bbox_wgs84)},
        )

    acquired = _acquisition_date(item)
    assert acquired is not None  # _newest only returns dated items

    asset = item.assets.get(IMAGE_ASSET_KEY)
    if asset is None:
        return Upstream(
            f"The NAIP item {item.id} carries no '{IMAGE_ASSET_KEY}' asset.",
            source="stac",
            cause=f"assets: {sorted(item.assets)}",
        )

    try:
        href = sign_href(asset.href)
    except Exception as error:  # noqa: BLE001
        return Upstream(
            "Could not obtain a Planetary Computer access token for NAIP imagery.",
            source="planetary-computer",
            cause=str(error),
        )

    try:
        with open_raster(href) as dataset:
            if dataset.count < BAND_COUNT:
                return Upstream(
                    f"The NAIP item {item.id} has {dataset.count} bands; "
                    f"{BAND_COUNT} (RGB+NIR) are required.",
                    source="cog",
                    cause=f"band count {dataset.count}",
                )

            # Reproject the corridor bbox into the item's own CRS. Densified,
            # because a UTM-to-UTM bbox corner mapping is not a straight line
            # and the corner-only transform can fall inside the true extent.
            read_bounds = transform_bounds(
                WGS84, dataset.crs, *corridor.bbox_wgs84, densify_pts=21
            )
            window = _covering_window(dataset, read_bounds)

            # Boundless, because a corridor near the edge of a NAIP quad is only
            # partly covered by the single newest item, and a clipped read would
            # silently break the guarantee that the returned raster contains the
            # corridor. Uncovered pixels come back as zeros, which classify as
            # nothing rather than as a feature.
            pixels = dataset.read(
                indexes=list(range(1, BAND_COUNT + 1)),
                window=window,
                boundless=True,
                fill_value=0,
            )
            read_transform = window_transform(window, dataset.transform)
            crs = dataset.crs
    except Exception as error:  # noqa: BLE001
        return Upstream(
            "Could not read the NAIP corridor from Planetary Computer.",
            source="cog",
            cause=str(error),
        )

    # The item's own resolution, falling back to the dataset's pixel size when
    # `gsd` is absent from the properties. Never a constant: U3's area filters
    # and U4's tolerance are both wrong by a factor of ~1.7 if a 1.0 m item is
    # treated as 0.6 m.
    gsd = item.properties.get("gsd")
    gsd_meters = float(gsd) if gsd is not None else abs(read_transform.a)

    return Ok(
        CorridorRaster(
            pixels=pixels,
            transform=read_transform,
            crs=crs,
            acquired=acquired,
            gsd_meters=gsd_meters,
            item_id=item.id,
            asset_href=href,
            corridor=corridor,
        )
    )
