---
name: Marumado
description: One hub for every project on this machine, and for the machines themselves, laid out as a dry garden.
colors:
  gravel: "#e4e2dc"
  sand: "#ecebe6"
  ink: "#252421"
  ink-2: "#5c5a54"
  ink-3: "#9a978f"
  rake: "#cbc8bf"
  track: "#d2cfc7"
  rule: "#b9b6ad"
  rule-soft: "#d0cdc5"
  stone: "#3a3936"
  stone-off: "#d3d0c9"
  on-stone: "#f1efe9"
  on-stone-2: "#bdbab2"
  moss: "#5d6b3a"
  persimmon: "#c2502b"
  persimmon-text: "#a3411f"
  on-persimmon: "#f6f2ea"
  night-gravel: "#191917"
  night-sand: "#22211f"
  night-ink: "#e6e3db"
  night-ink-2: "#a9a59c"
  night-stone: "#cfcbc1"
  night-moss: "#93a666"
  night-persimmon: "#e0703f"
  mineral-projects: "oklch(0.44 0.085 262)"
  mineral-urls: "oklch(0.5 0.08 228)"
  mineral-machine: "oklch(0.47 0.065 195)"
  mineral-docker: "oklch(0.48 0.07 165)"
  mineral-agents: "oklch(0.46 0.08 300)"
  mineral-skills: "oklch(0.45 0.075 325)"
  mineral-ports: "oklch(0.47 0.08 355)"
  mineral-tasks: "oklch(0.5 0.075 72)"
  mineral-momentum: "oklch(0.52 0.07 92)"
  mineral-processes: "oklch(0.45 0.03 60)"
  mineral-machines: "oklch(0.46 0.035 245)"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, ui-serif, Georgia, serif"
    fontSize: "clamp(32px, 3.2vw, 50px)"
    fontWeight: 300
    lineHeight: 1.04
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "Source Serif 4 Variable, ui-serif, Georgia, serif"
    fontSize: "clamp(19px, 1.5vw, 23px)"
    fontWeight: 400
    letterSpacing: "0.14em"
  title:
    fontFamily: "Source Serif 4 Variable, ui-serif, Georgia, serif"
    fontSize: "21px"
    fontWeight: 400
  body:
    fontFamily: "Source Serif 4 Variable, ui-serif, Georgia, serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Source Serif 4 Variable, ui-serif, Georgia, serif"
    fontSize: "11px"
    fontWeight: 560
    letterSpacing: "0.22em"
  data:
    fontFamily: "Source Code Pro Variable, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
rounded:
  xs: "3px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "22px"
  pill: "999px"
spacing:
  unit: "2px"
  gutter: "clamp(16px, 2.6vw, 48px)"
  control: "40px"
  touch: "44px"
components:
  button:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    height: "40px"
  button-hover:
    backgroundColor: "{colors.stone}"
    textColor: "{colors.on-stone}"
    rounded: "{rounded.pill}"
  chip:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "30px"
  segmented-pressed:
    backgroundColor: "{colors.stone}"
    textColor: "{colors.on-stone}"
    rounded: "{rounded.pill}"
  field:
    backgroundColor: "{colors.sand}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
  item-card:
    rounded: "{rounded.md}"
    padding: "12px 14px"
  machine-card:
    rounded: "{rounded.lg}"
    padding: "16px 18px 14px"
  stone:
    backgroundColor: "{colors.stone}"
    textColor: "{colors.on-stone}"
  stone-off:
    backgroundColor: "{colors.stone-off}"
    textColor: "{colors.ink-2}"
---

# Design System: Marumado

## Tokens

Every design decision lives in `frontend/src/tokens.css`: colours (light and dark), syntax colours, the terminal palette, fonts and their imports, the type scale, tracking, spacing, control heights, corners, elevation and motion. Components refer to tokens only, so a retheme is an edit to that one file.

