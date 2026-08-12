import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGERY_SOURCE_ID,
  IMAGERY_LAYER_ID,
  IMAGERY_SOURCE_ID,
  IMAGERY_SOURCES,
  basemapStyle,
  imagerySource,
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
