/**
 * The map surface both map screens embed: real aerial imagery, its credits, and
 * click-to-coordinate.
 *
 * MapLibre touches browser globals the moment it is imported, so this component
 * never imports it at module scope (KTD5). When `window` is undefined — the SSR
 * smoke build — it renders a static placeholder carrying the same chrome and the
 * same credit lines, and the library is loaded inside an effect that only ever
 * runs in a browser.
 *
 * Which imagery draws is configuration, not a control: pass a different
 * `sourceId` (KTD2). Nothing here offers the contributor a picker.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat } from '../geo/coords';
import {
  DEFAULT_IMAGERY_SOURCE_ID,
  IMAGERY_SOURCE_ID,
  basemapStyle,
  imagerySource,
  type ImagerySourceId,
} from './imagerySources';

/** A geographic extent in WGS84: `[west, south, east, north]`. */
export type MapBounds = [number, number, number, number];

/**
 * Whether the imagery is drawing. `error` is the state R19 cares about: the
 * canvas is blank, so the map says so and stops turning clicks into points.
 */
export type ImageryStatus = 'loading' | 'ready' | 'error';

/** What the map says when the tiles do not arrive. Exported so tests and callers agree on it. */
export const IMAGERY_UNAVAILABLE_MESSAGE = 'The aerial imagery did not load.';

/**
 * The course data's licence line (R18). Callers should pass the `_attribution`
 * string their API result carried; this is the fallback so the credit is never
 * simply missing.
 */
export const OSM_ODBL_ATTRIBUTION =
  '© OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI — https://opengolfapi.org/attribution';

export interface BaseMapProps {
  /** Fit the view to this extent once the map exists. Takes precedence over `center`. */
  bounds?: MapBounds;
  /** Where to open when there is no extent to fit. */
  center?: LngLat;
  zoom?: number;
  /** Which imagery to draw. Configuration-level; there is no picker (KTD2). */
  sourceId?: ImagerySourceId;
  /** The ODbL line from the OpenGolfAPI response, rendered beside the imagery credit. */
  dataAttribution?: string;
  /** Short caption for the top-left panel, usually the course or hole. */
  label?: ReactNode;
  /** Second line of the top-left panel: what the contributor is being asked to look at. */
  note?: ReactNode;
  /** A click on the imagery, already converted to WGS84. Never fires while imagery is unavailable. */
  onMapClick?: (position: LngLat) => void;
  /** Told every time the imagery state changes, so a screen can gate its own interactions. */
  onImageryStatusChange?: (status: ImageryStatus) => void;
  /** The live map, once it exists, for callers that add their own layers. */
  onMapReady?: (map: MapLibreMap) => void;
  /** Overlay chrome drawn above the map surface. */
  children?: ReactNode;
}

/* Panel chrome shared with the rest of the app: floating dark glass over imagery. */
const PANEL: CSSProperties = {
  position: 'absolute',
  background: 'rgba(6,43,38,.82)',
  backdropFilter: 'var(--blur-panel)',
  border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 'var(--radius-md)',
};

const MONO: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--green-200)',
};

