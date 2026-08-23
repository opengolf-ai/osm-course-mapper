/*
 * Runs in the default `node` environment, where `window` is undefined — the same
 * condition `npm run smoke` renders under. The point of KTD5 is that this path
 * never evaluates MapLibre, so the mock counts its own evaluations and expects
 * zero.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const maplibre = vi.hoisted(() => ({ imports: 0 }));

vi.mock('maplibre-gl', () => {
  maplibre.imports += 1;
  return { Map: class {} };
});

import { BaseMap } from './BaseMap';
import { IMAGERY_SOURCES } from './imagerySources';

const ODBL = '© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI';

describe('BaseMap on the server', () => {
  it('renders a placeholder without importing MapLibre when window is undefined', () => {
    expect(typeof window).toBe('undefined');

    const html = renderToString(
      <BaseMap center={[-121.949, 36.5685]} label="Pebble Beach Golf Links" dataAttribution={ODBL} />,
    );

    expect(maplibre.imports).toBe(0);
    expect(html).toContain('Pebble Beach Golf Links');
    expect(html).toContain(IMAGERY_SOURCES['esri-world-imagery'].attribution);
    expect(html).toContain('OpenStreetMap contributors');
  });

  it('names the active source and its capture context in the server output', () => {
    const html = renderToString(<BaseMap sourceId="usgs-naip" center={[-121.949, 36.5685]} />);
    const naip = IMAGERY_SOURCES['usgs-naip'];

    expect(html).toContain(naip.attribution);
    expect(html).toContain(naip.captureContext);
    expect(maplibre.imports).toBe(0);
  });
});
