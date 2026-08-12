const { renderAll } = await import('../.smoke-out/__smoke.js');
const raw = renderAll();
// React separates adjacent text nodes with <!-- -->; strip so needles match the visible string.
const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replaceAll('<!-- -->', '')]));

const CHECKS = [
  ['app',               'Map your home course.'],
  ['app',               'course mapper'],
  // Search renders its idle state on the server: live results arrive from an effect, never from SSR.
  ['app',               'Type a course name to search courses in the United States.'],
  ['boundary',          'Is this the whole course?'],
  ['boundary',          '176 '],
  ['boundary',          'Carmel Bay shoreline'],
  ['boundaryFlagged',   'You flagged something.'],
  // The board's name and card line come from the loaded course record, not a constant.
  ['board',             'Pebble Beach Golf Links'],
  ['board',             'par 72 · 6,802 yd · 18 holes'],
  ['board',             'of 18 holes on the map'],
  ['board',             'par 4 · 378 yd'],
  ['board',             'Ready to review'],
  ['board',             'Needs attention'],
  ['board',             'On the map'],
  ['board',             'Nothing yet'],
  ['reviewReady',       'Is that the green?'],
  ['reviewReady',       'check 1 of 5'],
  ['reviewReady',       'tee to green 378 yd · card says 378'],
  ['reviewReady',       'A accept · N not there · M missed one'],
  ['reviewTees',        'Which tee is which?'],
  ['reviewTees',        'furthest back'],
  ['reviewTees',        '<option value="Blue">Blue · 378 yd</option>'],
  ['reviewDone',        'Hole 1, confirmed.'],
  ['reviewDone',        'Put hole 1 on the map'],
  ['reviewDone',        'all checks done'],
  ['reviewDone',        '2 bunkers'],
  ['reviewAttention',   'This one does not add up.'],
  ['reviewAttention',   'The green up by the cypress'],
  ['reviewAttention',   'matches the card'],
  ['reviewAttention',   'tee to green 250 yd · card says 331'],
  ['reviewLocateEmpty', 'Show us where this hole plays.'],
  ['reviewLocateEmpty', 'Click where you tee off.'],
  ['reviewLocateEmpty', 'first, the outline of the hole'],
  ['reviewLocateEmpty', 'tee to green — yd'],
  ['reviewLocateDone',  'Find the rest of the hole'],
  ['reviewLocateDone',  'yd tee to green'],
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
