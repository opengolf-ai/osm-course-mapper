/**
 * The course line OpenStreetMap already holds, shown over real imagery.
 *
 * This screen asks nothing (R11). The boundary is not something we traced and
 * offered for approval — it is what OSM already has, adopted as-is, and the
 * screen exists so a contributor knows where they are before they start on
 * holes. Hence one action onward and no accept, reject, or per-landmark verdict.
 */
import { useCallback } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { OsmCourse } from '../api/overpass';
import { Button, Icon } from '../ds';
import { HoverButton } from '../components/HoverButton';
import { BaseMap } from '../map/BaseMap';

interface BoundaryScreenProps {
  /** The adopted OSM course: boundary, acreage, holes and landmarks. */
  course: OsmCourse;
  /** The name the contributor searched for, which may differ from the OSM name. */
  courseName: string;
  onContinue: () => void;
  onBack: () => void;
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

export function BoundaryScreen({ course, courseName, onContinue, onBack }: BoundaryScreenProps) {
  const holeCount = course.mappedHoleRefs.length;

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
          data: { type: 'Feature', properties: {}, geometry: course.boundary },
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
      if (map.isStyleLoaded()) draw();
      else map.once('load', draw);
    },
    [course.boundary],
  );

  return (
    <section
      style={{ display: 'grid', gridTemplateColumns: '1fr 420px', height: 'calc(100vh - 56px)' }}
    >
      <div style={{ position: 'relative', overflow: 'hidden', background: '#22321f' }}>
        <BaseMap
          bounds={course.bbox}
          label={courseName}
          note="the line OpenStreetMap already holds"
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
            Here is the course, as OpenStreetMap has it
          </h2>
          <p style={{ margin: 0, color: 'var(--green-200)', fontSize: 14, textWrap: 'pretty' }}>
            Nobody drew this for you to judge — the line is already in OpenStreetMap
            {course.name ? `, filed as “${course.name}”` : ''}. Get your bearings, then get to the
            holes.
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
              {Math.round(course.acres).toLocaleString('en-US')}{' '}
              <span style={{ fontSize: 14, color: 'var(--green-200)' }}>acres</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--green-200)', fontSize: 12 }}>
              measured from the line itself
            </div>
          </div>
        </div>

        <div>
          <div style={{ ...KICKER, marginBottom: 10 }}>
            Landmarks OpenStreetMap holds inside the line
          </div>
          {course.landmarks.length === 0 ? (
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
              OpenStreetMap holds no clubhouse, range or practice area inside this line yet. That is
              a gap in the map, not a problem with the boundary.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {course.landmarks.map((landmark) => (
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
                  <span style={{ color: 'var(--mint-400)', display: 'flex' }}>
                    <Icon name="circle-check" size={16} />
                  </span>
                  <span style={{ flex: 1, fontSize: 14, color: '#fff' }}>{landmark.name}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--green-200)',
                    }}
                  >
                    {landmark.kind.toLowerCase()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 'auto' }}>
          <Button size="lg" variant="accent" fullWidth onClick={onContinue}>
            Continue to the holes
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
        </div>
      </div>
    </section>
  );
}
