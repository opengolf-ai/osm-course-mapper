"""Corridor fetch: bounds checks, UTM buffering, item selection, windowed read.

Everything except the one `network`-marked test runs against synthetic GeoTIFFs
written to a temp directory and a fake catalog, for the reason stated in
`conftest.py`: the newest NAIP item over a bbox changes as Planetary Computer's
archive grows, so a test that asserted on real imagery would assert on a moving
target and would not run offline at all.

The synthetic tiles are real rasters opened by real rasterio, not mocks of it.
That matters here because the thing most likely to be wrong in this unit is the
windowed read — CRS transforms, window rounding, band order — and a mocked
`rasterio.open` would prove none of it.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pystac
import pytest
import rasterio
from pyproj import Geod, Transformer
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds
from shapely.geometry import LineString, box
from shapely.ops import transform as shapely_transform

from service import naip
from service.results import Invalid, NoCoverage, Ok, Upstream

WGS84 = CRS.from_epsg(4326)

# Two US holes far enough apart to land in different UTM zones. Sand Hills in
# Nebraska is zone 14; Pebble Beach in California is zone 10.
NEBRASKA_LINE = [(-101.6383, 41.7965), (-101.6350, 41.7990)]
CALIFORNIA_LINE = [(-121.9490, 36.5680), (-121.9520, 36.5700)]


def _line_meters(coords: list[tuple[float, float]], meters: float) -> list[tuple[float, float]]:
    """Extend a two-point line east so it spans a known geodesic length."""
    lon, lat = coords[0]
    geod = Geod(ellps="WGS84")
    end_lon, end_lat, _ = geod.fwd(lon, lat, 90.0, meters)
    return [(lon, lat), (end_lon, end_lat)]


def _write_tile(
    path: Path,
    *,
    line: list[tuple[float, float]],
    epsg: int,
    gsd: float,
    fill: int,
    span_meters: float = 3000.0,
) -> None:
    """Write a 4-band NAIP-shaped GeoTIFF centred on `line`, in `epsg`.

    `fill` is written into every band so a test can tell which tile a read came
    from — that is how the newest-item assertion proves it read the item it
    claims to have read, rather than merely reporting its metadata.
    """
    to_projected = Transformer.from_crs(WGS84.to_string(), f"EPSG:{epsg}", always_xy=True)
    xs, ys = zip(*(to_projected.transform(lon, lat) for lon, lat in line))
    centre_x = (min(xs) + max(xs)) / 2
    centre_y = (min(ys) + max(ys)) / 2

    # Nudge the tile's origin by a fraction of a pixel in each axis. Real NAIP
    # quads have no reason to align with a contributor's corridor, and a tile
    # that happened to align would let a windowed read that rounds *inward* pass
    # the containment assertion — which is the one thing that assertion exists
    # to catch.
    origin_x = centre_x - span_meters / 2 + 0.37 * gsd
    origin_y = centre_y + span_meters / 2 - 0.61 * gsd

    size = int(span_meters / gsd)
    transform = from_origin(origin_x, origin_y, gsd, gsd)
    data = np.full((4, size, size), fill, dtype=np.uint8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=size,
        width=size,
        count=4,
        dtype="uint8",
        crs=CRS.from_epsg(epsg),
        transform=transform,
    ) as dst:
        dst.write(data)


def _item(path: Path, *, item_id: str, year: int, gsd: float) -> pystac.Item:
    """A STAC item shaped like Planetary Computer's `naip` collection."""
    item = pystac.Item(
        id=item_id,
        geometry=None,
        bbox=None,
        datetime=dt.datetime(year, 6, 15, tzinfo=dt.UTC),
        properties={"gsd": gsd},
    )
    item.add_asset("image", pystac.Asset(href=str(path), media_type=pystac.MediaType.COG))
    return item


