import { describe, expect, it } from 'vitest';
import type { DetectionImagery } from '../api/detect';
import {
  CORRIDOR_OVERLAY_ID,
  DEFAULT_IMAGERY_SOURCE_ID,
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  IMAGERY_SOURCES,
  basemapStyle,
  corridorOverlay,
  imagerySource,
  overlayCoordinates,
} from './imagerySources';

const esri = IMAGERY_SOURCES['esri-world-imagery'];
const naip = IMAGERY_SOURCES['usgs-naip'];

describe('imagery sources', () => {
  it('templates the Esri path with y before x, the order ArcGIS serves', () => {
    const template = esri.tiles[0];
    expect(template).toContain('/tile/{z}/{y}/{x}');
    expect(template.indexOf('{y}')).toBeLessThan(template.indexOf('{x}'));
  });

  it('declares an explicit maxzoom for Esri so MapLibre overzooms instead of asking for tiles that are not there', () => {
    expect(typeof esri.maxzoom).toBe('number');
    expect(esri.maxzoom).toBeGreaterThanOrEqual(17);
    expect(esri.maxzoom).toBeLessThanOrEqual(22);
  });

  it('templates NAIP with a Web Mercator bbox rather than tile indices', () => {
    const template = naip.tiles[0];
    expect(template).toContain('{bbox-epsg-3857}');
    expect(template).toContain('bboxSR=3857');
    expect(template).not.toMatch(/\{[xyz]\}/);
  });

  it('gives every source a non-empty attribution and capture context', () => {
    for (const source of Object.values(IMAGERY_SOURCES)) {
      expect(source.attribution.trim().length).toBeGreaterThan(0);
      expect(source.captureContext.trim().length).toBeGreaterThan(0);
      expect(source.osmSourceTag.trim().length).toBeGreaterThan(0);
    }
  });

  it('defaults to Esri World Imagery and swaps source by id, with no picker involved', () => {
    expect(DEFAULT_IMAGERY_SOURCE_ID).toBe('esri-world-imagery');
    expect(imagerySource().id).toBe('esri-world-imagery');
    expect(imagerySource('usgs-naip').id).toBe('usgs-naip');
  });

  it('builds a raster-only MapLibre style carrying the source maxzoom and attribution', () => {
    const style = basemapStyle(naip);
    const source = style.sources[IMAGERY_SOURCE_ID];
    expect(source.type).toBe('raster');
    expect(source.tiles).toEqual(naip.tiles);
    expect(source.maxzoom).toBe(naip.maxzoom);
    expect(source.attribution).toBe(naip.attribution);
    expect(style.layers.map((layer) => layer.id)).toEqual([IMAGERY_LAYER_ID]);
    expect(style.layers[0].source).toBe(IMAGERY_SOURCE_ID);
  });
});

/**
 * The corridor raster (R9). What the service hands back today is a signed URL to
 * the whole Cloud-Optimized GeoTIFF item, so most of what is pinned down here is
 * that this refuses to draw it rather than reaching for pixels from elsewhere.
 */
describe('the corridor raster inference read', () => {
  /** What the service returns today: a signed href to the whole COG. */
  const COG: DetectionImagery = {
    source: 'USDA NAIP via Microsoft Planetary Computer',
    itemId: 'ca_m_3612148_sw_10_060_20220518',
    acquired: '2022-05-18',
    gsdMeters: 0.6,
    assetHref:
      'https://naipeuwest.blob.core.windows.net/naip/v002/ca/2022/ca_060cm_2022/36121/' +
      'm_3612148_sw_10_060_20220518.tif?st=2026-08-12T00%3A00Z&se=2026-08-12T01%3A00Z&sig=abc%2Fdef',
    boundsWgs84: [-121.95, 36.566, -121.944, 36.572],
    crs: 'EPSG:26910',
    width: 1024,
    height: 1024,
  };

  /** The same window, as a picture a browser can actually decode. */
  const RENDITION: DetectionImagery = {
    ...COG,
    assetHref: 'https://example.invalid/corridor/ca_m_3612148_sw_10_060_20220518.png?sig=abc',
  };

  it('has nothing to draw when detection described no imagery', () => {
    expect(corridorOverlay(null)).toBeNull();
  });

  it('refuses to draw a GeoTIFF rather than substituting pixels from somewhere else', () => {
    const overlay = corridorOverlay(COG);
    expect(overlay?.status).toBe('unrenderable');
    if (overlay?.status !== 'unrenderable') throw new Error('expected unrenderable');
    /* The extension is read off the path, not the signed query string. */
    expect(overlay.format).toBe('tif');
    expect(overlay.reason).toMatch(/browser cannot decode/);
  });

  it('draws a browser-renderable rendition of the same window at the bounds the service read', () => {
    const overlay = corridorOverlay(RENDITION);
    expect(overlay?.status).toBe('ready');
    if (overlay?.status !== 'ready') throw new Error('expected ready');

    expect(overlay.spec.id).toBe(CORRIDOR_OVERLAY_ID);
    expect(overlay.spec.url).toBe(RENDITION.assetHref);
    expect(overlay.spec.coordinates).toEqual(overlayCoordinates(RENDITION.boundsWgs84));
  });

  it('orders the corners the way an image source takes them: top-left round to bottom-left', () => {
    expect(overlayCoordinates([-121.95, 36.566, -121.944, 36.572])).toEqual([
      [-121.95, 36.572],
      [-121.944, 36.572],
      [-121.944, 36.566],
      [-121.95, 36.566],
    ]);
  });

  it('says whether four WGS84 corners place the raster exactly or only to its envelope', () => {
    const projected = corridorOverlay(RENDITION);
    const geographic = corridorOverlay({ ...RENDITION, crs: 'EPSG:4326' });
    expect(projected?.status === 'ready' && projected.spec.placement).toBe('envelope');
    expect(geographic?.status === 'ready' && geographic.spec.placement).toBe('exact');
  });

  it('credits the overlay with the acquisition date the rail states, so the two cannot disagree', () => {
    const overlay = corridorOverlay(RENDITION);
    if (overlay?.status !== 'ready') throw new Error('expected ready');
    expect(overlay.spec.attribution).toContain(RENDITION.acquired);
    expect(overlay.spec.attribution).toContain(RENDITION.itemId);
    expect(overlay.spec.attribution).toContain(RENDITION.source);
  });

  /* KTD4/R9: the live USGS mosaic is a different set of pixels from the dated
   * Planetary Computer item inference read, so the overlay is its own thing. */
  it('is not the usgs-naip basemap source', () => {
    const overlay = corridorOverlay(RENDITION);
    if (overlay?.status !== 'ready') throw new Error('expected ready');
    expect(overlay.spec.id).not.toBe(IMAGERY_SOURCE_ID);
    expect(overlay.spec.url).not.toContain('nationalmap.gov');
    expect(naip.tiles[0]).toContain('exportImage');
  });
});
