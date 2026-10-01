---
name: Marumado
description: One hub for every project on this machine, and for the machines themselves.
colors:
  ground: "#e9e9e6"
  ground-raised: "#f1f1ee"
  ink: "#111110"
  ink-2: "#565653"
  ink-3: "#8b8b87"
  track: "#d3d3cf"
  rule: "#111110"
  rule-soft: "#c4c4c0"
  signal: "#ff4f00"
  signal-text: "#b33600"
  on-signal: "#111110"
  on-mod: "#ffffff"
  module-projects: "#2a66db"
  module-machine: "#00864e"
  module-urls: "#8549c8"
  module-ports: "#007b95"
  module-docker: "#b72e82"
  module-processes: "#8d6f13"
  module-agents: "#577a00"
  module-momentum: "#0b7a68"
  module-skills: "#5b4fd0"
  module-machines: "#4d6a86"
  dark-ground: "#0e0e0d"
  dark-ground-raised: "#171716"
  dark-ink: "#ecece8"
  dark-ink-2: "#a6a6a1"
  dark-signal-text: "#ff7a40"
typography:
  display:
    fontFamily: "Chakra Petch, ui-sans-serif, sans-serif"
    fontSize: "clamp(30px, 3.4vw, 54px)"
    fontWeight: 700
    lineHeight: 0.9
    letterSpacing: "0.02em"
  title:
    fontFamily: "Chakra Petch, ui-sans-serif, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "0.04em"
  body:
    fontFamily: "Chakra Petch, ui-sans-serif, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: "Chakra Petch, ui-sans-serif, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.16em"
  data:
    fontFamily: "Fira Code, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
  dial-value:
    fontFamily: "Doto, Fira Code, ui-monospace, monospace"
    fontWeight: 900
rounded:
  card-sm: "10px"
  card: "14px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 2.2vw, 36px)"
  row: "56px"
  touch: "44px"
components:
  button:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "40px"
  chip:
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "30px"
  index-chip:
    backgroundColor: "{colors.module-projects}"
    textColor: "{colors.on-mod}"
    rounded: "5px"
  card:
    rounded: "{rounded.card-sm}"
    padding: "12px 14px"
  machine-card:
    rounded: "{rounded.card}"
    padding: "16px 18px 14px"
  status-badge-alert:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.on-signal}"
---

# Design System: Marumado

## Overview

**Creative North Star: "The Device on the Desk."** Marumado reads like a piece of consumer hardware in the spirit of Teenage Engineering and Nothing OS. It is light grey plastic with black ink, hairline rules, numbered modules, round dials and dot-matrix numbers. Each module is a feature of the device with one colour, one dial and one reading, so the whole machine reads in one glance from a side monitor.

It is quiet until something matters. Normal state is calm ink on grey. The one red-orange (`signal`) appears only when something needs you. It refuses the dark cockpit, the card-grid admin template and dense table-filled home screens.

## Colors

