"""Shared fixtures for the detection service tests.

The fixtures here build synthetic rasters rather than reaching for real imagery.
A corridor read from Planetary Computer is slow, non-deterministic (the newest
NAIP item for a bbox changes as the archive grows), and unavailable offline — so
unit tests that assert classification or vectorization behavior construct their
own pixels with known ground truth instead.

Tests that genuinely need a live service or a real model carry the `network` or
`heavy` marker declared in `pyproject.toml`.
"""

from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import from_origin


# NAIP's native ground sample distance. Items are served at either 0.6 m or 1.0 m
# depending on the flight, which is exactly why U1 carries the value through
# rather than letting downstream units assume one — the area filters in U3 and
# the simplification tolerance in U4 are both expressed in meters.
NAIP_GSD_METERS = 0.6


@pytest.fixture
def gsd() -> float:
    """Ground sample distance in meters for synthetic rasters."""
    return NAIP_GSD_METERS


@pytest.fixture
def utm_transform():
    """An affine transform placing a synthetic raster in a projected CRS.

    Anchored in UTM meters rather than degrees so that area and distance
    assertions in tests mean the same thing they mean in production.
    """
    return from_origin(500000.0, 4000000.0, NAIP_GSD_METERS, NAIP_GSD_METERS)


@pytest.fixture
def uniform_corridor() -> np.ndarray:
    """A 4-band raster of featureless turf.

    Used to assert that segmentation returns *no* masks on a scene with nothing
    in it, rather than one mask covering the whole frame.
    """
    height, width = 200, 400
    red = np.full((height, width), 60, dtype=np.uint8)
    green = np.full((height, width), 90, dtype=np.uint8)
    blue = np.full((height, width), 55, dtype=np.uint8)
    nir = np.full((height, width), 200, dtype=np.uint8)
    return np.stack([red, green, blue, nir])


def paint(band_stack: np.ndarray, box: tuple[int, int, int, int], values: tuple[int, ...]) -> None:
    """Paint a rectangular patch across every band of a raster, in place.

    `box` is (row_start, row_stop, col_start, col_stop); `values` is one value per
    band. Tests use this to place a bunker, pond, or green with known extent and
    known spectral signature, so the expected classification is unambiguous.
    """
    row_start, row_stop, col_start, col_stop = box
    for band_index, value in enumerate(values):
        band_stack[band_index, row_start:row_stop, col_start:col_stop] = value


@pytest.fixture
def painter():
    """Expose `paint` as a fixture so tests need not import it directly."""
    return paint
