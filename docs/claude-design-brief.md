# Claude Design brief — OSM Golf Course Mapper

Paste everything below the line into Claude Design.

---

Design the user experience for a desktop web tool that lets golfers map their home golf course into OpenStreetMap by reviewing AI-proposed geometry instead of drawing it.

## The product in one paragraph

Golf courses are badly mapped in OpenStreetMap. Thousands have a course boundary drawn and nothing inside it, because tracing eighteen greens, fifty bunkers, and every tee complex by hand is hours of tedious GIS work. This tool detects those features automatically from aerial imagery, checks its own work against the course's published scorecard, and then asks a golfer to confirm them — one hole at a time. Each finished hole uploads to OpenStreetMap under the contributor's own account.

## Who is using it

A golfer who knows one specific course intimately. They know the 7th green has a false front and two bunkers left. They have never heard of OpenStreetMap, do not know what a "polygon" or a "way" is, and will close the tab if they see a GIS toolbar. They are on a laptop, at home, deliberately setting aside twenty minutes.

## The single most important design principle

**The AI owns geometry. The human owns golf knowledge.**

Never ask this person whether an outline is shaped correctly — they have no opinion and asking will lose them. Ask them golf questions:

- "We found 2 bunkers on this hole. Miss any?"
- "Which of these is the green?"
- "Is this pond in play, or just drainage?"
- "Which tee is which?"

Geometry correction must exist as an escape hatch, but it should never be the main path and should never be the first thing a user sees. If your design makes vertex-dragging feel like the primary interaction, it has failed.

## Screens to design

**1. Find your course**
Search by course name or location. Results are real golf courses with name, city, state, and a small indicator of how much of it is already mapped. Low ceremony — this screen should take five seconds.

**2. Confirm the course boundary** *(only appears when the course has no boundary yet)*
A single detected outline of the whole property over aerial imagery. The design problem here is real: a mile-wide irregular polygon is something a person cannot verify by eye, so this screen must present *evidence* rather than just the shape — how many holes were detected inside it versus how many the scorecard says exist, the enclosed acreage, and whether recognizable things (clubhouse, practice range, adjacent roads) fall inside or outside. Make approving this feel like checking facts, not rubber-stamping a shape.

**3. The hole board** — the home base of the product
All 18 holes as tiles. Each tile shows its number, par, yardage, a small preview of the hole, and its state:
- *Unmapped* — nothing proposed yet
- *Ready to review* — AI drew it and it passed the scorecard check
- *Needs attention* — AI drew it but the measurements disagree with the scorecard
- *Complete* — uploaded to OpenStreetMap

Progress across the course should be legible at a glance. A contributor may do one hole and leave; the board must make that feel like a complete, successful session rather than an abandoned one.

**4. Hole review** — the core screen, design this most carefully
Aerial imagery of a single hole, framed tee-to-green, with the AI's proposed features drawn over it: tee boxes, green, bunkers, water, fairway. Alongside the map, a review sequence walks the contributor through confirming each feature with large, obvious Accept / Fix / Not there controls.

Design considerations that matter here:
- The scorecard for this hole should be visible, because it is the ground truth the whole product rests on. It also tells the contributor what they are checking against.
- The map is the hero. Chrome should get out of its way.
- Show which feature the current question is about, unmistakably — the contributor must never wonder which shape you mean.
- Show progress through the hole's features, so the end is always visible.
- "Not there" and "we missed one" need equal footing with "accept" — false positives and false negatives are both common.

**5. Needs attention variant of hole review**
Same screen, but the hole failed its scorecard check — the AI's tee-to-green line measures 250 yards when the card says 378. Communicate what disagrees and why, in golf terms, without technical jargon. The likely cause is a green or tee assigned to the wrong hole.

**6. Hole complete**
Brief, satisfying confirmation that the hole is now in OpenStreetMap, and a clear path back to the board. Do not overdo it — this happens up to eighteen times per course.

## Real data to design against

Use Pebble Beach Golf Links, hole 1. It is a par 4, handicap index 6, playing:

| Tee | Yardage |
|---|---|
| Blue | 378 |
| Gold | 349 |
| White | 337 |
| Green | 328 |
| Red | 310 |

Course totals: par 72, 6,802 yards, 18 holes, designed 1919 by Jack Neville and Douglas Grant.

Use real golf language throughout — tee box, green, bunker, fairway, hazard, par, handicap. Never use "polygon," "feature," "geometry," "node," "way," "tag," or "changeset" in any user-facing string.

## Visual direction

This should feel like a golf product, not a GIS tool. Aerial imagery is the hero and everything else is chrome around it — a darker interface lets the imagery carry the screen. The AI's proposed shapes need to read as *proposed*, visually distinct from anything confirmed, so a contributor always knows what has been decided and what has not. Keep it calm and confident; this is careful work, not a game.

## Anti-goals — do not design these

- No gamification: no points, badges, streaks, or leaderboards.
- No onboarding tour, tooltips explaining OpenStreetMap, or educational interstitials.
- No GIS toolbar, layer panel, or coordinate readout.
- No social features, profiles, or activity feeds.
- No mobile layouts — desktop only.
- No dashboard of global mapping progress. The contributor cares about one course.

## What to optimize for

How fast a non-technical person can go from opening a hole to confidently finishing it — and how certain they feel that what they just approved is correct.