- **Colour**: `--ground` (gravel), `--ground-raised` (sand), `--ink`, `--ink-2/3`, `--rake`, `--track`, `--rule(-soft)`, `--stone`, `--stone-off`, `--on-stone(-2)`, `--moss`, `--signal(-text)` (persimmon), `--syn-*` for the code viewer, `--term-*` for the terminal (xterm reads them when a terminal opens). `--mod` is kept as the one hook components read for "this module's mark", and it resolves to ink: modules no longer have colours.
- **Type**: `--f-display` (Source Serif 4, variable with optical sizes), `--f-mono` (Source Code Pro), `--f-cjk` (the two vendored Noto Serif JP glyphs for 丸窓); weights `--weight-light/body/strong/heavy` (300/400/560/640); sizes `--text-2xs` (10) to `--text-3xl` (28), fluid `--text-display(-sm/-xs)`, `--text-wordmark`, `--text-crumb`; tracking `--track-display/title/snug/caps/caps-wide/wordmark`.
- **Spacing**: `--sp-N` is N × `--space` (2px), from `--sp-1` (2px) to `--sp-22` (44px). Changing `--space` makes the whole UI denser or roomier. `--gutter` is the page margin.
- **Sizes**: `--control-sm` (chips), `--control` (buttons), `--touch` (the phone minimum).
- **Corners**: `--radius-xs` to `--radius-xl`, `--radius-pill`; circles stay `50%`.
- **Motion**: `--ease`, `--dur-quick` (hover, state), `--dur-base` (surfaces), `--dur-enter` (a sheet arriving), `--dur-slow` (a stone settling), `--dur-sweep` (a ripple raked to its value).
- **Elevation**: `--shadow-float`, only for what floats over the page.

Rules for new CSS: no raw colours, font sizes, letter-spacing, radii or durations; spacing from `--sp-*` (1px hairlines and `em` offsets are fine); the geometry of marks (lamps, stone and ripple radii in `Dial.tsx`, the garden's slots in `Garden.tsx`) stays literal. CSS can't read a variable inside a media query, so the phone breakpoint (860px) is written into `app.css`. The terminal's font (Ubuntu Mono) is set in `Terminal.tsx`.

## Overview

**Creative North Star: "The Dry Garden."** Marumado is a karesansui seen from above. The ground is raked gravel, every module is a stone lying in it, and each stone's reading is one ripple raked darker around it. Stones sit in uneven groups, the first pinned module the principal stone, the rest placed like a garden's, never on a grid. Most of the surface is empty gravel, and that emptiness is the material.

It is quiet until something matters. At rest the screen holds ink on gravel and one small moss dot reading "all clear". When something needs you, that stone's ripple and the status dot turn persimmon, and nothing else on the screen changes colour. It refuses the card-grid dashboard, the gauge cluster, the dark cockpit and dense, table-filled home screens. It also refuses decorative Japonisme: no blossoms, bamboo, lanterns or fake brushwork. The calm comes from proportion, material and restraint.

**Key Characteristics:**
- Raked-gravel ground with faint wavering rake lines, interrupted by the ripples around each stone.
- Charcoal stones carry the readings; pale stones mean off or unavailable.
- One serif with optical sizes for everything a person reads; mono only for data.
- Colour means state only: moss for alive, persimmon for needs you.
- Hairlines are soft and few; space does the separating.

## Colors

Gravel, stone and ink; one muted mineral per module so it can be found at a glance; two pigments used only as signals.

### Primary
- **Charcoal Stone** (`stone`): the body of every module's stone, the filled state of segmented controls and the streaming toggle, a button on hover, the selected search result, text selection. On it, text is `on-stone`; secondary text is `on-stone-2`.

- **Minerals** (`mineral-<module>`, tokens `--c-<module>`): each module's stone is its own mineral, like stones gathered from different rivers: indigo projects, pale-indigo URLs, celadon machine, jade Docker, wisteria agents, plum skills, deep-rose ports, ochre tasks, mustard momentum, umber processes, blue-slate machines. A `.mod-<id>` class sets `--tint` (the stone) and `--mod` (that module's marks: its arc, meters, heat cells, the pressed segment in its sheet). At night they turn pale and lose some chroma. Outside a module, stones fall back to charcoal.