class FakeCatalog:
    """A `NaipCatalog` that answers from a fixed list and records its calls."""

    def __init__(self, items: list[pystac.Item]) -> None:
        self.items = items
        self.calls: list[tuple[float, float, float, float]] = []

    def search(self, bbox: tuple[float, float, float, float]) -> list[pystac.Item]:
        self.calls.append(bbox)
        return list(self.items)


class ExplodingCatalog:
    """Fails the test if it is ever consulted."""

    def __init__(self) -> None:
        self.calls: list[tuple[float, float, float, float]] = []

    def search(self, bbox: tuple[float, float, float, float]) -> list[pystac.Item]:
        self.calls.append(bbox)
        raise AssertionError("STAC was queried for a request that should have been rejected")


@pytest.fixture
def exploding_opener():
    """A raster opener that fails the test if it is ever called."""

    def _open(href: str):
        raise AssertionError(f"a COG read was attempted for {href}")

    return _open


def test_nebraska_and_california_lines_resolve_to_their_own_utm_zones() -> None:
    """A shared or hardcoded zone would put the buffer's meters in the wrong place."""
    nebraska = naip.utm_crs_for_line(NEBRASKA_LINE)
    california = naip.utm_crs_for_line(CALIFORNIA_LINE)

    assert nebraska.to_epsg() == 32614
    assert california.to_epsg() == 32610
    assert nebraska != california


def test_returned_raster_bounds_contain_the_buffered_corridor(tmp_path: Path) -> None:
    """The corridor is the region SAM will see; a read that clips it loses features."""
    tile = tmp_path / "naip.tif"
    _write_tile(tile, line=CALIFORNIA_LINE, epsg=32610, gsd=0.6, fill=40)
    catalog = FakeCatalog([_item(tile, item_id="ca-2022", year=2022, gsd=0.6)])

    result = naip.fetch_corridor_raster(CALIFORNIA_LINE, catalog=catalog)

    assert isinstance(result, Ok)
    raster = result.value
    read_extent = box(*raster.bounds)

    # The corridor polygon itself, in the raster's own CRS.
    to_raster = Transformer.from_crs(WGS84.to_string(), raster.crs.to_string(), always_xy=True)
    corridor = shapely_transform(
        lambda x, y: to_raster.transform(x, y), raster.corridor.polygon_wgs84
    )
    assert read_extent.contains(corridor)

    # And the requested bbox, which is the tighter of the two: a diagonal
    # corridor sits several metres inside its own bounding box, so containment
    # of the polygon alone would still pass for a window rounded *inward* by a
    # pixel. This assertion is what actually pins the window rounding.
    requested = box(*transform_bounds(WGS84, raster.crs, *raster.corridor.bbox_wgs84,
                                      densify_pts=21))
    assert read_extent.contains(requested)


def test_acquisition_date_is_carried_through_from_stac(tmp_path: Path) -> None:
    """R13: provenance travels with the pixels or the changeset cannot cite it."""
    tile = tmp_path / "naip.tif"
    _write_tile(tile, line=NEBRASKA_LINE, epsg=32614, gsd=1.0, fill=77)
    catalog = FakeCatalog([_item(tile, item_id="ne-2019", year=2019, gsd=1.0)])

    result = naip.fetch_corridor_raster(NEBRASKA_LINE, catalog=catalog)

    assert isinstance(result, Ok)
    assert result.value.acquired == dt.date(2019, 6, 15)
    assert result.value.item_id == "ne-2019"
    assert "NAIP" in result.value.source


