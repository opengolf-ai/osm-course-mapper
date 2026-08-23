# Residual review findings — AI hole feature detection

Accepted, not fixed. Recorded here because this repository has no git remote (so
no PR description to carry them) and no configured issue tracker.

- **Review run:** `20260812-195457-62531e38`
- **Artifacts:** `/tmp/compound-engineering-501/ce-code-review/20260812-195457-62531e38/`
  (`review.json` plus one JSON file per reviewer; note `/tmp` does not survive a reboot)
- **Branch:** `feat/live-course-data-and-imagery`
- **Reviewed diff:** client half only, base `7908a8e` — 14 files, 4,213 insertions
- **Plan:** `docs/plans/2026-08-12-002-feat-ai-hole-feature-detection-plan.md`
- **Reviewers:** correctness, security, adversarial, reliability, julik-frontend-races,
  api-contract, testing, maintainability
- **Fixed and committed in `3566e10`:** findings #1, #2, #4, #5 (all P1)
- **Later fixed:** findings #6 and #8 — see "Resolved after the fact" below

Finding numbers below are the review's stable identifiers, so they still line up
with `review.json`.

## Open actionable findings

### #6 — RESOLVED — Corridor overlay waits on a load event that already fired
`src/map/BaseMap.tsx:282`

The overlay can silently never attach, so the contributor cannot check a proposal
against the imagery the model read. MapLibre's style `loaded()` returns false
whenever any tile or image is still loading — long after `load` has fired once —
so the effect's `once('load')` fallback waits for an event that will never fire
again.

**Fix:** record the real style-load state in the construction effect, which
registers *before* `load` fires, and gate the overlay add on it. Remove the
listener in cleanup.

Found independently by correctness and adversarial. Validated.

### #7 — P2 — Malformed `poll_url` throws uncaught and strands detection
`src/api/detect.ts:464`

`poll_url` is only checked for being a non-empty string, so `new URL(...)` throws
inside the async function, and the call site chains `.then` with no `.catch`. The
spinner runs forever with no stated failure. This contradicts the module's own
documented contract that nothing in it throws.

**Fix:** wrap the `new URL` call in try/catch returning the module's `malformed`
failure, and add a `.catch` to the promise chain in `useMapper` so no throw can
leave detection pinned at `working`.

Found independently by correctness and reliability. Validated.

### #8 — still open — Corridor overlay image-load failures are never surfaced
`src/map/BaseMap.tsx:189`

The rail claims to be showing the imagery the model read while the map shows
nothing, because the error handler matches only the base imagery source id. An
expired signed link or a network blip produces silence.

**Fix:** route overlay-scoped errors too and surface a distinct overlay-load-failed
status so the rail can say the frame did not load. Depends on #6 — reporting a
failure is meaningless while the layer may never have been added at all.

Validated.

### #9 — P2 — `undoLastPoint` keeps detection alive
`src/state/useMapper.ts:1051`

Taking back a point after finishing a line leaves the in-flight request running,
so proposals computed for the old line land on the new one. `resetLocate` already
calls `dropDetection()` for exactly this reason.

**Fix:** call `dropDetection()` from `undoLastPoint` when the line was already
finished. Same one-line shape as the #2 fix already committed.

Not validated — fell outside the validator's eight-finding batch cap.

### #10 — P2 — Stale detection-response guard is untested
`src/state/useMapper.ts:936`

The identity check that stops a superseded response overwriting current state has
no test, so a regression there would ship silently. The existing cancel test uses
a promise that never resolves, so the guard's branch is never taken.

**Fix:** resolve two overlapping `requestProposals` calls out of order and assert
only the latest controller's result lands. Cover `detectRequestFor`'s out-of-range
par, tee yardage and tee-set-count handling in the same pass.

Not validated — outside the batch cap.

### #11 — P3 — Timeout notice repeats the service's own reassurance
`src/screens/ReviewScreen.tsx:1189`

The contributor reads "the hole is still yours to map by hand" twice, because the
client copy appends text the service's default message already ends with.

