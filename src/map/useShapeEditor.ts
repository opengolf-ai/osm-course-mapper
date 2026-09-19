/**
 * Drag handles for lines and outlines on the live map.
 *
 * One editor serves the three things a contributor reshapes: the playing line,
 * a feature's outline, and the course boundary. Each is handed in as a path —
 * an ordered list of coordinates, open or closed — and every change comes back
 * as the whole new list, so the caller's state stays the single copy of the
 * geometry and this hook never holds an opinion about what the path means.
 *
 * - drag a vertex to move it;
 * - drag the small handle halfway along an edge to add a vertex there;
 * - right-click a vertex to take it out (never below a line's two points or an
 *   outline's three).
 *
 * The handles are a GeoJSON circle layer on the map rather than HTML markers, so
 * a boundary with several hundred vertices is one source update rather than
 * several hundred DOM nodes. While a handle is held the map's own panning is
 * off, and the click MapLibre fires on release is swallowed via `hitsHandle` —
 * otherwise letting go of a handle in the playing-line flow would also drop a
 * new point wherever the cursor stopped.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapLayerTouchEvent } from 'maplibre-gl';
import type { LngLat } from '../geo/coords';

export interface EditablePath {
  id: string;
  coords: LngLat[];
  /** An outline, whose last vertex joins its first. A line is open. */
  closed: boolean;
}

const SOURCE = 'shape-editor-handles';
export const EDITOR_VERTEX_LAYER = 'shape-editor-vertex';
export const EDITOR_MID_LAYER = 'shape-editor-mid';

/** How long after letting go a click still counts as part of the drag. */
const CLICK_SWALLOW_MS = 300;

/**
 * An edge shorter than this on screen gets no "add a corner" handle.
 *
 * An OpenStreetMap course boundary can carry several hundred vertices, and
 * zoomed out to the whole course a midpoint on every edge doubles a wall of
 * dots into a solid band nobody can grab one of. Zooming in brings them back.
 */
const MIN_MIDPOINT_EDGE_PX = 28;

interface Drag {
  pathId: string;
  index: number;
  coords: LngLat[];
  moved: boolean;
}

