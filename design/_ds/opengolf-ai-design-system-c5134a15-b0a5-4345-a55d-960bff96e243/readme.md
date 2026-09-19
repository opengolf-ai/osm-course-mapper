# opengolf.ai — Design System

opengolf.ai builds and contributes to open source golf initiatives: shared schemas, parsers, course geometry and benchmarks that anyone can use, fork or mirror. The brand has to read as two things at once — **golf** (course green, a flag on a pole, plotted survey grids) and **open infrastructure** (mono type, code blocks, version badges, tables of real numbers).

## Sources given

| Source | What it contained |
|---|---|
| `uploads/Gemini_Generated_Image_4hr2dx4hr2dx4hr2.png` | Full logo lockup on the paper plate with the faint plotted grid — the origin of every colour and the type direction |
| `uploads/Gemini_Generated_Image_une0u9une0u9une0.png` | Square mark crop (flag + node graph) |
| Company description | "opengolf.ai builds and contributes to open source golf initiatives" |

No codebase, Figma file, deck or live site was supplied. **Everything beyond the logo — product surfaces, copy, component inventory — is a reasoned extrapolation from the mark and that one-line description, and should be reviewed before it is treated as canon.** Colours and the two-tone wordmark treatment are sampled pixel-for-pixel from the supplied art and are safe.

---

## CONTENT FUNDAMENTALS

The voice is that of a maintainer writing a good README: plain, exact, unsentimental, quietly proud of the work. It never sells.

**Person.** "We" for the project ("We publish the schemas"), "you" for the reader ("Pull anything, no key needed"). Never "our platform", never "users" — say *contributors*, *maintainers*, *anyone*.

**Casing.** Sentence case everywhere — headlines, buttons, table headers excepted (those are UPPERCASE micro-labels). Machine values keep their real casing and live in mono: `pga-tour/2025`, `Apache-2.0`, `sg`, `v2.1.0`.

**Sentence shape.** Short declaratives with a concrete number in them. Prefer "4,218,904 shots across 41 events" to "millions of data points". Claims are falsifiable or they are cut.

**Headlines.** Four to six words, a full stop, no hype verb:
- "Golf data, in the open."
- "Six repositories, one schema"
- "Pull anything, no key needed"
- "Built by people who count their own putts" ← the one place warmth is allowed

**Body.** One idea per sentence, ≤ 28 words. Example: *"Contributions arrive as pull requests against the public spec; every merged change ships with a versioned changelog entry."*

**Buttons.** Verb + object, sentence case, no trailing punctuation: "Browse the datasets", "Copy pull command", "Create a key", "Mirror the registry". Never "Learn more", "Get started free", "Sign up now".

**Status strings.** Lowercase and machine-flavoured in badges: `passing`, `live`, `beta`, `frozen`, `deprecated`, `cut`. Human-facing labels are title case: `Apache-2.0`, `Free tier`.

**Empty and error states** state the fact and the next move: *"Rate limit reached — retry in 40s or request a key."* No apologies, no exclamation marks.

**Emoji: never.** Not in UI, not in docs, not in the changelog. Status is carried by a coloured dot or a Lucide glyph. Unicode arrows are fine inline (`←`, `→`, `·`).

**Numbers.** Always mono, always tabular figures, thousands separators, units as a lighter suffix: `612 MB`, `+1.42`, `168.4 yd`.

---

## VISUAL FOUNDATIONS

**Colour.** Two greens and paper. Deep green `--green-800 #0d4a42` (the wordmark) is the primary action and heading colour; forest `--green-600 #186048` (the pennant) is for illustrative fills and iconography; mint `--mint-400 #3ecfb4` (the node graph) is the single accent — one mint element per screen, plus focus rings and dark-surface links. Neutrals are warm and faintly green-shifted (`--paper #f9faf4`, `--ink-800 #1c2f2a`) — **never pure grey, never pure white backgrounds**. Status uses amber/clay/sky at low saturation so nothing out-shouts mint. No gradients anywhere except the optional protection scrim over photography; no purple, no blue-violet.

**Type.** One family for everything human (Figtree — geometric humanist, double-storey *a*, matching the wordmark), one for everything machine (IBM Plex Mono). Display is 800 weight at `-0.03em`; headings 600–700 at `-0.015em`; body 15px/1.5; micro labels 11px uppercase at `0.14em`. The mono/sans split is the system's strongest signal: **if a value could be pasted into a terminal, it is mono.**

**Spacing & layout.** 4px base. Component padding 16/24; section rhythm 64–96; page container 1280 with 32px gutters, prose capped at 720. Layout is a plain grid — content-left, evidence-right (headline beside a code block, table beside a filter rail). The header is sticky and translucent (`rgba(249,250,244,.86)` + `saturate(140%) blur(14px)`); nothing else is fixed.

**Backgrounds.** Paper by default. The one brand texture is the **plotted grid plate** — a 32px `--grid-plate` line grid on paper, lifted straight from the logo art, used behind heroes, brand plates and empty states. Alternating sections use `--paper-2` (sunken) rather than a new hue. Deep-green bands (`--green-900`) close pages: footers, terminal panels, toasts. No hand-drawn illustration, no stock photography by default; if photography is used it should be cool, overcast, wide, low-contrast course landscape — never a smiling golfer close-up.

**Borders.** Hairline 1px, `--border-subtle` on light surfaces, `rgba(255,255,255,.10–.16)` inverted. Borders do the separating work that shadows do elsewhere.

