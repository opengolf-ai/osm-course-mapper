/**
 * The course line OpenStreetMap already holds, shown over real imagery, and
 * the first question: is this the whole course?
 *
 * Nobody can judge a mile-wide outline by eye, so the rail puts checkable facts
 * beside it — the acreage, and whether each landmark OSM holds falls inside the
 * line. If an edge is wrong the contributor drags it; the acreage and the
 * landmark verdicts follow as they do, and the corrected edge is saved to our
 * store (never to OpenStreetMap — the upload is not built).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MultiPolygon, Polygon } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { boundaryContains, type OsmCourse } from '../api/overpass';
import { Button, Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';
import { areaAcres, openRing, type LngLat } from '../geo/coords';
import { BaseMap } from '../map/BaseMap';
import { useShapeEditor, type EditablePath } from '../map/useShapeEditor';
import type { SaveState } from '../state/useMapper';

interface BoundaryScreenProps {
  /** The adopted OSM course: boundary, acreage, holes and landmarks. */
  course: OsmCourse;
  /** The edge on screen: the contributor's correction, or OpenStreetMap's own. */
  geometry: Polygon | MultiPolygon;
  /** Whether `geometry` is the contributor's correction rather than OSM's line. */
  edited: boolean;
  save: SaveState;
  /** The name the contributor searched for, which may differ from the OSM name. */
  courseName: string;
  onChange: (geometry: Polygon | MultiPolygon) => void;
  onReset: () => void;
  onSave: () => void;
  onContinue: () => void;
  onBack: () => void;
}

/** Every ring of a boundary as an editable path, keyed `polygon:ring`. */
function boundaryPaths(geometry: Polygon | MultiPolygon): EditablePath[] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((rings, p) =>
    rings.map((ring, r) => ({ id: `${p}:${r}`, coords: openRing(ring), closed: true })),
  );
}

/** One ring replaced, the rest untouched, every ring closed again. */
function withRing(geometry: Polygon | MultiPolygon, id: string, coords: LngLat[]): Polygon | MultiPolygon {
  const [p, r] = id.split(':').map(Number);
  const closed = [...coords.map((c) => [c[0], c[1]]), [coords[0][0], coords[0][1]]];
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map((ring, i) => (i === r ? closed : ring)) };
  }
  return {
    type: 'MultiPolygon',
    coordinates: geometry.coordinates.map((rings, i) =>
      i === p ? rings.map((ring, j) => (j === r ? closed : ring)) : rings,
    ),
  };
}

const BOUNDARY_SOURCE = 'osm-course-boundary';
const BOUNDARY_FILL_LAYER = 'osm-course-boundary-fill';
const BOUNDARY_LINE_LAYER = 'osm-course-boundary-line';

const KICKER: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--green-200)',
};

const STAT_CARD: React.CSSProperties = {
  background: 'var(--green-800)',
  border: '1px solid rgba(255,255,255,.12)',
  borderRadius: 'var(--radius-lg)',
  padding: '14px 16px',
};

const STAT_VALUE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 26,
  color: '#fff',
  marginTop: 6,
  fontVariantNumeric: 'tabular-nums',
};