export function BaseMap({
  bounds,
  center,
  zoom = 15,
  sourceId = DEFAULT_IMAGERY_SOURCE_ID,
  dataAttribution = OSM_ODBL_ATTRIBUTION,
  label,
  note,
  onMapClick,
  onImageryStatusChange,
  onMapReady,
  children,
}: BaseMapProps) {
  const source = imagerySource(sourceId);
  const isBrowser = typeof window !== 'undefined';

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [status, setStatus] = useState<ImageryStatus>('loading');
  const [mapReady, setMapReady] = useState(false);

  /*
   * Handlers live in a ref so a caller passing inline arrows does not tear the
   * map down and rebuild it on every render. `status` does too, because the
   * click listener is registered once and has to read the current value.
   */
  const statusRef = useRef<ImageryStatus>('loading');
  const handlers = useRef({ onMapClick, onImageryStatusChange, onMapReady });
  handlers.current = { onMapClick, onImageryStatusChange, onMapReady };

  /* The opening camera, captured once: later changes move the map, not remount it. */
  const openingCamera = useRef({ center, zoom });

  const reportStatus = useCallback((next: ImageryStatus) => {
    if (statusRef.current === next) return;
    statusRef.current = next;
    setStatus(next);
    handlers.current.onImageryStatusChange?.(next);
  }, []);

  useEffect(() => {
    if (!isBrowser) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    void (async () => {
      try {
        /* The one import that must stay lazy, alongside the stylesheet that
         * positions MapLibre's canvas inside the container. */
        const [maplibre] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (cancelled) return;

        const map = new maplibre.Map({
          container,
          style: basemapStyle(source),
          center: openingCamera.current.center ?? [-98.5795, 39.8283],
          zoom: openingCamera.current.zoom,
          /* We render credits ourselves, over the imagery, so both the imagery
           * and the course data are visible in one place (R9, R18). */
          attributionControl: false,
          /* Tracing is a plan view. Rotation and pitch only make a traced
           * polygon harder to line up against what is underneath it. */
          dragRotate: false,
          pitchWithRotate: false,
          maxPitch: 0,
        });
        /* Pinch still zooms — it is only the twist that is taken away. */
        map.touchZoomRotate.disableRotation();
        mapRef.current = map;

        map.on('error', (event) => {
          /* Tile failures name the source they came from; a style or WebGL
           * failure names nothing and is just as fatal to the imagery. Errors
           * from any other source — the geometry layers screens add — are not
           * this component's business. */
          const failed = (event as { sourceId?: string }).sourceId;
          if (failed === undefined || failed === IMAGERY_SOURCE_ID) reportStatus('error');
        });

        map.on('sourcedata', (event) => {
          if (event.sourceId === IMAGERY_SOURCE_ID && event.isSourceLoaded) reportStatus('ready');
        });

        map.on('click', (event) => {
          /* R19: a click over a blank canvas is not a placement a contributor
           * meant, so it is dropped rather than recorded. */
          if (statusRef.current === 'error') return;
          const position = map.unproject(event.point);
          handlers.current.onMapClick?.([position.lng, position.lat]);
        });

        setMapReady(true);
        handlers.current.onMapReady?.(map);
      } catch {
        /* The library itself failed to load: no imagery, same stated outcome. */
        if (!cancelled) reportStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [isBrowser, source, reportStatus]);

  /* Framing is separate from construction so a screen can move between holes
   * without rebuilding the map. The key keeps a fresh array from re-fitting. */
  const boundsKey = bounds ? bounds.join(',') : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 56, animate: false, maxZoom: source.maxzoom },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boundsKey stands in for bounds
  }, [mapReady, boundsKey, source.maxzoom]);

  const failed = status === 'error';

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#22321f' }}>
      {isBrowser ? (
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      ) : (
        /* Server render: the ground the imagery will cover, and nothing that
         * needs a browser to exist. */
        <div style={{ position: 'absolute', inset: 0, background: '#22321f' }} aria-hidden="true" />
      )}

      {(label || note) && (
        <div style={{ ...PANEL, top: 20, left: 20, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: failed ? 'var(--amber-400, #e0a33e)' : 'var(--mint-400)',
              animation: failed ? undefined : 'ogPulse 2.4s var(--ease-out) infinite',
            }}
          />
          {label && <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{label}</span>}
          {note && <span style={{ ...MONO, fontSize: 12 }}>{note}</span>}
        </div>
      )}

      {children}

      {failed && (
        <div
          style={{
            ...PANEL,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: 340,
            padding: '16px 20px',
            textAlign: 'center',
          }}
          role="status"
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#fff' }}>
            {IMAGERY_UNAVAILABLE_MESSAGE}
          </p>
          <p style={{ ...MONO, margin: '6px 0 0' }}>
            Placing points is off until it comes back. Check your connection, or try again in a
            moment.
          </p>
        </div>
      )}

      <div
        style={{
          ...PANEL,
          background: 'rgba(6,43,38,.78)',
          bottom: 20,
          right: 20,
          maxWidth: 460,
          padding: '8px 12px',
          textAlign: 'right',
          ...MONO,
        }}
      >
        <div>
          {source.attribution} · {source.captureContext}
        </div>
        <div style={{ opacity: 0.82 }}>{dataAttribution}</div>
      </div>
    </div>
  );
}