**Shadows.** Near-flat and green-tinted: `--shadow-xs` on cards and buttons, `--shadow-md` only on hover, `--shadow-lg` only on things that float (dialog, toast). Focus is a 3px mint glow `--shadow-focus`, never a browser outline. One inner shadow token exists (`--shadow-inset`) for pressed toolbar chips; use it rarely.

**Corner radii.** 10px is the default control radius (buttons, inputs, selects, tiles), 14px for cards and dialogs, 6px for tags and small chips, 4px for checkboxes, pill only for badges and switches. Nothing is fully round except avatars and status dots.

**Cards.** White on paper, 14px radius, 1px `--border-subtle`, `--shadow-xs`. Interactive cards lift 2px and go to `--shadow-md` on hover — that is the only lift in the system. Never a coloured left-border accent stripe.

**Interaction.** Hover *darkens* solid buttons (800 → 900) and warms ghost/secondary to `--paper-2`; press goes one step darker **and nudges 1px down** — nothing ever scales. Rows hover to `--green-50`. Disabled is 45% opacity, no colour change.

**Motion.** 130ms for controls, 190ms for surfaces, 280ms for overlays, all on `--ease-out cubic-bezier(.2,.8,.25,1)`. Fades and 1–8px translations only: no bounce, no spring, no parallax, no scroll-jacking. Toasts rise 8px and fade in; dialogs fade with the scrim.

**Transparency & blur.** Two sanctioned uses: the sticky header plate, and the dialog scrim (`--overlay-scrim`, deep green at 44%, 2px blur). Nothing else is translucent.

**Dark surfaces.** Not a full dark mode — a scoped inversion. Wrap a section in `.og-inverse` and the semantic tokens flip to deep green; used for footers, code blocks and toasts.

---

## ICONOGRAPHY

No icon set was supplied. **Substitution flagged:** the system uses **Lucide** (24×24, 1.5px stroke, round caps) — the closest match to the mark's thin, evenly-weighted node graph — copied into `assets/icons/` as SVGs (32 glyphs, no CDN needed). Brand marks (GitHub, Discord, Python) come from **Simple Icons** and live in `assets/brand-icons/`; they are filled, monochrome, and are never recoloured to brand green.

- Icons are rendered through `<Icon name="…">`, which masks the SVG with `currentColor` — never `<img>`, never inline hand-drawn SVG.
- Sanctioned sizes: 13 (inside badges), 14–16 (inline with text), 18 (buttons, list bullets), 22–24 (feature markers).
- Icons never appear alone as the sole meaning of a control unless wrapped in a `Tooltip` (or given an `IconButton` `label`).
- Recurring vocabulary: `flag` (opengolf itself), `git-branch` / `git-pull-request` (contribution), `database` (datasets), `map-pin` (courses), `terminal` / `code` (snippets), `scale` (licence), `trending-up` (strokes gained), `book-open` (docs), `users` (community).
- **Emoji are never used.** Unicode `·`, `←`, `→` are permitted in copy.
- The logo mark is not an icon: it never sits in a toolbar or a list row.

---

## Logo

`assets/logo-lockup.png`, `assets/logo-mark.png`, `assets/logo-wordmark.png` are background-keyed extractions of the supplied artwork — **the only sanctioned artwork**. They are raster; no vector was provided (see caveats). Clear space equals the wordmark cap height; minimum wordmark height 18px. Never recolour, outline, rotate or redraw the mark. On deep green, place the lockup on a light plate or use the mark alone.

---

## Index

**Root**
- `styles.css` — the single entry point consumers link (imports only)
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `elevation.css`, `motion.css`, `base.css`
- `assets/` — logo PNGs, `icons/` (Lucide), `brand-icons/` (Simple Icons)
- `guidelines/` — 19 foundation specimen cards (Colors, Type, Spacing, Brand)
- `thumbnail.html`, `SKILL.md`, `readme.md`

**Components** (`components/<group>/`, each with `.jsx` + `.d.ts` + `.prompt.md`)
- **brand** — `Logo`
- **core** — `Button`, `IconButton`, `Icon`, `Card`, `Badge`, `Tag`
- **forms** — `Input`, `Select`, `Checkbox`, `Switch`
- **navigation** — `Tabs`, `Breadcrumbs`
- **feedback** — `Callout`, `Toast`, `Dialog`, `Tooltip`
- **data** — `StatTile`, `DataTable`, `CodeBlock`

**Intentional additions** (no source defined a component inventory, so a standard set was authored; these four are brand-specific extras and are called out deliberately):
- `Icon` — a wrapper over the copied Lucide set, so no one hand-rolls SVG
- `CodeBlock` — an open-source brand's most-used block
- `StatTile` / `DataTable` — this brand's product *is* numbers

**UI kits**
- `ui_kits/website/` — the opengolf.ai marketing site (header, hero, projects, registry, community, footer)
- `ui_kits/explorer/` — OpenGolf Explorer, the registry app (sidebar shell, dataset list, dataset detail, benchmark leaderboard, key-creation dialog + toasts)

## Caveats

1. **Fonts are substituted.** No binaries were supplied; Figtree + IBM Plex Mono load from Google Fonts. Send the real files and the `@font-face` rules will be swapped in.
2. **Logo is raster only.** The PNGs were keyed out of a generated image, so edges are anti-aliased against the original paper colour. An SVG would make the mark scalable and recolourable.
3. **Product surfaces are invented.** Dataset names, project names, copy and screens are plausible fiction built from the one-line description.