### Secondary
- **Moss** (`moss`): all clear, alive, working. The status dot at rest, lamps of running things, the "working" dot on an active agent, working spans on a task's timeline.

### Tertiary
- **Persimmon** (`persimmon`, text in `persimmon-text`): needs you, and nothing else. The status dot and its words when anything needs attention, a faulty stone's ripple and rim, fault lamps, an armed destructive button, a meter past its budget.

### Neutral
- **Raked Gravel** (`gravel`): the page ground. **Sand** (`sand`): fields, the open item, the search palette, anything slightly raised.
- **Ink** (`ink`): text and the darkest marks. **Ink-2** (5.3:1 on gravel): all secondary text. **Ink-3**: strokes, empty lamps, hover ripples, never text.
- **Rake** (`rake`): the rake lines and ripple rings. **Track** and **Rule/Rule-soft**: meter grooves and the few hairlines left.
- **Pale Stone** (`stone-off`): a module that is off or unavailable.
- **The garden at night** (`prefers-color-scheme: dark`): the gravel goes near-black (`night-gravel`), the stones turn moonlit pale (`night-stone`) with dark text, and moss and persimmon lighten (`night-moss`, `night-persimmon`). The roles stay the same.

### Named Rules
**The Mineral Rule.** A module's colour is identity, and only that module wears it. Minerals stay muted (oklch chroma ≤ 0.085) and keep clear of olive and orange, so they never read as moss or persimmon. A stone that needs you keeps its mineral; the persimmon goes on its ripple and rim. Projects, categories and items inside a module get no colours of their own.

**The One Alarm Rule.** Persimmon means "act". If nothing needs you, no persimmon is on screen.

**The Text Is Ink Rule.** Text is `ink`, `ink-2`, `persimmon-text` or, on a stone, `on-stone(-2)`. Moss and persimmon carry meaning through marks, not long runs of letters.

## Typography

**Display Font:** Source Serif 4 (variable, with optical sizes), falling back to the platform serif.
**Body Font:** Source Serif 4, the same family, whose optical-size axis makes small text sturdier and display text lighter and more open.
**Label/Mono Font:** Source Code Pro, the companion mono, for data only.

**Character:** One quiet, literate voice. Light, open serif at display sizes; sturdy serif in rows and controls; lowercase, wide-tracked lettering for the wordmark; small tracked caps for the names on stones and section labels, like characters cut into a garden's stone markers.