function handleFeatures(paths: readonly EditablePath[], map?: MapLibreMap | null) {
  const edgePixels = (a: LngLat, b: LngLat) => {
    if (!map) return Infinity;
    try {
      const pa = map.project(a as [number, number]);
      const pb = map.project(b as [number, number]);
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    } catch {
      return Infinity;
    }
  };
  const features: unknown[] = [];
  for (const path of paths) {
    const { coords, closed } = path;
    coords.forEach((position, index) => {
      features.push({
        type: 'Feature',
        properties: { pathId: path.id, index, role: 'vertex', end: !closed && (index === 0 || index === coords.length - 1) },
        geometry: { type: 'Point', coordinates: position },
      });
    });
    const edges = closed ? coords.length : coords.length - 1;
    for (let index = 0; index < edges; index += 1) {
      const a = coords[index];
      const b = coords[(index + 1) % coords.length];
      if (edgePixels(a, b) < MIN_MIDPOINT_EDGE_PX) continue;
      features.push({
        type: 'Feature',
        properties: { pathId: path.id, index, role: 'mid' },
        geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

export function useShapeEditor(
  map: MapLibreMap | null,
  paths: readonly EditablePath[],
  onChange: (id: string, coords: LngLat[]) => void,
): { hitsHandle: (position: LngLat) => boolean } {
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const drag = useRef<Drag | null>(null);
  const swallowUntil = useRef(0);
  const frame = useRef<number | null>(null);

  /* The handles' own source and two layers, added on top of whatever is there
   * and retried on `styledata` for the same reason the review layers are. */
  useEffect(() => {
    if (!map) return;
    let attached = false;

    const attach = () => {
      try {
        if (!map.getSource(SOURCE)) {
          map.addSource(SOURCE, { type: 'geojson', data: handleFeatures(pathsRef.current, map) as never });
          map.addLayer({
            id: EDITOR_MID_LAYER,
            type: 'circle',
            source: SOURCE,
            filter: ['==', ['get', 'role'], 'mid'],
            paint: {
              'circle-radius': 4,
              'circle-color': 'rgba(255,255,255,.55)',
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#062b26',
            },
          } as never);
          map.addLayer({
            id: EDITOR_VERTEX_LAYER,
            type: 'circle',
            source: SOURCE,
            filter: ['==', ['get', 'role'], 'vertex'],
            paint: {
              'circle-radius': ['case', ['==', ['get', 'end'], true], 9, 6.5],
              'circle-color': ['case', ['==', ['get', 'end'], true], '#3ecfb4', '#ffffff'],
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#062b26',
            },
          } as never);
        }
        attached = true;
        map.off('styledata', attach);
      } catch {
        /* The style will not take a source yet; `styledata` brings us back. */
      }
    };

    const beginDrag = (event: MapLayerMouseEvent | MapLayerTouchEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const pathId = String(feature.properties?.pathId);
      const index = Number(feature.properties?.index);
      const role = feature.properties?.role;
      const path = pathsRef.current.find((candidate) => candidate.id === pathId);
      if (!path) return;
      /* Touch: one finger on a handle is a drag, two is a pinch the map keeps. */
      if ('points' in event && event.points.length > 1) return;
      /* Only the primary button drags; a right-click is the delete gesture. */
      if ('button' in event.originalEvent && event.originalEvent.button !== 0) return;
      event.preventDefault();

      let coords = path.coords.map((position) => [...position] as LngLat);
      let at = index;
      if (role === 'mid') {
        /* A midpoint becomes a real vertex the moment it is grabbed. */
        coords = [...coords.slice(0, index + 1), [event.lngLat.lng, event.lngLat.lat], ...coords.slice(index + 1)];
        at = index + 1;
      }
      drag.current = { pathId, index: at, coords, moved: role === 'mid' };
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'grabbing';
      if (role === 'mid') onChangeRef.current(pathId, coords);
    };

    const moveDrag = (event: { lngLat: { lng: number; lat: number } }) => {
      const current = drag.current;
      if (!current) return;
      current.coords = current.coords.slice();
      current.coords[current.index] = [event.lngLat.lng, event.lngLat.lat];
      current.moved = true;
      /* One state update per frame, however fast the pointer reports. */
      if (frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          const live = drag.current;
          if (live) onChangeRef.current(live.pathId, live.coords);
        });
      }
    };

    const endDrag = () => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      if (current.moved) onChangeRef.current(current.pathId, current.coords);
      swallowUntil.current = Date.now() + CLICK_SWALLOW_MS;
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
    };

    const removeVertex = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      event.preventDefault();
      const pathId = String(feature.properties?.pathId);
      const index = Number(feature.properties?.index);
      const path = pathsRef.current.find((candidate) => candidate.id === pathId);
      if (!path || path.coords.length <= (path.closed ? 3 : 2)) return;
      swallowUntil.current = Date.now() + CLICK_SWALLOW_MS;
      onChangeRef.current(
        pathId,
        path.coords.filter((_, i) => i !== index),
      );
    };

    /* Edge lengths on screen change with zoom, and with them which midpoints show. */
    const refresh = () => {
      if (drag.current) return;
      try {
        (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(handleFeatures(pathsRef.current, map) as never);
      } catch {
        /* Not attached yet. */
      }
    };

    const hoverOn = () => {
      if (!drag.current) map.getCanvas().style.cursor = 'grab';
    };
    const hoverOff = () => {
      if (!drag.current) map.getCanvas().style.cursor = '';
    };

    attach();
    if (!attached) map.on('styledata', attach);

    for (const layer of [EDITOR_VERTEX_LAYER, EDITOR_MID_LAYER]) {
      map.on('mousedown', layer, beginDrag);
      map.on('touchstart', layer, beginDrag);
      map.on('mouseenter', layer, hoverOn);
      map.on('mouseleave', layer, hoverOff);
    }
    map.on('contextmenu', EDITOR_VERTEX_LAYER, removeVertex);
    map.on('mousemove', moveDrag);
    map.on('touchmove', moveDrag);
    map.on('mouseup', endDrag);
    map.on('touchend', endDrag);
    map.on('zoomend', refresh);

    return () => {
      map.off('zoomend', refresh);
      map.off('styledata', attach);
      for (const layer of [EDITOR_VERTEX_LAYER, EDITOR_MID_LAYER]) {
        map.off('mousedown', layer, beginDrag);
        map.off('touchstart', layer, beginDrag);
        map.off('mouseenter', layer, hoverOn);
        map.off('mouseleave', layer, hoverOff);
      }
      map.off('contextmenu', EDITOR_VERTEX_LAYER, removeVertex);
      map.off('mousemove', moveDrag);
      map.off('touchmove', moveDrag);
      map.off('mouseup', endDrag);
      map.off('touchend', endDrag);
      if (drag.current) endDrag();
      try {
        if (map.getLayer(EDITOR_VERTEX_LAYER)) map.removeLayer(EDITOR_VERTEX_LAYER);
        if (map.getLayer(EDITOR_MID_LAYER)) map.removeLayer(EDITOR_MID_LAYER);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      } catch {
        /* The map is already gone. */
      }
    };
  }, [map]);

  /* Push the handles whenever the paths change, and keep them above every
   * layer a screen added after them — a handle under a fill cannot be grabbed. */
  const pathsKey = JSON.stringify(paths);
  useEffect(() => {
    if (!map) return;
    try {
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
      source?.setData(handleFeatures(paths, map) as never);
      if (map.getLayer(EDITOR_MID_LAYER)) map.moveLayer(EDITOR_MID_LAYER);
      if (map.getLayer(EDITOR_VERTEX_LAYER)) map.moveLayer(EDITOR_VERTEX_LAYER);
    } catch {
      /* Not attached yet; the attach reads `pathsRef` when it lands. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey stands in for paths
  }, [map, pathsKey]);

  const hitsHandle = useCallback(
    (position: LngLat) => {
      if (Date.now() < swallowUntil.current || drag.current) return true;
      if (!map || pathsRef.current.length === 0) return false;
      try {
        const point = map.project(position as [number, number]);
        const layers = [EDITOR_VERTEX_LAYER, EDITOR_MID_LAYER].filter((layer) => map.getLayer(layer));
        if (layers.length === 0) return false;
        return map.queryRenderedFeatures(point, { layers }).length > 0;
      } catch {
        return false;
      }
    },
    [map],
  );

  return { hitsHandle };
}
