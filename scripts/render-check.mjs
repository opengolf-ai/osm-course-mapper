const { renderAll } = await import('../.smoke-out/__smoke.js');
const raw = renderAll();
// React separates adjacent text nodes with <!-- -->; strip so needles match the visible string.
const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replaceAll('<!-- -->', '')]));

// Steps in the review sequence, spelled out here so adding one is a deliberate edit:
// green, bunkers, tees, fairway, water in play, other hazards.
const STEP_COUNT = 6;

const CHECKS = [
  ['app',               'Map your home course.'],
  ['app',               'course mapper'],
  // Search renders its idle state on the server: live results arrive from an effect, never from SSR.
  ['app',               'Type a course name to search courses in the United States.'],
  // The boundary is adopted from OpenStreetMap and presented, never approved.
  ['boundary',          'Here is the course, as OpenStreetMap has it'],
  ['boundary',          '176 '],
  ['boundary',          'Holes already on the map'],
  ['boundary',          'Pebble Beach Clubhouse'],
  ['boundary',          'Continue to the holes'],
  ['boundary',          'Imagery © Esri'],
  ['boundaryBare',      'holds no clubhouse'],
  // The board's name and card line come from the loaded course record, not a constant.
  ['board',             'Pebble Beach Golf Links'],
  ['board',             'par 72 · 6,802 yd · 18 holes'],
  ['board',             'of 18 holes on the map'],
  ['board',             'par 4 · 378 yd'],
  ['board',             'On the map'],
  ['board',             'Nothing yet'],
  // Tile art is a neutral placeholder now — no generated fairway standing in for a real hole.
  ['board',             'no thumbnail yet'],
  ['boardAbsent',       'holds no boundary'],
  // R16: a failed lookup is not zero holes, so no count is printed at all.
  ['boardUnknown',      'Mapped state unknown'],
  ['boardUnknown',      'Unknown'],
  // R7/R8: with nothing proposed the step is kept, not skipped, and says which it is.
  ['reviewReady',       'We did not find a green here.'],
  ['reviewReady',       'Nothing to confirm — carry on'],
  ['reviewReady',       `check 1 of ${STEP_COUNT}`],
  // The suggestion layer names itself in the legend, beside what the contributor owns.
  ['reviewReady',       'we suggest — not yours yet'],
  ['reviewReady',       'you confirmed'],
  // Every map screen is real imagery now, so the review screen carries the same credits.
  ['reviewReady',       'Imagery © Esri'],
  ['reviewReady',       'no line drawn yet · Blue says 378'],
  ['reviewReady',       'A accept · N not there · M missed one'],
  ['reviewTees',        'No tee boxes proposed on this hole.'],
  ['reviewTees',        'furthest back'],
  ['reviewTees',        '<option value="Blue">Blue · 378 yd</option>'],
  // R7: one proposal at a time, counted off the real list rather than hardcoded copy.
  ['reviewProposals',   'Bunker 2 of 2 — is that sand?'],
  ['reviewProposals',   '2 / 2 suggested'],
  ['reviewProposals',   'That is not sand'],
  ['reviewDone',        'Hole 1, confirmed.'],
  ['reviewDone',        'Put hole 1 on the map'],
  ['reviewDone',        'all checks done'],
  // The summary states only what was actually drawn — the real OSM way for Pebble hole 1.
  ['reviewDone',        'playing line, 382 yd over 3 points'],
  ['reviewAttention',   'This one does not add up.'],
  ['reviewAttention',   'The green up by the cypress'],
  ['reviewAttention',   'matches the card'],
  ['reviewAttention',   '250 yd tee to green · Blue says 331'],
  ['reviewLocateEmpty', 'Show us where this hole plays.'],
  ['reviewLocateEmpty', 'Click where you tee off.'],
  ['reviewLocateEmpty', 'draw the line the hole plays'],
  ['reviewLocateEmpty', 'no line drawn yet · Blue says 495'],
  ['reviewLocateEmpty', '0 points marked'],
  // R15: the tee set is chosen, not assumed.
  ['reviewLocateEmpty', 'from the Blue tees'],
  ['reviewLocateEmpty', 'from the Red tees'],
  // Mid-draw: undo and finish are both offered, and finish is not yet the point.
  ['reviewLocateDrawing', 'Undo last point'],
  ['reviewLocateDrawing', 'Finish the line'],
  ['reviewLocateDrawing', '2 points marked'],
  ['reviewLocateDrawing', 'Click where the hole bends, then the green you putt on.'],
  // The dogleg measures 382 along its path against a 378 card — inside 10%.
  ['reviewLocateDone',  'Save this line and carry on'],
  ['reviewLocateDone',  '382 yd along your line · Blue says 378'],
  ['reviewLocateDone',  'the Blue tees say 378 — close enough'],
  ['reviewAddMode',     'Click the map where the bunker is.'],
  ['complete',          'Hole 1 is on the map.'],
  ['complete',          'Anyone pulling Pebble Beach Golf Links'],
  ['complete',          'signed as your OpenStreetMap account'],
  ['complete',          '3 of 18 holes done'],
];

let bad = 0;
for (const [key, needle] of CHECKS) {
  const ok = typeof out[key] === 'string' && out[key].includes(needle);
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + key.padEnd(18) + JSON.stringify(needle));
}

// Guard against the classic React slip: literal "undefined"/"NaN" reaching the DOM.
for (const [k, v] of Object.entries(out)) {
  if (/>(\s*)(undefined|NaN)|undefined(px|%| yd)|NaN/.test(v)) { bad++; console.log('FAIL  undefined/NaN rendered in ' + k); }
}

console.log(bad === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