def test_newest_of_several_overlapping_items_is_the_one_read(tmp_path: Path) -> None:
    """The collection stacks years with no default ordering (KTD5)."""
    older = tmp_path / "2016.tif"
    middle = tmp_path / "2019.tif"
    newest = tmp_path / "2022.tif"
    _write_tile(older, line=CALIFORNIA_LINE, epsg=32610, gsd=1.0, fill=16)
    _write_tile(middle, line=CALIFORNIA_LINE, epsg=32610, gsd=1.0, fill=19)
    _write_tile(newest, line=CALIFORNIA_LINE, epsg=32610, gsd=0.6, fill=22)

    # Deliberately out of order: the catalog must not be trusted to sort.
    catalog = FakeCatalog(
        [
            _item(middle, item_id="ca-2019", year=2019, gsd=1.0),
            _item(newest, item_id="ca-2022", year=2022, gsd=0.6),
            _item(older, item_id="ca-2016", year=2016, gsd=1.0),
        ]
    )

    result = naip.fetch_corridor_raster(CALIFORNIA_LINE, catalog=catalog)

    assert isinstance(result, Ok)
    raster = result.value
    assert raster.item_id == "ca-2022"
    assert raster.acquired.year == 2022
    # The pixels, not just the metadata, came from the newest tile.
    # The fill value identifies which item was read. Only the corridor's own
    # pixels carry it now — everything outside the band is zeroed on the way out.
    carried = raster.pixels[raster.pixels > 0]
    assert carried.size > 0
    assert np.all(carried == 22)
    # And its own ground resolution travelled with them, rather than a default.
    assert raster.gsd_meters == pytest.approx(0.6)


def test_corridor_exceeding_the_area_cap_is_rejected_before_any_upstream_call(
    exploding_opener,
) -> None:
    """The caps run before buffering reaches STAC, so an oversized request costs nothing."""
    catalog = ExplodingCatalog()
    # A kilometre-long line with a 500 m half-width buffers to roughly 2 km2 —
    # inside the length cap, far outside the area cap. The two caps are separate
    # checks because neither one implies the other.
    line = _line_meters(CALIFORNIA_LINE, 1000.0)

    result = naip.fetch_corridor_raster(
        line, half_width_meters=500.0, catalog=catalog, open_raster=exploding_opener
    )

    assert isinstance(result, Invalid)
    assert result.field_name == "line"
    assert result.detail["cap_sq_meters"] == naip.MAX_CORRIDOR_AREA_SQ_METERS
    assert catalog.calls == []


def test_line_with_too_many_vertices_is_rejected(exploding_opener) -> None:
    catalog = ExplodingCatalog()
    lon, lat = CALIFORNIA_LINE[0]
    line = [(lon + i * 1e-6, lat) for i in range(naip.MAX_LINE_VERTICES + 1)]

    result = naip.fetch_corridor_raster(line, catalog=catalog, open_raster=exploding_opener)

    assert isinstance(result, Invalid)
    assert result.detail["cap_vertices"] == naip.MAX_LINE_VERTICES
    assert catalog.calls == []


def test_line_longer_than_the_length_cap_is_rejected(exploding_opener) -> None:
    catalog = ExplodingCatalog()
    line = _line_meters(CALIFORNIA_LINE, naip.MAX_LINE_LENGTH_METERS + 50.0)

    result = naip.fetch_corridor_raster(line, catalog=catalog, open_raster=exploding_opener)

    assert isinstance(result, Invalid)
    assert result.detail["cap_meters"] == naip.MAX_LINE_LENGTH_METERS
    assert catalog.calls == []


def test_degenerate_line_is_rejected(exploding_opener) -> None:
    """A single point has no corridor; buffering it would still produce a disc."""
    catalog = ExplodingCatalog()

    result = naip.fetch_corridor_raster(
        [CALIFORNIA_LINE[0]], catalog=catalog, open_raster=exploding_opener
    )

    assert isinstance(result, Invalid)
    assert catalog.calls == []


