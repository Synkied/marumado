---
name: Marumado
description: One hub for every project on this machine, and for the machines themselves, drawn as a chart recorder.
colors:
  paper: "#ecebe4"
  paper-raised: "#f5f4ef"
  ink: "#23231f"
  ink-2: "#57564f"
  ink-3: "#9a988e"
  grid: "#dcdad0"
  grid-major: "#cbc8bc"
  track: "#d9d7cd"
  rule: "#bfbcb1"
  rule-soft: "#d6d3c9"
  solid: "#2b2b27"
  on-solid: "#f5f4ef"
  pen-off: "#b3b0a6"
  moss: "#5d6b3a"
  persimmon: "#c2502b"
  persimmon-text: "#a3411f"
  night-paper: "#1a1a18"
  night-disc: "#201f1d"
  night-ink: "#e8e5dc"
  night-ink-2: "#a9a69c"
  night-grid: "#2b2a27"
  night-grid-major: "#44423d"
  night-moss: "#93a666"
  night-persimmon: "#e0703f"
  pen-projects: "oklch(0.44 0.1 266)"
  pen-urls: "oklch(0.5 0.085 158)"
  pen-machine: "oklch(0.48 0.07 215)"
  pen-docker: "oklch(0.49 0.075 190)"
  pen-agents: "oklch(0.48 0.1 300)"
  pen-skills: "oklch(0.46 0.085 330)"
  pen-ports: "oklch(0.5 0.08 85)"
  pen-tasks: "oklch(0.47 0.09 0)"
  pen-momentum: "oklch(0.5 0.07 245)"
  pen-processes: "oklch(0.46 0.03 60)"
  pen-machines: "oklch(0.45 0.04 250)"
typography:
  display:
    fontFamily: "Iosevka Aile, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(32px, 3.2vw, 50px)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.02em"
  wordmark:
    fontFamily: "Iosevka, ui-monospace, monospace"
    fontSize: "clamp(19px, 1.5vw, 23px)"
    fontWeight: 500
    letterSpacing: "0.02em"
  body:
    fontFamily: "Iosevka Aile, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Iosevka Aile, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.18em"
  data:
    fontFamily: "Iosevka, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
rounded:
  xs: "2px"
  sm: "3px"
  control: "4px"
  md: "5px"
  lg: "6px"
  xl: "8px"
spacing:
  unit: "2px"
  gutter: "clamp(16px, 2.6vw, 48px)"
  control: "40px"
  touch: "44px"
components:
  button:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "40px"
  button-hover:
    backgroundColor: "{colors.solid}"
    textColor: "{colors.on-solid}"
  chip:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "30px"
  segmented-pressed:
    backgroundColor: "{colors.solid}"
    textColor: "{colors.on-solid}"
  field:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
---

# Design System: Marumado

## Tokens

Every design decision lives in `frontend/src/tokens.css`: colours (light and dark), syntax colours, the terminal palette, fonts and their imports, the type scale, tracking, spacing, control heights, corners, elevation and motion. Components refer to tokens only, so a retheme is an edit to that one file.

