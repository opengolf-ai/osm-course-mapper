import { TopNav, type NavItem } from './components/TopNav';
import { BoardScreen } from './screens/BoardScreen';
import { BoundaryScreen } from './screens/BoundaryScreen';
import { CompleteModal } from './screens/CompleteModal';
import { ReviewScreen } from './screens/ReviewScreen';
import { SearchScreen } from './screens/SearchScreen';
import { useMapper } from './state/useMapper';

export default function App() {
  const mapper = useMapper();
  const { state, derived, actions } = mapper;

  /* Every screen and review mode is reachable directly, so a state is never stranded. */
  const navItems: NavItem[] = [
    { label: 'find', active: state.screen === 'search', go: () => actions.go('search') },
    { label: 'boundary', active: state.screen === 'boundary', go: () => actions.go('boundary') },
    { label: 'holes', active: state.screen === 'board', go: () => actions.go('board') },
    {
      label: 'review',
      active: state.screen === 'review' && state.mode === 'ready',
      go: () => {
        actions.patch({ holeIndex: 0 });
        actions.go('review', 'ready');
      },
    },
    {
      label: 'new hole',
      active: state.screen === 'review' && state.mode === 'locate',
      go: () => {
        actions.patch({ holeIndex: 9 });
        actions.go('review', 'locate');
      },
    },
    {
      label: 'needs attention',
      active: state.screen === 'review' && state.mode === 'attention',
      go: () => {
        actions.patch({ holeIndex: 0 });
        actions.go('review', 'attention');
      },
    },
    { label: 'done', active: state.screen === 'complete', go: () => actions.patch({ screen: 'complete' }) },
  ];

  const showBoard = state.screen === 'board' || state.screen === 'complete';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--green-950)',
        color: 'var(--green-100)',
        fontFamily: 'var(--font-sans)',
        fontSize: 15,
        lineHeight: 1.5,
      }}
    >
      <TopNav items={navItems} />

      {state.screen === 'search' && (
        <SearchScreen
          query={state.query}
          onQuery={actions.setQuery}
          onOpen={(course) => actions.go(course.done === 0 ? 'boundary' : 'board')}
        />
      )}

      {state.screen === 'boundary' && (
        <BoundaryScreen
          flagged={state.flagged}
          onFlag={actions.flagBoundary}
          onConfirm={() => actions.go('board')}
          onBack={() => actions.go('search')}
        />
      )}

      {showBoard && (
        <BoardScreen
          holeStatus={state.holeStatus}
          doneCount={derived.doneCount}
          onOpenHole={actions.openHole}
          onBack={() => actions.go('search')}
        />
      )}

      {state.screen === 'review' && <ReviewScreen mapper={mapper} />}

      {state.screen === 'complete' && (
        <CompleteModal
          holeNum={derived.hi + 1}
          doneCount={derived.doneCount}
          onNextHole={actions.nextHole}
          onBack={() => actions.go('board')}
        />
      )}
    </div>
  );
}