### Hierarchy
- **Display** (300, `min(clamp(32px, 3.2vw, 50px), 12cqi)`, 1.04): sheet titles, in sentence case. It shrinks with its column so a single word fits, and wraps between words, never inside one.
- **Wordmark** (400, `clamp(19px, 1.5vw, 23px)`, 0.14em tracking): "marumado" in lowercase, with 丸窓 at 62% size in `ink-2`.
- **Stone value** (400, 15% of the stone's ripple width): a module's reading, centred on its stone in lining tabular figures. Off reads in italic.
- **Title** (400, 21px): a machine card's name.
- **Body / row** (400, 16px, 1.45): item names, inputs, lede (max 60ch). Sub-lines at 14px in `ink-2`.
- **Label** (560, 11–12px, 0.16–0.22em tracking, uppercase): names on stones, section headings in a sheet, field labels, facts, chips, a detail page's state line.
- **Data** (Source Code Pro, 12–15px): paths, ports, PIDs, readings in the top bar, chart axes, logs, code.

### Named Rules
**The Mono Is Data Rule.** Source Code Pro only where a character-exact value is read: a path, a port, a PID, a log line, code. Names of things are set in the serif.

**The Quiet Controls Rule.** Buttons, toggles and links are sentence case with slight tracking. Uppercase is for labels that name things, never for actions.

## Layout

- The app is a quiet top bar (stone mark and wordmark, machine picker, streaming and lock toggles, active agents, an underlined "/ search", CPU/RAM, the status dot and words) over the main area. There is no rule under the bar; space separates it.
- **Home** is the garden: edge to edge, as tall as the window (480 to 1300px), with the Overview of every machine below it. Each pinned module lies at an authored slot (x, y as a fraction of the garden, a size scale); the principal stone sits left of centre and the rest gather in uneven groups. No stone lies inside another's ripples from 1000×560 to 2400×1150. A stone's ripple width is `min(34cqw, 62cqh)` × its slot scale.
- **A module page** swaps the garden for a sidebar of small stones (a 104px rail of stones with names under them, or a wider list with the name and caption beside each stone) next to the sheet. On wide screens the app is one viewport tall and each column scrolls on its own. A sheet never grows wider than its column.
- **Below 860px** the garden lays its stones in two staggered columns, the principal stone full width on top, then the Overview. A module page shows only its sheet with a Home back link. Every control is at least 44px tall.
- Lists are rows of at least 56px separated by `rule-soft` hairlines. Card grids use `auto-fill` with a `min(100%, …)` minimum, so they never scroll sideways.

## Elevation & Depth

Flat. Depth is tone (gravel to sand) and the stones themselves, never shadows. The one exception is the search palette, which floats on sand with a soft, low ambient shadow (`--shadow-float`).

### Named Rules
**The Flat Garden Rule.** Stones are flat discs seen from directly above: no bevels, highlights, gradients or drop shadows. They read as stones through placement, the ripples raked around them and their mineral mass against pale gravel.

## Shapes

- **Circles** are the system's signature: stones, ripple rings, the stone mark, lamps, the status dot.
- **Pills** (`999px`) for small controls: buttons, chips, segmented controls, the picker, the streaming and lock toggles.
- **Soft rectangles** for containers: 10px for item cards and fields, 14px for machine cards, notices and task columns, 22px for the search palette.
- **Thin outline icons**: one authored set on a 24px grid with a 1.6 stroke, in `ink-2`.

## Components

### Buttons
- **Shape:** pill (999px), 40px tall (44px on phones), sentence-case label at 14px.
- **Default:** a stone-grey outline (`ink-3`) on gravel; `.btn--quiet` uses `rule-soft`.
- **Hover:** fills with charcoal stone, text `on-stone`.
- **Armed (destructive):** persimmon fill. Stop, kill and remove go through `ConfirmButton`, which asks for a second press.

### Chips
- **Style:** a `rule-soft` pill, 11px tracked caps, 30px (44px on phones). For item links (Local, Live, Repo, folder) and item actions (Start, Restart, Stop, Logs).
- **Fault:** persimmon border and text.

### Cards / Containers
- **Item card** (Projects and Docker grid views): soft-ruled 10px card; the open or hovered one turns sand. Lamp and state in tracked caps on top, the name in serif, sub-lines in `ink-2`, actions pinned to the bottom.
- **Machine card** (Overview): 14px card with the lamp and name, CPU/RAM/disk meters, one row per module reading (a small stone dot, label, value) and the machine's "needs you" list under a soft rule. The machine on screen is sand; an unreachable one has a persimmon border.
- Nested cards are never used.

### Inputs / Fields
- **Field:** label in tracked caps above a sand box with a `rule-soft` border and 10px corners; focus turns the border ink.
- **Filter and search:** borderless, on a single soft underline; focus darkens the line and icon.
- Placeholders are `ink-2`, the caret is ink, the focus ring is a 2px ink outline.

### Navigation
- **Top bar:** text and icons in `ink-2`, ink on hover. The status is a 12px dot plus words: moss "all clear", or persimmon "1 needs you" (the dot drops in with one fading ring). Pressing it lists what needs you.
- **Sidebar stones:** the open module's ripples are raked dark (`ink-2`) and its name turns ink; hovering any stone darkens its ripples (`ink-3`).
- **Palette:** `/` or ⌘K opens search over everything; the selected result is a charcoal row.

### Stone (signature)
A module's reading as a stone in its own raked ripples (`Dial`). The face is a gravel apron that hides the rake lines beneath, five concentric ripple rings, and the stone at 54% of the face. The fraction is one ripple (the third) raked in ink with round ends from twelve o'clock. In the garden the stone carries its name (tracked caps), its value and one named line (hidden when the face is under 190px): the thing that matters most in that module, by name ("zen-designer · working", the task that needs you, ":3000 marumado"), or the plain caption when there is none; in the sidebar the name sits beside or under it. Off is a pale stone with no ripples and an italic value. Fault turns the raked ripple persimmon and rims the stone in persimmon. **Quiet** (nothing running, nothing open, all up) pales the stone to `--quiet` of its mineral over the gravel (30% light, 46% dark) with ink text, so the stones with something going on hold the eye; a faulty stone is never quiet. **Busy** (an agent or task at work, a loaded CPU) sends two rings in the module's mineral out from the stone, fading, 3.6s apart in turn, like a drop in still water; with reduced motion it is one still ring. You decide where a stone lies and how large; the data decides how loud it is. On first load the stones settle in reading order (fade with a 4% scale, 70ms apart) and each ripple is raked to its value once; afterwards values update in place.

### The Garden
Home's surface: the raked gravel (an SVG of long lines, two slow waves each, redrawn to the garden's size) and the pinned modules as stones. You lay the garden out yourself, like a real one:
- **Move:** drag a stone, or Shift + arrow keys. It stays on the gravel and is nudged 10px clear of any stone it lands on.
- **Size:** drag the small grip on its lower-right rim (shown on hover or focus), or + and −. Sizes run from 0.3 to 1.15 of `--base`.
- **Add or lift out:** long-press (500ms) or right-click empty gravel for a menu of the modules not yet in the garden; the chosen one is set at that spot. Long-press or right-click a stone for Open and Lift out of the garden.
- **Save:** every change is a draft, marked "Unsaved arrangement", until Save arrangement; Discard puts back the last save, Reset stones returns every stone to its authored slot. Positions and sizes are saved per machine in browser storage, and the stones in the garden are the pins.
- A stone never moved lies at an authored slot. Adding or lifting a stone first holds every other stone where it lies, so none jumps to a new slot.
- Ripples intersect freely, but every stone lies above every ripple: the Dial draws two layers (`dial__bed`, `dial__body`), and garden spots are placed by left/top so none makes a stacking context. Only the stone takes the pointer, never its ripples.
- Arrange, Reset and Save sit in a strip below the gravel, never on it. On phones the stones fall into two staggered columns; long-press still adds and lifts out, but stones can't be moved or sized.