export function BoundaryScreen({
  course,
  geometry,
  edited,
  save,
  courseName,
  onChange,
  onReset,
  onSave,
  onContinue,
  onBack,
}: BoundaryScreenProps) {
  const holeCount = course.mappedHoleRefs.length;
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [editing, setEditing] = useState(false);
  /* OpenStreetMap's own figure until the edge moves; measured live from then on. */
  const acres = useMemo(() => (edited ? areaAcres(geometry) : course.acres), [edited, geometry, course.acres]);
  const landmarks = useMemo(
    () => course.landmarks.map((landmark) => ({ ...landmark, inside: boundaryContains(geometry, landmark.position) })),
    [course.landmarks, geometry],
  );

  const paths = useMemo(() => (editing ? boundaryPaths(geometry) : []), [editing, geometry]);
  useShapeEditor(map, paths, (id, coords) => onChange(withRing(geometry, id, coords)));

  /* The edge follows every drag. */
  useEffect(() => {
    if (!map) return;
    const source = map.getSource(BOUNDARY_SOURCE) as GeoJSONSource | undefined;
    source?.setData({ type: 'Feature', properties: {}, geometry } as never);
  }, [map, geometry]);

  /*
   * The adopted geometry goes on as its own source once the style exists.
   * `onMapReady` fires as soon as the map is constructed, which can be before
   * the style has loaded, so the add is deferred to `load` when it has to be.
   */
  const handleMapReady = useCallback(
    (map: MapLibreMap) => {
      const draw = () => {
        if (map.getSource(BOUNDARY_SOURCE)) return;
        map.addSource(BOUNDARY_SOURCE, {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry },
        });
        map.addLayer({
          id: BOUNDARY_FILL_LAYER,
          type: 'fill',
          source: BOUNDARY_SOURCE,
          paint: { 'fill-color': '#3ecfb4', 'fill-opacity': 0.12 },
        });
        map.addLayer({
          id: BOUNDARY_LINE_LAYER,
          type: 'line',
          source: BOUNDARY_SOURCE,
          paint: { 'line-color': '#3ecfb4', 'line-width': 2.5, 'line-dasharray': [3, 2] },
        });
      };
      const attach = () => {
        try {
          draw();
          map.off('styledata', attach);
        } catch {
          /* The style will not take a source yet; `styledata` brings us back. */
        }
      };
      attach();
      map.on('styledata', attach);
      setMap(map);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first edge only; later ones go through setData
    [],
  );

  return (
    <section
      style={{ display: 'grid', gridTemplateColumns: '1fr 420px', height: 'calc(100vh - 56px)' }}
    >
      <div style={{ position: 'relative', overflow: 'hidden', background: '#22321f' }}>
        <BaseMap
          bounds={course.bbox}
          label={courseName}
          note={editing ? 'reshaping the edge' : edited ? 'your corrected edge' : 'the line OpenStreetMap already holds'}
          onMapReady={handleMapReady}
        >
          <div
            style={{
              position: 'absolute',
              bottom: 20,
              left: 20,
              display: 'flex',
              gap: 18,
              background: 'rgba(6,43,38,.78)',
              border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 'var(--radius-md)',
              padding: '9px 14px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--green-200)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{
                  width: 18,
                  height: 0,
                  borderTop: '2px dashed var(--mint-400)',
                  display: 'block',
                }}
              />
              {course.osmId}
            </span>
            <span>
              matched by {course.matchedBy === 'name' ? 'its name tag' : 'its position'}
            </span>
          </div>
        </BaseMap>
      </div>

      <div
        style={{
          background: 'var(--green-900)',
          borderLeft: '1px solid rgba(255,255,255,.1)',
          padding: 26,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        {editing && (
          <div
            style={{
              background: 'var(--green-800)',
              border: '1px solid var(--mint-400)',
              borderRadius: 'var(--radius-lg)',
              padding: 18,
              boxShadow: 'var(--shadow-md)',
              animation: 'ogRise 190ms var(--ease-out)',
            }}
          >
            <div style={{ ...KICKER, color: 'var(--mint-400)', marginBottom: 10 }}>Editing the course edge</div>
            <h3
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: '-.015em',
                color: '#fff',
                margin: '0 0 6px',
              }}
            >
              Pull the dots until it fits.
            </h3>
            <p style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--green-200)', textWrap: 'pretty' }}>
              Every corner of the line is draggable on the map. Drag a small dot to add a corner, right-click a
              corner to take it out. The acreage and the landmarks below follow as you go.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <Button
                size="lg"
                variant="accent"
                fullWidth
                onClick={() => {
                  if (edited) onSave();
                  setEditing(false);
                }}
              >
                Save this edge
              </Button>
              <HoverButton
                onClick={onReset}
                style={{
                  height: 40,
                  background: 'var(--green-900)',
                  border: '1px solid rgba(255,255,255,.2)',
                  borderRadius: 'var(--radius-md)',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                hoverStyle={{ background: 'var(--green-950)', borderColor: 'rgba(255,255,255,.34)' }}
              >
                Put it back how OpenStreetMap has it
              </HoverButton>
            </div>
          </div>
        )}

        <div>
          <div style={{ ...KICKER, color: 'var(--mint-400)', marginBottom: 8 }}>Before we start</div>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: '-.015em',
              color: '#fff',
              margin: '0 0 8px',
            }}
          >
            Is this the whole course?
          </h2>
          <p style={{ margin: 0, color: 'var(--green-200)', fontSize: 14, textWrap: 'pretty' }}>
            {edited ? 'This is your corrected edge' : 'This is the line OpenStreetMap already holds'}
            {course.name ? `, filed as “${course.name}”` : ''}. Nobody can judge a mile-wide outline by eye —
            check the facts below instead. If an edge cuts off a hole or takes in the car park, drag it.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={STAT_CARD}>
            <div style={{ ...KICKER, fontSize: 10 }}>Holes already on the map</div>
            <div style={STAT_VALUE}>{holeCount}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 6,
                color: holeCount > 0 ? 'var(--mint-400)' : 'var(--green-200)',
                fontSize: 12,
              }}
            >
              {holeCount > 0 && <Icon name="check" size={14} />}
              {holeCount > 0 ? 'traced inside this line already' : 'none inside this line yet'}
            </div>
          </div>

          <div style={STAT_CARD}>
            <div style={{ ...KICKER, fontSize: 10 }}>Land enclosed</div>
            <div style={STAT_VALUE}>
              {Math.round(acres).toLocaleString('en-US')}{' '}
              <span style={{ fontSize: 14, color: 'var(--green-200)' }}>acres</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--green-200)', fontSize: 12 }}>
              {edited && Math.round(acres) !== Math.round(course.acres)
                ? `was ${Math.round(course.acres).toLocaleString('en-US')} in OpenStreetMap`
                : 'measured from the line itself'}
            </div>
          </div>
        </div>

        <div>
          <div style={{ ...KICKER, marginBottom: 10 }}>Landmarks — where the line puts them</div>
          {landmarks.length === 0 ? (
            <p
              style={{
                margin: 0,
                background: 'var(--green-800)',
                border: '1px solid rgba(255,255,255,.1)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                color: 'var(--green-200)',
                fontSize: 13,
                textWrap: 'pretty',
              }}
            >
              OpenStreetMap holds no clubhouse, range or practice area here yet. That is a gap in the
              map, not a problem with the boundary.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {landmarks.map((landmark) => (
                <div
                  key={landmark.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'var(--green-800)',
                    border: '1px solid rgba(255,255,255,.1)',
                    borderRadius: 'var(--radius-md)',
                    padding: '11px 14px',
                  }}
                >
                  <span style={{ color: landmark.inside ? 'var(--mint-400)' : 'var(--green-200)', display: 'flex' }}>
                    <Icon name={landmark.inside ? 'circle-check' : 'x'} size={16} />
                  </span>
                  <span style={{ flex: 1, fontSize: 14, color: '#fff' }}>
                    {landmark.name}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-200)' }}>
                      {' '}
                      · {landmark.kind.toLowerCase()}
                    </span>
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: landmark.inside ? 'var(--mint-400)' : 'var(--green-200)',
                    }}
                  >
                    {landmark.inside ? 'inside' : 'outside'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {save.status === 'saving' && (
          <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--green-200)' }}>
            Saving your edge …
          </p>
        )}
        {save.status === 'saved' && edited && (
          <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--mint-400)' }}>
            Your corrected edge is saved. It goes to OpenStreetMap when uploading is switched on.
          </p>
        )}
        {save.status === 'failed' && (
          <div
            role="alert"
            style={{
              background: 'rgba(180,70,47,.16)',
              border: '1px solid rgba(214,132,110,.6)',
              borderRadius: 'var(--radius-md)',
              padding: '11px 13px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: '#f0cabd',
              textWrap: 'pretty',
            }}
          >
            Your edge is not saved — {save.message}{' '}
            <button
              onClick={onSave}
              style={{ background: 'none', border: 'none', color: '#fff', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' }}
            >
              Try again
            </button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 'auto' }}>
          <Button size="lg" variant="accent" fullWidth onClick={onContinue}>
            Yes, that is the course
          </Button>
          <HoverButton
            onClick={onBack}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,.18)',
              borderRadius: 'var(--radius-md)',
              height: 40,
              color: 'var(--green-100)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            hoverStyle={{ background: 'rgba(255,255,255,.07)' }}
          >
            Not my course — search again
          </HoverButton>
          <button
            onClick={() => setEditing((on) => !on)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--green-200)',
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 2,
            }}
          >
            {editing ? 'Leave the edge alone' : 'The edge is wrong somewhere — let me drag it'}
          </button>
        </div>
      </div>
    </section>
  );
}
