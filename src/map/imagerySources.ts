/**
 * The imagery the map draws under everything else.
 *
 * Two hardcoded sources, not the Editor Layer Index (KTD3): ELI would make the
 * licensing posture auditable, but choosing between two entries costs a fetch
 * plus coverage-polygon filtering. Revisit at a third source.
 *
 * Esri World Imagery is the default (KTD1). This tool is permanently free and
 * non-commercial, so Esri's grant for tracing into OpenStreetMap applies, and
 * its cache reaches deeper than NAIP's. NAIP ships as a working second source
 * (KTD2) — swapping is a configuration change, a different `sourceId` passed to
 * `BaseMap`, not a contributor-facing control.
 *
 * Deliberately free of MapLibre: everything here is plain data, so it can be
 * tested in `node` without a DOM. The only import is a type, which erases.
 */
import type { DetectionImagery } from '../api/detect';

/** Which imagery a map surface draws. */
export type ImagerySourceId = 'esri-world-imagery' | 'usgs-naip';

/** Everything the map needs to draw and credit one imagery source. */
export interface ImagerySource {
  id: ImagerySourceId;
  /** Short name for the source, shown on the map surface. */
  label: string;
  /**
   * MapLibre raster tile templates. Either XYZ placeholders or, for a service
   * with no tile cache, `{bbox-epsg-3857}` — MapLibre substitutes the Web
   * Mercator extent of each tile it wants.
   */
  tiles: string[];
  tileSize: number;
  minzoom: number;
  /**
   * The deepest zoom that returns real pixels. Past this MapLibre enlarges the
   * tiles it already has instead of requesting ones that do not exist.
   */
  maxzoom: number;
  /** Credit line rendered on the map surface (R9). */
  attribution: string;
  /** What the pixels are and roughly when they were taken (R9). */
  captureContext: string;
  /** The `source=` value an OSM changeset traced off this imagery should carry. */
  osmSourceTag: string;
}

/** The MapLibre source key the imagery is registered under. */
export const IMAGERY_SOURCE_ID = 'imagery';

/** The MapLibre layer id drawing the imagery. Later layers insert above it. */
export const IMAGERY_LAYER_ID = 'imagery';