**Fix:** drop the trailing sentence from the client copy.

Not validated — outside the batch cap.

## Resolved after the fact

**#6 turned out to be reachable in the review screen too, and it was breaking
the core flow.** The same `isStyleLoaded()` / `once('load')` pattern guarded the
review feature source, so on a real map the source and all four layers were
never added: a contributor drew a line and saw nothing on the map, because the
HTML captions render independently of it. Both sites now attempt the add
immediately and retry on `styledata`. Regression tests cover the busy-style
window at both. Accepting this as a P2 residual under-read it — it was a P1 in
the drawing path.

## Pre-existing (not introduced by this work)

### #3 — Stale advance timer can advance a step the contributor left
`src/state/useMapper.ts:863`

A pending 260 ms timer is never cleared by a decision or by navigation. Two
reviewers filed this as new; validation proved the arming line and its
unmount-only cleanup are byte-identical at the review base, so it predates this
work. The stakes did rise — steps now hold real proposals — so it is worth fixing
even though it is not a regression.

## Residual risks

- **Pre-deploy decision.** The detect calls send no credentials and no
  authorization header, so a cookie-based identity proxy could not gate them.
  Decide the proxy's auth mechanism and make the client match before deploying
  (`src/api/detect.ts:219`).
- `poll_url` is resolved against the service base without pinning its origin, so a
  compromised or misconfigured service could redirect polling to another host.
- Decision POSTs carry no proposal or job identity, so the store cannot dedupe a
  re-answered proposal; repeated answers accumulate as separate observations.
- `accept` / `reject` / `answerInPlay` read the active proposal from the render
  closure but compute the next index inside the functional updater. No reachable
  window was proven, but the mismatch is structural.
- The review-substate reset object literal is duplicated across five call sites in
  `useMapper.ts` and must stay in sync.
- `toImagery` validates that `bounds_wgs84` holds four finite numbers but not that
  west < east and south < north; a transposed envelope would render mirrored.
- The signed imagery URL is never logged, persisted, or rendered into the DOM, but
  it does sit in the MapLibre source config and the browser network log for the
  map's lifetime.
- `rejections` accumulates for a whole course session with no cap.
- `corridorAsked` is not reset on hole navigation; currently masked by detection
  state resetting.
- The legend swatch for the active status still hardcodes a raw CSS var rather
  than the exported `ACTIVE_COLOR`.
- An empty-but-successful detection announces "We found 0 things" rather than the
  silence wording the no-coverage path uses.
- **No ErrorBoundary exists anywhere in `src/`.** The #4 fix removed the known
  trigger, but any future throw inside `computeDerived` still white-screens the app.

## Testing gaps

- No coverage of `detectRequestFor`'s out-of-range par, tee yardage, or
  tee-set-count handling.
- No test covers a rejected or malformed `/v1/decisions` response, nor asserts on
  the resolved result from `sendDecision`.
- No test exercises the overlay effect against an already-loaded map — the fakes
  always report `isStyleLoaded()` true, which is exactly the path #6 describes.
- No test emits a map error event scoped to the corridor overlay's source id.
- The staleness smoke needle renders without a pinned clock, so it reads the wall
  clock.
- The timeout-loop test uses a loose bound rather than an exact poll count.

## Coverage caveats for whoever picks this up

- **No cross-model peer ran.** No different-family reviewer CLI is installed
  (`codex`, `grok`, `cursor-agent` all absent; host family is `claude`), so the
  adversarial lens ran in-process. It produced three of the four P1s and has **no
  independent cross-family corroboration**.
- Findings #9, #10 and #11 were never validated — they fell outside the
  validator's eight-finding batch cap.
- Two maintainability findings ("file crosses 1000 lines", twice) were suppressed
  as unanchored code-quality opinion: this repo has no `CLAUDE.md` or `AGENTS.md`
  to anchor a file-length rule.
- The review covered the client half only. The Python service under `service/` was
  below the review base and has not been code-reviewed.
