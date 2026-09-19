const { renderAll } = await import('../.smoke-out/__smoke.js');
const raw = renderAll();
// React separates adjacent text nodes with <!-- -->; strip so needles match the visible string.
const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.replaceAll('<!-- -->', '')]));

// Steps in the review sequence, spelled out here so adding one is a deliberate edit:
// tees, green, fairway, sand, anything else.
const STEP_COUNT = 5;

const CHECKS = [
  ['app',               'Map your home course.'],
  ['app',               'course mapper'],
  // Search renders its idle state on the server: live results arrive from an effect, never from SSR.
  ['app',               'Type a course name to search courses in the United States.'],
  // Step 2: the boundary is a question, checked against facts rather than judged by eye.
  ['boundary',          'Is this the whole course?'],
  ['boundary',          '176 '],
  ['boundary',          'Holes already on the map'],
  ['boundary',          'Pebble Beach Clubhouse'],
  ['boundary',          'inside'],
  ['boundary',          'Yes, that is the course'],
  ['boundary',          'The edge is wrong somewhere — let me drag it'],
  ['boundary',          'Imagery © Esri'],
  ['boundaryBare',      'holds no clubhouse'],
  ['boundarySaveFailed','Your edge is not saved — the service did not answer.'],
  // The board's name and card line come from the loaded course record, not a constant.
  ['board',             'Pebble Beach Golf Links'],
  ['board',             'par 72 · 6,802 yd · 18 holes'],
  ['board',             'of 18 holes on the map'],
  ['board',             'par 4 · 378 yd'],
  ['board',             'On the map'],
  ['board',             'Nothing yet'],
  ['board',             'Nothing is uploaded to OpenStreetMap yet.'],
  // Saved is ours, not OpenStreetMap's, and says so.
  ['boardSaved',        'Saved — not uploaded'],
  // Tile art is a neutral placeholder now — no generated fairway standing in for a real hole.
  ['board',             'no thumbnail yet'],
  ['boardAbsent',       'holds no boundary'],
  // R16: a failed lookup is not zero holes, so no count is printed at all.
  ['boardUnknown',      'Mapped state unknown'],
  ['boardUnknown',      'Unknown'],
  // Step 6a: one tee off the card at a time; with no box the answer is "no such tee".
  ['reviewByHand',      'Where does the blue tee play from?'],
  ['reviewByHand',      'No blue tee on this hole'],
  ['reviewByHand',      'Pick the box'],
  ['reviewByHand',      `check 1 of ${STEP_COUNT}`],
  ['reviewByHand',      'Imagery © Esri'],
  ['reviewByHand',      '382 yd along the line · Blue says 378'],
  // Detection matched the blue tee: that box is highlighted and asked about.
  ['reviewTees',        'Is that where the blue tee plays from?'],
  ['reviewTees',        'Yes, that is the blue tee'],
  ['reviewTees',        'Pick a different box'],
  ['reviewTees',        'Edges look off'],
  ['reviewTees',        'highlighted'],
  ['reviewTees',        'Tee 1 of 5 · Blue'],
  // The suggestion layer names itself in the legend, beside what the contributor owns.
  ['reviewTees',        'we suggest — not yours yet'],
  ['reviewTees',        'you confirmed'],
  // R5: the model's confidence and the NAIP acquisition year, always on screen.
  ['reviewTees',        'What the model read'],
  ['reviewTees',        '86%'],
  ['reviewTees',        'NAIP 2023'],
  ['reviewTees',        'more than 3 years old'],
  // R9: a signed GeoTIFF href is not something a browser can draw — stated, not faked.
  ['reviewTees',        'We cannot put that frame on screen yet'],
  ['reviewCorridor',    'Show me the imagery you read'],
  ['reviewTeePick',     'Click the box you play the blue tee from — open ground draws a new one.'],
  // Step 6b: the green, with its two ways out.
  ['reviewGreen',       'Is that the green?'],
  ['reviewGreen',       'Yes, that is the green'],
  ['reviewGreen',       'That is not the green'],
  ['reviewGreenPlace',  'Click the green you putt on.'],
  // Step 6c: nothing proposed is a question too.
  ['reviewFairwayEmpty','No fairway on this hole. Right?'],
  ['reviewFairwayEmpty','Another piece of fairway'],
  // Step 6d: counted off the real proposals.
  ['reviewBunkers',     'We found 2 bunkers on this hole. Did we miss any?'],
  ['reviewBunkers',     'That is all 2 of them'],
  ['reviewBunkers',     'One of these is not sand'],
  ['reviewBunkers',     'There is another bunker'],
  ['reviewBunkers',     'Edges are off — let me fix them'],
  ['reviewBunkerPick',  'Click the one that is not sand.'],
  ['reviewBunkerEdit',  'Editing the bunkers outline'],
  ['reviewBunkerEdit',  'Put it back how we drew it'],
  ['reviewBunkerPlace', 'Click the map where the bunker is.'],
  // Step 6f: proposed water arrives as a hazard, typed, with the other types on offer.
  ['reviewHazards',     '1 hazard on this hole. Anything else?'],
  ['reviewHazards',     'Hazard 1'],
  ['reviewHazards',     'we spotted it'],
  ['reviewHazards',     'Waste area'],
  ['reviewHazards',     'Draw a hazard'],
  ['reviewNewHazard',   'Your new hazard'],
  ['reviewNewHazard',   'Save this hazard'],
  // Step 7: save, and say plainly when it did not work.
  ['reviewDone',        'Hole 1, confirmed.'],
  ['reviewDone',        'Save hole 1'],
  ['reviewDone',        'all checks done'],
  ['reviewDone',        'playing line, 382 yd over 3 points'],
  ['reviewDone',        '2 bunkers'],
  ['reviewSaveFailed',  'Not saved — the store is not configured.'],
  ['reviewSaveFailed',  'Try saving hole 1 again'],
  ['reviewAttention',   'This one does not add up.'],
  ['reviewAttention',   'The green up by the cypress'],
  ['reviewAttention',   '250 yd tee to green · Blue says 331'],
  // Step 4: the line first.
  ['reviewLocateEmpty', 'Walk us down the hole.'],
  ['reviewLocateEmpty', 'Click the tee you play from.'],
  ['reviewLocateEmpty', 'first, the line of the hole'],
  ['reviewLocateEmpty', 'no line drawn yet · Blue says 495'],
  // R15: the tee set is chosen, not assumed.
  ['reviewLocateEmpty', 'from the Blue tees'],
  ['reviewLocateEmpty', 'from the Red tees'],
  ['reviewLocateDrawing', 'Does the hole run this way?'],
  ['reviewLocateDrawing', 'Yes, that is the hole'],
  ['reviewLocateDrawing', 'Undo last point'],
  // The dogleg measures 382 along its path against a 378 card — inside 10%.
  ['reviewLocateDrawing', 'the Blue tees say 378 — close enough'],
  ['reviewDetecting',   'Reading the imagery'],
  ['reviewDetecting',   'Stop looking — I will map it myself'],
  ['reviewDetectFailed','Detection did not finish — the service did not answer.'],
  ['reviewDetectFailed','Carry on and map it by hand'],
  // R8/R10: a hole already in OpenStreetMap opens showing it, and says whose it is.
  ['reviewOsmHole',     'Already in OpenStreetMap'],
  ['reviewOsmHole',     'Does the hole run this way?'],
  ['reviewOsmHole',     'a green'],
  ['reviewOsmHole',     '382 yd along OpenStreetMap'],
  ['reviewOsmHole',     'Draw it myself'],
  ['complete',          'Hole 1 is saved.'],
  ['complete',          '1 tee box · 1 green · 2 bunkers · water'],
  ['complete',          'Nothing has been sent to OpenStreetMap yet.'],
  ['complete',          'not uploaded · 3 of 18 holes done'],
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
