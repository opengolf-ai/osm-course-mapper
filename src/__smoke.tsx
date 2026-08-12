import { renderToString } from 'react-dom/server';
import App from './App';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { INITIAL, computeDerived, type MapperState, type Mapper } from './state/useMapper';
import { INITIAL_STATUS, STEPS } from './data/course';

const noop = () => {};

function mapperFor(overrides: Partial<MapperState>): Mapper {
  const state: MapperState = { ...INITIAL, screen: 'review', ...overrides };
  return {
    state,
    derived: computeDerived(state),
    actions: new Proxy({}, { get: () => noop }),
  } as unknown as Mapper;
}

export function renderAll(): Record<string, string> {
  return {
    app: renderToString(<App />),

    boundary: renderToString(
      <BoundaryScreen flagged={false} onFlag={noop} onConfirm={noop} onBack={noop} />,
    ),
    boundaryFlagged: renderToString(
      <BoundaryScreen flagged onFlag={noop} onConfirm={noop} onBack={noop} />,
    ),

    board: renderToString(
      <BoardScreen holeStatus={INITIAL_STATUS} doneCount={2} onOpenHole={noop} onBack={noop} />,
    ),

    reviewReady: renderToString(<ReviewScreen mapper={mapperFor({ mode: 'ready' })} />),
    reviewTees: renderToString(<ReviewScreen mapper={mapperFor({ mode: 'ready', step: 2 })} />),
    reviewDone: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'ready',
          step: STEPS.length,
          confirmed: ['green', 'bunkerA', 'bunkerB', 'tee1', 'tee2', 'tee3', 'tee4', 'fairway'],
        })}
      />,
    ),
    reviewAttention: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'attention', holeIndex: 3 })} />,
    ),
    reviewLocateEmpty: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'locate', holeIndex: 9 })} />,
    ),
    reviewLocateDone: renderToString(
      <ReviewScreen
        mapper={mapperFor({
          mode: 'locate',
          holeIndex: 9,
          locate: { tee: { x: 150, y: 620 }, green: { x: 838, y: 150 } },
        })}
      />,
    ),
    reviewAddMode: renderToString(
      <ReviewScreen mapper={mapperFor({ mode: 'ready', step: 1, addMode: 'bunker' })} />,
    ),

    complete: renderToString(
      <CompleteModal holeNum={1} doneCount={3} onNextHole={noop} onBack={noop} />,
    ),
  };
}