### Primary
- **Signal Red-Orange** (`signal` #ff4f00): reserved for "needs you": fault lamps, the alert badge, a dial arc past its budget, the focus ring, selection and the caret. It is never a module colour and never decoration. As text it is `signal-text` (#b33600 light, #ff7a40 dark), which passes AA at small sizes.

### Module colours
One colour per module, like the coloured encoders on a synth: Projects blue, Machine green, URLs violet, Ports teal, Docker magenta, Processes ochre, Agents olive, Momentum sea-green, Skills indigo, Machines slate. A module's colour marks its index chip, icon, dial arc, lamps, active cell and the short bar under its sheet title. Components read it through `--mod` (set by `.mod-<id>`). Module colours are for marks and fills, **not for small text**: several sit around 4:1 on the ground.

### Neutral
- **Device Grey** (`ground` #e9e9e6) with **Raised Grey** (`ground-raised`) for the active or hovered surface.
- **Ink** (`ink` #111110) for text and the strong hairline (`rule`). **Ink-2** (#565653, 6:1) for all secondary text. **Ink-3** (#8b8b87) is for strokes, empty lamps and tracks only, never text.
- `track` is a dial or meter's empty groove; `rule-soft` separates rows.
- Dark mode (`prefers-color-scheme: dark`) swaps the ground to near-black and brightens every module colour; the roles stay the same.

### Named Rules
- **The One Alarm Rule.** Red-orange means "act". If nothing needs you, no red-orange is on screen.
- **The Text Is Ink Rule.** Text is `ink`, `ink-2` or `signal-text`. Colour carries meaning through marks, not letters.

## Typography

- **Chakra Petch** (500/600/700) is the voice: sheet titles in heavy uppercase, stretched 10% wide (`scaleX(1.1)`); labels in 11–12px tracked caps (0.14–0.22em); body at 16px/500.
- **Fira Code** is for data and measurement only: project names, paths, ports, readings, logs. It is not a "technical" costume.
- **Doto** is the dot-matrix face, only for dial values and the status badge.
- Numerals are tabular everywhere (`font-variant-numeric: tabular-nums`) so live numbers don't jitter.

### Hierarchy
- **Display** (sheet title): `min(clamp(30px, 3.4vw, 54px), 12cqi)` so a single word always fits its column. It wraps between words, never inside one.
- **Title** (machine card name): 20px/700 caps.
- **Section label** (`h3` in a sheet): 12px/600, 0.22em tracking, `ink-2`.
- **Body / row**: 16px, Fira Code for the item's name and Chakra Petch 13px `ink-2` for its sub-line.

## Layout

- The app is a top bar (wordmark, machine picker, streaming toggle, active agents, search pill, CPU/RAM vitals, status badge) over a two-column main: the **module sidebar** (dials, one per row, or a 92px rail of dials only) and the **sheet** (the open module, or the Overview at home).
- On wide screens the app is one viewport tall and each column scrolls on its own. A sheet never grows wider than its column (`:where(.sheet)` gets one `minmax(0, 1fr)` column).
- Below 860px the sidebar becomes a 2-up dial grid. Home shows the Overview first, then the dials, and a module page shows only its sheet with a Home back link.
- Lists are rows of at least 56px separated by `rule-soft` hairlines. Grids of cards use `auto-fill` with a `min(100%, …)` minimum, so they never scroll sideways.
- On phones every control is at least 44px tall.

## Elevation & Depth

Flat. Depth comes from hairlines and tone (`ground` to `ground-raised`), never shadows. The one exception is the search palette overlay, which floats with a soft ambient shadow.

## Shapes

- Pills (`999px`) for small controls: buttons, chips, the search field, the picker, the streaming toggle, the status badge.
- Rounded rectangles for containers: 10px for item cards, 14px for machine cards and notices.
- Circles for dials, lamps (12px, 9px in cards) and the badge disc.
- Thin outline icons: one authored set on a 24px grid with a 1.6 stroke.

## Components

### Buttons
`.btn`: an ink-outlined pill, 40px tall (44px on phones), caps label. `.btn--quiet` uses the soft rule. Destructive actions (stop, kill, remove) go through `ConfirmButton`, which asks for a second press.

### Chips
`.chip`: a soft-ruled pill, 12px tracked caps, 30px (44px on phones). Used for item links (Local, Live, Repo, folder) and item actions (Start, Restart, Stop, Logs). `.chip--fault` takes the signal border and text.

### Cards / Containers
- **Item card** (`.itemcard`, Projects and Docker grid views): soft-ruled 10px card. A lamp and state in tracked caps on top, the name in Fira Code, sub-lines in `ink-2`, actions pinned to the bottom so they line up across a row.
- **Machine card** (`.mcard`, Overview): 14px card holding the lamp and name, CPU/RAM/disk meters, one row per module reading (module-colour dot, label, value) and the machine's "needs you" list under an ink rule. The machine on screen is raised; an unreachable one has a signal border.
- Nested cards are never used.

### Inputs / Fields
- **Filter**: borderless input on a soft rule with a search icon; focus darkens the rule and icon.
- **Field**: label above a ruled box; focus turns the border ink.
- Placeholders are `ink-2`, and the caret is signal.

### Navigation
The module sidebar cell carries an index chip in the module colour, a label, an icon and a **Dial**. The active cell is raised. The `/` or ⌘K palette searches everything.

### Dial (signature)
A round dial with a grey track and an arc in the module colour holds a dot-matrix value and a caption. It sweeps to its value once on mount, then follows the data without tweening. On fault the arc turns signal.

### Streaming mode
An eye toggle next to the machine picker (on by default, and forced by `?stream`) masks SSH logins, host names, paths, addresses, commands and logs with a quiet "… hidden" placeholder (`Secret`, `useRedact`).

## Do's and Don'ts

### Do:
- **Do** give every new module one colour, an index, an icon and a dial summary in `registry.ts`. It joins on equal footing.
- **Do** treat "unavailable" (Docker off, Herdr not running, a machine unreachable) as a calm, explained state, not an error.
- **Do** label states in plain words for someone who isn't the owner ("2 of 3 working", "Herdr not running").
- **Do** keep live numbers in tabular figures and move a value's colour only when it crosses a budget.

### Don't:
- **Don't** use red-orange for anything that doesn't need the viewer.
- **Don't** set small text in a module colour or `ink-3`.
- **Don't** add shadows, gradients, glass or nested cards.
- **Don't** fill the home screen with tables. Home is the Overview plus the dials, and details live in each module's sheet.
- **Don't** animate layout properties. Use transform or opacity, and give a short fade under reduced motion.