def test_ground_outside_the_corridor_is_zeroed_not_returned(tmp_path: Path) -> None:
    """A dogleg's bounding box holds far more than the hole.

    The read is windowed to the corridor's *bounding box*, which on a bend is
    roughly twice the corridor's own area — the rest is whatever else sits
    there: another fairway, the clubhouse, a car park. Segmentation cannot tell
    those apart, so on a real hole their features reached classification and
    competed to be this one's: five tee proposals for a hole with one visible
    tee, every extra lying outside the band.
    """
    dogleg = [(-121.9490, 36.5680), (-121.9520, 36.5700), (-121.9500, 36.5725)]
    tile = tmp_path / "dogleg.tif"
    _write_tile(tile, line=dogleg, epsg=32610, gsd=0.6, fill=22)
    catalog = FakeCatalog([_item(tile, item_id="ca-2022", year=2022, gsd=0.6)])

    result = naip.fetch_corridor_raster(dogleg, catalog=catalog)

    assert isinstance(result, Ok)
    raster = result.value
    inside = raster.pixels.any(axis=0)
    assert inside.any(), "the corridor itself must survive the clip"
    assert not inside.all(), "a dogleg's bbox corners lie outside the corridor"

    # The band is a real slice of the box, not nearly all of it — otherwise the
    # clip would buy nothing. Measured on a live dogleg it was 48%.
    covered = float(inside.mean())
    assert 0.2 < covered < 0.95

    # Whatever survived is the item's own data, unaltered.
    assert set(np.unique(raster.pixels[:, inside]).tolist()) == {22}


def test_bbox_with_no_naip_coverage_returns_a_stated_no_coverage_result(
    exploding_opener,
) -> None:
    """Silence and failure must not look alike (U5 depends on this variant)."""
    catalog = FakeCatalog([])

    result = naip.fetch_corridor_raster(
        CALIFORNIA_LINE, catalog=catalog, open_raster=exploding_opener
    )

    assert isinstance(result, NoCoverage)
    assert result.detail["bbox"] == pytest.approx(list(catalog.calls[0]), abs=1e-9)
    assert "NAIP" in result.message


def test_sas_signing_failure_surfaces_as_a_typed_error(tmp_path: Path) -> None:
    """A raw exception from the signing endpoint is not a contract any client can read."""
    tile = tmp_path / "naip.tif"
    _write_tile(tile, line=CALIFORNIA_LINE, epsg=32610, gsd=0.6, fill=40)
    catalog = FakeCatalog([_item(tile, item_id="ca-2022", year=2022, gsd=0.6)])

    def failing_sign(href: str) -> str:
        raise RuntimeError("503 from the SAS token endpoint")

    result = naip.fetch_corridor_raster(CALIFORNIA_LINE, catalog=catalog, sign_href=failing_sign)

    assert isinstance(result, Upstream)
    assert result.source == "planetary-computer"
    assert "503" in (result.cause or "")


def test_unreadable_cog_surfaces_as_a_typed_error(tmp_path: Path) -> None:
    """Same reasoning as signing: rasterio's exceptions are not a client contract."""
    missing = tmp_path / "absent.tif"
    catalog = FakeCatalog([_item(missing, item_id="ca-2022", year=2022, gsd=0.6)])

    result = naip.fetch_corridor_raster(CALIFORNIA_LINE, catalog=catalog)

    assert isinstance(result, Upstream)
    assert result.source == "cog"


@pytest.mark.network
def test_pebble_beach_hole_returns_a_dated_raster_from_planetary_computer() -> None:
    """The unit's stated verification, against the live catalog.

    Marked `network` so the default offline run stays deterministic: the item
    this resolves to, and therefore the year and resolution it reports, change
    as Planetary Computer's archive grows. The assertions are correspondingly
    about plausibility, not exact values.
    """
    # Pebble Beach's 7th, tee to green, drawn tee-to-green over the Pacific cliff.
    line = [(-121.9503, 36.5665), (-121.9509, 36.5659)]

    result = naip.fetch_corridor_raster(line)

    assert isinstance(result, Ok), result
    raster = result.value
    assert raster.pixels.shape[0] == 4
    assert 2010 <= raster.acquired.year <= dt.datetime.now(tz=dt.UTC).year
    assert 0.3 <= raster.gsd_meters <= 2.0

    to_wgs84 = Transformer.from_crs(raster.crs.to_string(), WGS84.to_string(), always_xy=True)
    left, bottom, right, top = raster.bounds
    read_extent = shapely_transform(
        lambda x, y: to_wgs84.transform(x, y), box(left, bottom, right, top)
    )
    assert read_extent.contains(LineString(line))