- **Colour**: `--ground` (chart paper), `--ground-raised` (a fresh sheet), `--disc` (a chart disc's paper; a shade lighter than the table at night), `--ink`, `--ink-2/3`, `--grid` and `--grid-major` (the graticule), `--track`, `--rule(-soft)`, `--solid` and `--on-solid(-2)` (a filled control), `--pen-off`, `--rim-ink` (how much of its pen a disc's rim takes), `--moss`, `--signal(-text)` (persimmon, the alarm pen), `--c-<module>` (each module's pen), `--syn-*` for the code viewer, `--term-*` for the terminal. A `.mod-<id>` class sets `--mod`, the one hook components read for "this module's pen"; outside a module it is ink.
- **Type**: `--f-sans` (Iosevka Aile), `--f-mono` (Iosevka), `--f-cjk` (the two vendored Noto Serif JP glyphs for 丸窓); weights `--weight-light/body/strong/heavy` (300/400/500/600); sizes `--text-2xs` (10) to `--text-3xl` (28), fluid `--text-display(-sm/-xs)`, `--text-wordmark`, `--text-crumb`; tracking `--track-display/title/snug/caps/caps-wide/wordmark`.
- **Spacing**: `--sp-N` is N × `--space` (2px), from `--sp-1` (2px) to `--sp-22` (44px). Changing `--space` makes the whole UI denser or roomier. `--gutter` is the page margin.
- **Sizes**: `--control-sm` (chips), `--control` (buttons), `--touch` (the phone minimum).
- **Corners**: `--radius-xs` to `--radius-xl`, and `--radius-control` for buttons, chips, segmented controls and the picker; circles stay `50%`.
- **Motion**: `--ease`, `--dur-quick` (hover, state), `--dur-base` (surfaces), `--dur-enter` (a sheet arriving), `--dur-slow`, `--dur-sweep` (a pen drawing a channel's record onto its disc).
- **Elevation**: `--shadow-float`, only for what floats over the page.

Rules for new CSS: no raw colours, font sizes, letter-spacing, radii or durations; spacing from `--sp-*` (1px hairlines and `em` offsets are fine); the geometry of marks (rims, rings, bands and lanes in `Dial.tsx`, the graticule pitch in `fleet.css`) stays literal. CSS can't read a variable inside a media query, so the phone breakpoint (860px) is written into `app.css`.

## Overview

**Creative North Star: "The Chart Recorder." The machine writes its own record.** Marumado is a laboratory recorder: pale chart paper ruled with a faint graticule, and every module a channel drawn by its own pen. Home is the recorder's overview of every machine at once: each machine a block of small reading windows laid on the paper, each with its module's pen and a small seal (its disc in miniature); persimmon, with a wash, marks only what needs you. Each module's own pen and its circular chart disc (the round window, 丸窓) live on its page and in the sidebar, where the disc unrolls into straight strip charts.

It is quiet until something matters. When something needs you, the alarm pen (persimmon) marks that reading, the machine's round-window lamp and the status dot, and nothing else on screen changes colour. It refuses the card-grid dashboard, the gauge cluster, the dark cockpit and table-filled home screens, and it refuses skeuomorphic hardware: no metal, knobs, bevels or glow.

**Key Characteristics:**
- Chart paper with a fine graticule (16px, a major division every fifth line) behind home; discs and strips carry their own.
- Every module draws something even when nothing is wrong: a trace, event ticks, or one lane per item.
- One family, two widths: Iosevka Aile for names and words, Iosevka for every value and line of code, terminals included.
- Colour is a pen: each module's own muted ink for identity, moss for alive, persimmon for needs you.
- Hairlines and space separate; corners are small and exact.

## Colors

Paper, graticule and ink; one muted pen per module; two pigments used only as signals.

### Primary
- **Pens** (`--c-<module>`): projects indigo, URLs jade, machine slate teal, Docker celadon, agents wisteria, skills plum, ports ochre, tasks madder rose, momentum blue, processes umber grey, machines blue slate. A pen draws its module's traces, ticks and lanes, tints its disc's rim (`--rim-ink`) and colours its marks in the sheet. At night they turn pale and gain a little chroma to hold against dark paper.
- **Solid** (`solid`): a filled control: the pressed segment, a button on hover, the selected search result, the streaming toggle when on, text selection. Text on it is `on-solid`.

### Secondary
- **Moss** (`moss`): all clear, alive, working. The status dot at rest, lamps of running things, working spans on a task's timeline.

### Tertiary
- **Persimmon** (`persimmon`, text in `persimmon-text`): the alarm pen. Needs you, and nothing else: the status dot and its words, a faulty disc's rim, "now" mark and newest record, the break where a URL went down, fault lamps, an armed destructive button, a meter past its budget.

### Neutral
- **Chart paper** (`paper`): the page. **Fresh sheet** (`paper-raised`): fields, the open item, the search palette, menus.
- **Ink** (`ink`): text and the darkest marks. **Ink-2** (6.3:1 on paper): all secondary text, axis labels. **Ink-3**: the "now" tick, baselines, strokes; never text.
- **Graticule** (`grid`, `grid-major`): the paper's ruling, the rings and spokes inside a disc, off lanes.
- **Pen off** (`pen-off`): the dashed rim of a channel that is off or unavailable.
- **The recorder at night** (`prefers-color-scheme: dark`): near-black paper, each disc a sheet a shade lighter (`night-disc`), firmer graticule, pale pens. The roles stay the same.

### Named Rules
**The Pen Rule.** A module's colour is identity, and only that module draws with it. Pens stay muted and keep clear of olive and orange, so they never read as moss or persimmon. A channel that needs you keeps its pen; persimmon goes on its rim and its newest record. Projects, categories and items inside a module get no colours of their own.

**The One Alarm Rule.** Persimmon means "act". If nothing needs you, no persimmon is on screen.

**The Text Is Ink Rule.** Text is `ink`, `ink-2`, `persimmon-text` or, on a solid fill, `on-solid`. Pens, moss and persimmon carry meaning through marks, not long runs of letters.

## Typography

**Sans:** Iosevka Aile, the proportional sibling of Iosevka, for names, prose, controls and labels.
**Mono:** Iosevka, for every value, reading, axis, path, port, PID, log, code and the live terminals.

**Character:** One technical voice in two widths. The instrument and the agents it watches speak the same letters. Small tracked caps name channels, as on a printed chart.

### Hierarchy
- **Display** (Aile 400, `min(clamp(32px, 3.2vw, 50px), 12cqi)`, 1.04, -0.02em): sheet titles, in sentence case.
- **Wordmark** (Iosevka 500, `clamp(19px, 1.5vw, 23px)`): "marumado" in lowercase, with 丸窓 at 62% size in `ink-2`.
- **Disc reading** (Iosevka 400, 13–15% of the disc's width, tabular): the value in a disc's hub. Off reads in light italic Aile, "OFF".
- **Body / row** (Aile 400, 16px, 1.45): item names, inputs, lede (max 60ch). Sub-lines at 14px in `ink-2`.
- **Label** (Aile 500, 11–12px, 0.14–0.18em tracking, uppercase): channel names on discs, section headings in a sheet, field labels, chips.
- **Data** (Iosevka, 11–15px): readings in the top bar, axis ticks and time spans, paths, ports, PIDs, logs, code.

### Named Rules
**The Mono Is Data Rule.** Iosevka where a value is read: a reading, a time span, a path, a port, a log line, code. Names of things are set in Aile.

**The Quiet Controls Rule.** Buttons, toggles and links are sentence case. Uppercase is for labels that name things, never for actions.

## Layout

- The app is a quiet top bar (the round chart mark and wordmark, machine picker, streaming and lock toggles, active agents, an underlined "/ search", CPU/RAM, the status dot and words) over the main area.
- **Home** is every machine, one block each, on the graticule, edge to edge (see The machine blocks).
- **A module page** swaps home for a sidebar of small discs (a 104px rail with names under them, or a wider list with the caption beside each) next to the sheet. On wide screens the app is one viewport tall and each column scrolls on its own.
- **Below 860px** home is the same blocks with two readings per line. A module page shows only its sheet with a Home back link. Every control is at least 44px tall.
- Lists are rows of at least 56px separated by `rule-soft` hairlines. Card grids use `auto-fill` with a `min(100%, …)` minimum, so they never scroll sideways.

## Elevation & Depth

Flat. Depth is tone (paper to fresh sheet; at night the discs a shade above the table), never shadows. The exceptions are what floats: the search palette and the table's menu, on a fresh sheet with a soft, low shadow (`--shadow-float`).

## Shapes

- **Circles** are the system's signature: chart discs and their rings, the chart mark, lamps, the status dot, pen tips.
- **Small exact corners** (`--radius-control`, 4px) for buttons, chips, segmented controls, the picker; 5–8px for fields, cards and the palette.
- **Thin outline icons**: one authored set on a 24px grid with a 1.6 stroke, in `ink-2`.

## Components

### Buttons
- **Shape:** 4px corners, 40px tall (44px on phones), sentence-case label at 14px.
- **Default:** an `ink-3` outline on paper; `.btn--quiet` uses `rule-soft`.
- **Hover:** fills with solid, text `on-solid`.
- **Armed (destructive):** persimmon fill. Stop, kill and remove go through `ConfirmButton`, which asks for a second press.

### Chips
- **Style:** a `rule-soft` outline, 11px tracked caps, 30px (44px on phones). For item links (Local, Live, Repo, folder) and item actions (Start, Restart, Stop, Logs).
- **Fault:** persimmon border and text.

### Cards / Containers
- **Item card** (Projects and Docker grid views): soft-ruled card; the open or hovered one turns fresh sheet. Lamp and state in tracked caps on top, the name in Aile, sub-lines in `ink-2`, actions pinned to the bottom.
- **Machine card** (Overview): the lamp and name, CPU/RAM/disk meters, one row per module reading (a small mark in its pen, label, value) and the machine's "needs you" list under a soft rule. The machine on screen is a fresh sheet; an unreachable one has a persimmon border.
- Nested cards are never used.

### Inputs / Fields
- **Field:** label in tracked caps above a fresh-sheet box with a `rule-soft` border; focus turns the border ink.
- **Filter and search:** borderless, on a single soft underline; focus darkens the line and icon.

### Navigation
- **Top bar:** text and icons in `ink-2`, ink on hover. The status is a 12px dot plus words: moss "all clear", or persimmon "1 needs you" (the dot comes on with one fading ring). Pressing it lists what needs you.
- **Sidebar discs:** the open module's rim is inked heavier in its pen and its name turns ink; hovering any disc inks its rim.
- **Palette:** `/` or ⌘K opens search over everything; the selected result is a solid row.

### Chart disc (signature)
A module's channel as a circular chart (`Dial`). Paper disc, a graticule of three rings and twelve spokes, a rim in the module's pen, a "now" tick at twelve o'clock, and a hub carrying the reading (value, name in tracked caps, caption; the caption is hidden under 190px). What the pen draws comes from the module's `Summary.chart` in `registry.ts`:
- **trace**: readings 0..1 around the band between hub and rim, oldest just past the top, newest arriving at the top with a pen tip; missing samples break the line. Machine (CPU) and Processes (memory) from the 30 minutes of history; URLs from each live URL's last 30 checks (the slowest site each minute, a gap where any failed).
- **ticks**: event counts per slot, drawn as radial ticks from the rim on a square-root scale. Projects: commits per week across every project, 12 weeks.
- **lanes**: one arc per item: on (inked), done (faded), off (graticule), fault (persimmon). Agents, Tasks (the latest 24), Ports (linked or not), Docker, Momentum, Skills, Machines.
- The disc's time span is printed at its foot ("30 min", "12 wk").

Off is a blank disc with a dashed `pen-off` rim and "OFF" in light italic. Fault turns the rim, the "now" tick, the newest eighth of a trace and the reading persimmon. A quiet channel draws with a lighter pen; a busy one pulses its pen tip. On first load the discs are laid in reading order (a 70ms stagger) and each pen draws its record once; afterwards readings update in place.

### The machine blocks (home)
Home (`modules/fleet.tsx`, readings in `modules/readouts.ts`) shows every machine as a block:
- **Header:** the round-window lamp (a hollow ink ring when all is well, filled persimmon when something needs you, dashed while connecting), the machine's name (opens its Machine page), a context line in mono, its status ("all clear", "2 need you", "unreachable"), and Arrange and Fold buttons.
- **Readings:** fixed-anatomy cells: the name in tracked caps in its module's pen (RAM in the Processes pen, Disk in Momentum's) with its **seal** beside it, the value large in mono (`--text-3xl`) on its own line, and under it a line of words (up to two lines) or, for CPU, its last half hour as a pen line with a dot at "now" and its budget as a dashed rule. The seal is the module's disc in miniature (36px, read from twelve o'clock): a share is one arc with a tick at its budget (CPU, RAM, Disk); parts are one arc per item, pen for on, pale for off, persimmon for needs you (URLs, Agents, Docker, Tasks, Projects; past 12 items it becomes a share). Cells are separated by a left hairline, never boxed. A reading that needs you keeps its place, on a faint persimmon wash with a 3px persimmon left rule; an absent module is pale with a dashed seal.
- **Extensible by construction:** cells lay on `repeat(auto-fill, minmax(148px, 1fr))` (140px on phones), so they wrap onto as many lines as needed and stretch to fill each line, and every block shares the same columns: the same reading sits in the same place on every machine. Nine readings fit one line at 1440px. A new module adds an entry to `READOUTS`, built from the machine's summary and `/api/overview` digest only, so it reads the same for every machine.
- **Per machine:** Arrange lets you show, hide and reorder a machine's readings; "Use on every machine" copies them so the blocks line up again. Saved per viewer in browser storage.
- **Order and folding:** machines that need you (or are unreachable) rise to the top and are always open; this machine is open; calm remote machines fold to one line carrying their vitals (`CPU 8% · RAM 30% · disk 40%`), and any fold can be changed by hand. An unreachable machine is one persimmon line with Retry. Problems no reading shows are listed under the block.

### Strip charts
On module pages (`DotChart`): the pen running across ruled paper, oldest at the left, the pen tip at "now" on the right, axis values in mono on the left and the span ("−30 min … now") under it. A channel that went quiet (a URL down) ends at its last reading, marked by a dashed persimmon break. Meters are 6px grooves in `track` with a pen fill and a budget tick.

### Streaming mode
An eye toggle next to the machine picker (on by default, and forced by `?stream`) masks SSH logins, host names, paths, addresses, commands and logs with a quiet "… hidden" placeholder (`Secret`, `useRedact`). On, it fills with solid.

## Do's and Don'ts

### Do:
- **Do** give every new module a label, an icon and a summary (value, fraction, caption, fault, off, and a `chart`) in `registry.ts`, and a reading in `readouts.ts` fed by the machine digest, so it appears on every machine's block.
- **Do** draw real data on a disc. If a module has no history, draw its items as lanes rather than inventing a trace.
- **Do** treat "unavailable" (Docker off, Herdr not running, a machine unreachable) as a calm, explained state: a blank disc and plain words, not an error.
- **Do** label states in plain words for someone who isn't the owner ("1 of 4 working", "Herdr not running").
- **Do** keep live numbers in tabular figures, and change a value's colour only when it crosses a budget.

### Don't:
- **Don't** give a project, an item or a category a colour of its own; only modules have pens, and state stays moss and persimmon.
- **Don't** use persimmon for anything that doesn't need the viewer, or moss for decoration.
- **Don't** set names of things in mono, or actions in uppercase.
- **Don't** add shadows (beyond what floats), gradients, glass, bevels, knobs, metal or glow, or nested cards.
- **Don't** add kicker labels above titles or numbered section indexes.
- **Don't** give home fixed columns. Home is wrapping reading cells; details live in each module's page.
- **Don't** animate layout properties. Use transform, opacity or stroke drawing, with a short fade under reduced motion.
