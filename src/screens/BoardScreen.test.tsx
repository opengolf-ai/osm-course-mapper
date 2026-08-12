/**
 * The board has to tell three different stories about what OpenStreetMap holds:
 * a real count, an honest zero, and "we do not know". R16 turns on the third one
 * never being rendered as the second.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OsmLookup } from '../api/overpass';
import type { CourseDetail } from '../api/types';
import { buildCourseSession, holeStatusesFrom } from '../state/courseSession';
import { BoardScreen } from './BoardScreen';

function detail(): CourseDetail {
  return {
    id: 'course-1',
    course_name: 'Pebble Beach Golf Links',
    latitude: 36.5685,
    longitude: -121.949,
    par: 72,
    holes: 18,
    tees: [{ tee_key: 'blue-male', tee_name: 'Blue', tee_color: 'blue', yardage: 6802 }],
    holes_data: Array.from({ length: 18 }, (_, i) => ({
      number: i + 1,
      par: 4,
      handicap_index: i + 1,
      yardages: { blue: 380 + i },
    })),
  };
}

const COURSE = buildCourseSession(detail());

function renderBoard(osm: OsmLookup) {
  const holeStatus = holeStatusesFrom(COURSE, osm);
  render(
    <BoardScreen
      course={COURSE}
      holeStatus={holeStatus}
      doneCount={holeStatus.filter((s) => s === 'complete').length}
      osm={osm}
      onOpenHole={() => {}}
      onBack={() => {}}
    />,
  );
}

describe('the board and what OpenStreetMap holds', () => {
  it('renders no numeric count when the lookup failed, and says so', () => {
    renderBoard({ status: 'unknown', message: 'it did not answer in time' });

    /* R16: unknown is not zero. A count here would be a claim we cannot make. */
    expect(screen.queryByText(/holes on the map/)).toBeNull();
    expect(screen.getByText(/mapped state unknown/i)).toBeDefined();
    expect(screen.getByText(/did not answer in time/)).toBeDefined();
    expect(screen.getAllByText('Unknown')).toHaveLength(18);
  });

  it('opens directly with a stated banner when OpenStreetMap holds no boundary', () => {
    renderBoard({ status: 'absent' });

    expect(screen.getByText(/holds no boundary/i)).toBeDefined();
    expect(screen.getByText(/of 18 holes on the map/)).toBeDefined();
    expect(screen.getAllByText('Nothing yet')).toHaveLength(18);
  });

  it('marks exactly the holes Overpass returned as already on the map', () => {
    renderBoard({
      status: 'found',
      course: {
        osmId: 'relation/3741806',
        name: 'Pebble Beach Golf Course',
        boundary: {
          type: 'Polygon',
          coordinates: [
            [
              [-121.955, 36.563],
              [-121.943, 36.563],
              [-121.943, 36.574],
              [-121.955, 36.563],
            ],
          ],
        },
        acres: 176,
        bbox: [-121.955, 36.563, -121.943, 36.574],
        mappedHoleRefs: [1, 2, 3],
        landmarks: [],
        matchedBy: 'name',
      },
    });

    expect(screen.getByText(/of 18 holes on the map/)).toBeDefined();
    expect(screen.getAllByText('On the map')).toHaveLength(3);
    expect(screen.getAllByText('Nothing yet')).toHaveLength(15);
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});