### Charts
Dot charts are rows of round pebbles in `ink-2` over a dotted baseline (persimmon for a series past its budget); meters are 6px grooves in `track` with an ink fill and a budget tick. The task timeline is moss for working, ink for a wait that ended and persimmon for a wait still going.

### Streaming mode
An eye toggle next to the machine picker (on by default, and forced by `?stream`) masks SSH logins, host names, paths, addresses, commands and logs with a quiet "… hidden" placeholder (`Secret`, `useRedact`). On, it fills with charcoal stone.

## Do's and Don'ts

### Do:
- **Do** give every new module a label, an icon and a stone summary (value, fraction, caption, fault, off) in `registry.ts`. It joins the garden on equal footing.
- **Do** treat "unavailable" (Docker off, Herdr not running, a machine unreachable) as a calm, explained state: a pale stone and plain words, not an error.
- **Do** label states in plain words for someone who isn't the owner ("1 of 4 working", "Herdr not running").
- **Do** keep live numbers in tabular figures, and change a value's colour only when it crosses a budget.
- **Do** leave gravel empty. A new element earns its place in the garden or goes into a module's sheet.

### Don't:
- **Don't** give a project, an item or a category a colour of its own; only modules have minerals, and state stays moss and persimmon.
- **Don't** use persimmon for anything that doesn't need the viewer, or moss for decoration.
- **Don't** set names of things in mono, or actions in uppercase.
- **Don't** add shadows, gradients, glass, bevels or nested cards, or draw the stones as 3D objects.
- **Don't** add Japanese decoration (blossoms, bamboo, lanterns, brush calligraphy) or numbered section indexes and kicker labels above titles.
- **Don't** fill the home screen with tables. Home is the garden plus the Overview, and details live in each module's sheet.
- **Don't** animate layout properties. Use transform or opacity, and give a short fade under reduced motion.