export const IMAGERY_SOURCES: Record<ImagerySourceId, ImagerySource> = {
  'esri-world-imagery': {
    id: 'esri-world-imagery',
    label: 'Esri World Imagery',
    /*
     * ArcGIS orders its tile path `{z}/{y}/{x}` — row before column, the
     * reverse of the usual XYZ template. Getting this backwards returns
     * plausible-looking tiles of somewhere else entirely.
     */
    tiles: [
      'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    tileSize: 256,
    minzoom: 0,
    /*
     * Measured 2026-08-12: the service answers HTTP 200 above its coverage but
     * with a ~2.5 KB "no data" tile rather than a 404, so MapLibre cannot tell
     * that it has run out of imagery and would quietly draw blank squares.
     * Real pixels ran to z19 over Pebble Beach and Sand Hills; z20 was blank at
     * both, and only midtown Manhattan returned real pixels at z20. z19 is the
     * level that holds everywhere a golf course is likely to be, so cap here
     * and let MapLibre overzoom past it.
     */
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    captureContext:
      'Aerial and satellite passes composited by Esri; capture date varies by area. Full detail to zoom 19 — closer views enlarge the zoom 19 imagery.',
    osmSourceTag: 'Esri',
  },
  'usgs-naip': {
    id: 'usgs-naip',
    label: 'USGS NAIP',
    /*
     * NAIPPlus advertises no tile cache — its service description carries no
     * `tileInfo` — so it is read through `exportImage`, one rendered request
     * per tile. `{bbox-epsg-3857}` is MapLibre's own placeholder; the service
     * is natively EPSG:3857, so no reprojection happens on either side.
     */
    tiles: [
      'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage' +
        '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image',
    ],
    tileSize: 256,
    minzoom: 0,
    /* 0.3–1 m ground resolution: about 0.24 m per pixel at zoom 19 in the
     * mid-latitudes, so past z19 the service would only upsample its own
     * pixels. Cheaper to let MapLibre do that locally. */
    maxzoom: 19,
    attribution: 'Imagery courtesy USGS and USDA NAIP — public domain',
    captureContext:
      'USDA NAIP leaf-on flights, 0.3–1 m; most states are re-flown every two to three years.',
    osmSourceTag: 'USDA NAIP',
  },
};

/** Esri unless something says otherwise (KTD1). */
export const DEFAULT_IMAGERY_SOURCE_ID: ImagerySourceId = 'esri-world-imagery';

/** The source a given id names, defaulting to Esri. */
export function imagerySource(id: ImagerySourceId = DEFAULT_IMAGERY_SOURCE_ID): ImagerySource {
  return IMAGERY_SOURCES[id];
}

/**
 * The raster half of a MapLibre style, narrowed to the fields we set. Declared
 * locally rather than imported from the style spec so this module stays free of
 * MapLibre and testable in `node`.
 */
export interface RasterSourceSpec {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

export interface BasemapStyle {
  version: 8;
  sources: Record<string, RasterSourceSpec>;
  layers: Array<{
    id: string;
    type: 'raster';
    source: string;
    paint: { 'raster-fade-duration': number };
  }>;
}

/**
 * A whole MapLibre style holding nothing but the imagery. No glyphs or sprite:
 * the map draws no labels of its own, so requesting either would be a fetch
 * against a service we do not run.
 */
export function basemapStyle(source: ImagerySource): BasemapStyle {
  return {
    version: 8,
    sources: {
      [IMAGERY_SOURCE_ID]: {
        type: 'raster',
        tiles: source.tiles,
        tileSize: source.tileSize,
        minzoom: source.minzoom,
        maxzoom: source.maxzoom,
        attribution: source.attribution,
      },
    },
    layers: [
      {
        id: IMAGERY_LAYER_ID,
        type: 'raster',
        source: IMAGERY_SOURCE_ID,
        /* Zero fade: a contributor tracing a bunker edge should not be shown a
         * cross-dissolve between two zoom levels of it. */
        paint: { 'raster-fade-duration': 0 },
      },
    ],
  };
}

/* --- The corridor raster inference actually read (R9, KTD4) --------------- */

/**
 * The MapLibre source and layer id the corridor overlay is registered under.
 *
 * One id for both, the way `IMAGERY_SOURCE_ID`/`IMAGERY_LAYER_ID` pair up. It is
 * deliberately not `IMAGERY_SOURCE_ID`: the overlay is added to a live map, and
 * reusing the basemap's key would mean tearing the basemap out to show it.
 */
export const CORRIDOR_OVERLAY_ID = 'detection-corridor';

/**
 * MapLibre's `image` source corner order: top-left, top-right, bottom-right,
 * bottom-left. Not a bounding box — the four corners are placed independently,
 * which is why a non-north-up raster can be positioned at all.
 */
export type OverlayCoordinates = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

/** Everything `BaseMap` needs to draw one georeferenced still image over the basemap. */
export interface ImageOverlaySpec {
  /** MapLibre source and layer id. */
  id: string;
  /** A URL a browser can decode as an image. Not a GeoTIFF — see `corridorOverlay`. */
  url: string;
  coordinates: OverlayCoordinates;
  /** Credit and provenance line, shown while the overlay is drawing (R9). */
  attribution: string;
  /**
   * `exact` when the raster is already in WGS84 and the four corners are its own
   * corners. `envelope` when the service read a projected raster (NAIP ships in
   * UTM) and `bounds_wgs84` is the lat/lng envelope of that window — laying it
   * flat on a WGS84 rectangle stretches it very slightly across the corridor.
   * Sub-pixel at NAIP's 0.6 m over a few hundred metres, but stated rather than
   * assumed, because R9 is about not quietly showing the wrong thing.
   */
  placement: 'exact' | 'envelope';
}

/**
 * Whether the corridor raster can be put on screen, and if not, why not in words
 * a contributor can read.
 */
export type CorridorOverlay =
  | { status: 'ready'; spec: ImageOverlaySpec }
  | { status: 'unrenderable'; format: string; reason: string };

/** Extensions a browser will decode into an `<img>`, which is what an `image` source is. */
const BROWSER_RASTER = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

/** The path extension of a URL, ignoring the query — signed hrefs carry a long one. */
function extensionOf(href: string): string {
  const path = href.split(/[?#]/, 1)[0];
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot < 0 || dot < slash) return '';
  return path.slice(dot + 1).toLowerCase();
}

/** WGS84 `[west, south, east, north]` as MapLibre's four corners. */
export function overlayCoordinates(
  bounds: [number, number, number, number],
): OverlayCoordinates {
  const [west, south, east, north] = bounds;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

/** Coordinate reference systems that need no reprojection to sit on a WGS84 map. */
const WGS84_CRS = new Set(['epsg:4326', 'ogc:crs84', 'crs84', 'wgs84', 'urn:ogc:def:crs:ogc:1.3:crs84']);

/**
 * The corridor raster the detection service read, as something the map can draw —
 * or a stated reason it cannot be drawn yet.
 *
 * **Why this is not the `usgs-naip` basemap source.** That entry is a live USGS
 * NAIPPlus `exportImage` mosaic: no pinned version, no per-tile acquisition date,
 * and whatever the service is serving today. Inference reads one dated Planetary
 * Computer item. Switching the basemap to `usgs-naip` would therefore show the
 * contributor NAIP pixels that are not the NAIP pixels the model read, which
 * satisfies neither R9 nor AE5 — it would look right and be wrong, which is the
 * exact failure R9 exists to prevent. Hence a separate overlay, pinned to the
 * item the answer names.
 *
 * **Why it may report `unrenderable` today.** `assetHref` is a signed URL to the
 * whole Cloud-Optimized GeoTIFF item. A browser cannot decode a GeoTIFF, and
 * MapLibre's `image` source takes a plain PNG/JPEG plus four corners — so there
 * is no honest way to draw a `.tif` here. Rather than substitute imagery from
 * somewhere else, this says so and the UI states the gap. The fix belongs in the
 * service: return a browser-renderable rendition of the same corridor window
 * (a PNG cut from the same item, same bounds) alongside the signed COG href, and
 * this function starts returning `ready` with no change to the wiring below it.
 */
export function corridorOverlay(imagery: DetectionImagery | null | undefined): CorridorOverlay | null {
  if (!imagery) return null;

  const extension = extensionOf(imagery.assetHref);
  if (!BROWSER_RASTER.has(extension)) {
    const format = extension === '' ? 'an unnamed format' : `a .${extension}`;
    return {
      status: 'unrenderable',
      format: extension,
      reason:
        `The service returned ${format} file — the whole Cloud-Optimized GeoTIFF item — ` +
        'which a browser cannot decode. Until it also returns a picture of the same ' +
        'window, the details below are all we can show you of what the model read.',
    };
  }

  return {
    status: 'ready',
    spec: {
      id: CORRIDOR_OVERLAY_ID,
      url: imagery.assetHref,
      coordinates: overlayCoordinates(imagery.boundsWgs84),
      attribution: `${imagery.source} — acquired ${imagery.acquired}, ${imagery.gsdMeters} m/px (item ${imagery.itemId})`,
      placement: WGS84_CRS.has(imagery.crs.trim().toLowerCase()) ? 'exact' : 'envelope',
    },
  };
}
