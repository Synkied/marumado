---
name: Marumado
description: One hub for every project on this machine, and for the machines themselves, built like a Braun T3.
colors:
  body: "#e7e5e0"
  panel: "#f4f3f0"
  well: "#e7e5e0"
  ink: "#1c1c1b"
  ink-2: "#5f5e5a"
  ink-3: "#9a9893"
  track: "#dcdad4"
  grid: "#e1dfd9"
  grid-major: "#d3d1cb"
  rule: "#c9c7c0"
  rule-soft: "#dedcd6"
  graphite: "#2a2a29"
  on-graphite: "#f4f3f0"
  pen-off: "#b4b2ac"
  green-light: "#5a7654"
  braun-orange: "#f05a1a"
  braun-orange-text: "#b5400b"
  on-orange: "#1c1c1b"
  done-slate: "#4f6074"
  night-body: "#1b1b1a"
  night-panel: "#262624"
  night-ink: "#ecebe7"
  night-ink-2: "#a9a7a1"
  night-ink-3: "#6f6d68"
  night-rule: "#454541"
  night-green-light: "#8fb089"
  night-orange: "#ff6a2b"
  night-orange-text: "#ff8a55"
  night-done-slate: "#9fb2c8"
  module-projects: "oklch(0.44 0.06 266)"
  module-urls: "oklch(0.5 0.051 158)"
  module-machine: "oklch(0.48 0.042 215)"
  module-docker: "oklch(0.49 0.045 190)"
  module-agents: "oklch(0.48 0.06 300)"
  module-skills: "oklch(0.46 0.051 330)"
  module-ports: "oklch(0.5 0.048 85)"
  module-tasks: "oklch(0.47 0.054 0)"
  module-momentum: "oklch(0.5 0.042 245)"
  module-processes: "oklch(0.46 0.018 60)"
  module-machines: "oklch(0.45 0.024 250)"
typography:
  display:
    fontFamily: "Inter Tight, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(32px, 3.2vw, 50px)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Tight, Helvetica Neue, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 600
  wordmark:
    fontFamily: "Inter Tight, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(19px, 1.5vw, 23px)"
    fontWeight: 600
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Tight, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter Tight, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.12em"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
  terminal:
    fontFamily: "Iosevka, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  control: "999px"
spacing:
  unit: "2px"
  gutter: "clamp(16px, 1.2vw, 24px)"
  control-sm: "30px"
  control: "40px"
  touch: "44px"
components:
  key:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "40px"
  key-hover:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.on-graphite}"
  key-orange:
    backgroundColor: "{colors.braun-orange}"
    textColor: "{colors.on-orange}"
    rounded: "{rounded.control}"
  segmented-pressed:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.on-graphite}"
    rounded: "{rounded.control}"
  chip:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  field:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    height: "44px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.xl}"
  tile:
    backgroundColor: "{colors.well}"
    rounded: "{rounded.lg}"
---

# Design System: Marumado

## Tokens

Every design decision lives in `frontend/src/tokens.css`: colours (light and dark), syntax colours, the terminal palette, fonts and their imports, the type scale, tracking, spacing, control heights, corners, elevation and motion. Components refer to tokens only, so a retheme is an edit to that one file. The desktop app's two bundled pages (`desktop/setup/index.html`, `starting.html`) can't load the app's CSS, so they carry a copy of the palette, the panel and well shadows and the font stacks; change them together with `tokens.css`.

- **Colour**: `--ground` (the body), `--ground-raised` (a panel), `--well` (sunk into a panel), `--disc` (a dial's face, the well), `--ink`, `--ink-2/3`, `--track`, `--grid(-major)` (a chart's rules), `--rule(-soft)`, `--solid` and `--on-solid(-2)` (the graphite key), `--pen-off`, `--moss` (the green light), `--signal(-text)` and `--on-signal` (Braun orange), `--done` (slate), `--c-<module>` (each module's muted colour), `--syn-*` for the code viewer, `--term-*` for the terminal. A `.mod-<id>` class sets `--mod`, the one hook components read for "this module's colour"; outside a module it is ink.
- **Type**: `--f-sans` (Inter Tight), `--f-mono` (IBM Plex Mono), `--f-cjk` (the two vendored Noto Serif JP glyphs for 丸窓); weights `--weight-body/strong/heavy` (400/500/600; `--weight-light` is 400, since only 400–600 ship); sizes `--text-2xs` (10) to `--text-3xl` (28), fluid `--text-display(-sm/-xs)`, `--text-wordmark`, `--text-crumb`; tracking `--track-display/title/snug/caps/caps-wide/wordmark`. The live terminal keeps its own narrow mono, Iosevka (imported in `Terminal.tsx`), so a wide pane fits at a bigger size.
- **Spacing**: `--sp-N` is N × `--space` (2px), from `--sp-1` (2px) to `--sp-22` (44px). `--gutter` is the page margin and the gap between panels.
- **Sizes**: `--control-sm` (chips, small keys), `--control` (keys), `--touch` (round header keys, the phone minimum).
- **Corners**: `--radius-xs` to `--radius-xl` (4–16px), and `--radius-control` (a pill) for keys, chips, segmented controls and the picker; lights, dials and round windows stay `50%`.
- **Elevation**: `--shadow-panel` (a panel on the body), `--shadow-well` (a well pressed into a panel), `--shadow-key` (a key's lip), `--shadow-float` (what floats over the page).
- **Motion**: `--ease`, `--dur-quick` (hover, state), `--dur-base` (surfaces), `--dur-enter` (a sheet arriving), `--dur-slow`, `--dur-sweep` (a dial's arc settling on its reading).

Rules for new CSS: no raw colours, font sizes, letter-spacing, radii, shadows or durations; spacing from `--sp-*` (1px hairlines and `em` offsets are fine); the geometry of marks (the scale and marks in `Dial.tsx`, the seal in `fleet.tsx`) stays literal. CSS can't read a variable inside a media query, so the phone breakpoint (860px) is written into `app.css`.

## Overview

**Creative North Star: "The Braun T3."** Marumado is a calm household appliance for your machines and agents, after Dieter Rams: a warm grey body with soft-cornered panels set on it like a radio's faceplate, wells pressed into the panels, pill keys, status lights and dials. It is quiet and familiar: big targets, clear grouping, lights everyone reads without a legend.

One orange is the one control that waits on you. A green light means working or all clear; slate means done and ready to read; grey means resting. If nothing needs you, there is no orange on screen. The pets live in round windows (丸窓) sunk into the panels; a pet that needs you carries an orange light on its window's rim. It refuses the dashboard card grid, glass, gradients, neon, and decoration that is not a control or an instrument.

**Key Characteristics:**
- Panels on a warm grey body, lifted by a soft shadow, never a border.
- Wells, tiles and round windows in the body's grey, pressed into the panels.
- Pill keys; the pressed or selected one is the graphite key; orange only for what needs you.
- Dials with a 270° scale open at the foot, the reading in mono in the middle.
- Inter Tight for words, IBM Plex Mono for values, Iosevka in the terminal.
- Both themes ship: the T3 by day, a graphite T3 at night.

## Colors

A warm grey appliance with one orange and one green light; muted module colours only where a chart needs to tell channels apart.

### Primary
- **Braun Orange** (`braun-orange`, text in `braun-orange-text`, legends on it in `on-orange`): needs you, and nothing else. The status light and its words, the light on a waiting pet's window, a dial's arc or a meter past its budget, a reading tile that needs you (an orange ring on a faint orange wash), a lane waiting on you, fault lights, the answer key, an armed destructive key. Legends on an orange key are dark (5:1), as on Braun's coloured keys.

### Secondary
- **Green Light** (`green-light`, 4.6:1 on a panel): working, alive, all clear. The status light at rest, a machine's light, lights of running things, a dial's light while something works, working lanes.

### Tertiary
- **Done Slate** (`done-slate`): finished, ready for you to read. Done lights, a done pet, done lanes; quieter than the orange.
- **Module colours** (`module-*`): one muted colour per module, at about 60% of the chart recorder's chroma, used for chart channels (the hour ribbon's reading/editing/running/thinking, strip charts, the record's marks inside a dial) and module icons. Never for state.

### Neutral
- **Body** (`body`): the page, and the grey of every well, tile and round window. **Panel** (`panel`): sheets, the sidebar, home's machine panels, the key strip, the palette, menus, the desktop card.
- **Ink** (`ink`): text and the darkest marks, a dial's value arc. **Ink-2** (6.2:1 on a panel): all secondary text. **Ink-3**: resting lights, strokes; never text.
- **Graphite** (`graphite`, text `on-graphite`): the pressed key: the open module in the key strip, the pressed segment, a key on hover, the streaming key when on, text selection. At night it turns pale (`night-ink`) with dark text.
- **Track** (`track`): the empty part of a meter and a dial's scale. **Rules** (`rule`, `rule-soft`): hairlines inside a panel.
- **Night** (`prefers-color-scheme: dark`): a charcoal body (`night-body`), panels a step lighter (`night-panel`), wells back down to the body; `night-ink-2` at 6.4:1; a brighter orange and green. The roles stay the same.

### Named Rules
**The One Orange Rule.** Orange means "act". If nothing needs you, no orange is on screen.

**The Graphite Key Rule.** What is pressed, open or selected is the graphite key, never a module colour.

**The Text Is Ink Rule.** Text is `ink`, `ink-2`, `braun-orange-text`, or a key's legend. Green, slate and module colours carry meaning through lights and marks, not long runs of letters.

## Typography

**Sans:** Inter Tight (with Helvetica Neue, Arial), a compact neo-grotesk in the line of Braun's Akzidenz legends, for names, prose, controls and labels.
**Mono:** IBM Plex Mono, for every value, reading, axis, path, port, PID, log and code.
**Terminal:** Iosevka, narrow, so a wide agent pane fits at a bigger size.

**Character:** Plain and exact, like the legends on a faceplate. Small tracked caps name panels and sections.

### Hierarchy
- **Display** (400, `clamp(32px, 3.2vw, 50px)`, 1.04, -0.025em): sheet titles, in sentence case.
- **Title** (600, 21px): a machine panel's name, "Agents at work".
- **Wordmark** (600, `clamp(19px, 1.5vw, 23px)`, -0.01em): "marumado" in lowercase beside the round-window mark, the version in mono under it; 丸窓 at 62% in `ink-2`, shown from 1600px up.
- **Dial reading** (Plex Mono 400, 13–15% of the dial's width, tabular): the value in a dial's middle.
- **Body / row** (400, 16px, 1.45): item names, inputs, lede (max 60ch). Sub-lines at 14px in `ink-2`.
- **Key** (500, 14px): key and segment legends, sentence case; the key strip's names at 12px.
- **Label** (500, 11px, 0.12em, uppercase): panel and section labels, reading names on home tiles, field labels.
- **Data** (Plex Mono, 11–15px): readings, axis ticks, time spans, paths, ports, PIDs, logs, code.

### Named Rules
**The Mono Is Data Rule.** Plex Mono where a value is read. Sentences, names and statuses ("1 needs you", "this machine · up 11h") are set in Inter Tight.

**The Quiet Controls Rule.** Keys, toggles and links are sentence case. Uppercase is for labels that name things, never for actions.

## Layout

- **The top bar** sits on the body: back/forward, the wordmark, the machine picker (on machine pages), the streaming and lock keys (round, on a panel), then the **key strip** (a pill panel holding one key per work module, each a small dial and its name, and the top pets in round windows after a hairline), the round search key, CPU/RAM, and the status light with its words. Below 1600px 丸窓 goes first; with the picker also in the bar, the keys drop their names; from 861–1365px they always do.
- **Home** scrolls to the window's edges: "Agents at work" as a panel, then each machine as a panel (machines that need you first).
- **A module page** is the sheet in one panel beside the sidebar panel (pinned projects); the Agents page is two panels of its own, the list and the open agent. On wide screens the app is one viewport tall and each panel scrolls on its own. Panels are `--gutter` apart.
- **Below 860px** the key strip takes a row of its own under the bar, names under the dials; a module page is its sheet panel alone with a Home back link. Every control is at least 44px tall.
- Inside a panel, lists are rows of at least 56px on `rule-soft` hairlines; grids of tiles use `auto-fill` with a `min(100%, …)` minimum, so they never scroll sideways.

## Elevation & Depth

Three levels, each declared once: the body; a panel lifted off it (`--shadow-panel`: a 1px inner highlight, a tight 1–2px shadow and a soft 18px fall); and a well pressed into a panel (`--shadow-well`, an inner shadow). Keys carry a 2px lip at their foot (`--shadow-key`). What floats over the page (the search palette, menus, the dock) adds `--shadow-float`. A surface takes a shadow or a border, never both; tiles inside a panel are flat body-grey.

### Named Rules
**The Faceplate Rule.** Panels sit on the body, wells sit in panels, and nothing nests deeper: a tile is never a panel inside a panel.

## Shapes

- **Circles** are the signature: round windows, dials, lights, round keys, the wordmark's mark (a rim and its light).
- **Pills** for keys, chips, segmented controls, the key strip and the picker.
- **Soft corners**: panels 16px, tiles, fields and cards 12px, small inner pieces 4–10px.
- **Thin outline icons**: one authored set on a 24px grid with a 1.6 stroke, in `ink-2`.

## Components

### Keys (buttons)
- **Shape:** a pill (40px; 44px on phones), legend at 14px weight 500.
- **Default:** body grey on the panel with its lip; `.btn--quiet` is transparent with a `rule-soft` outline.
- **Hover:** the graphite key.
- **Orange key:** the one action that answers what needs you. **Armed (destructive):** orange; stop, kill and remove go through `ConfirmButton`, which asks for a second press.
- **Icon keys:** round, quiet until hovered (a well), pressed is graphite.

### Chips
- **Style:** small body-grey pills (30px; 44px on phones), 12px legends in sentence case; on a tile they turn panel-coloured. Hover is graphite.

### Cards / Containers
- **Panels:** 16px corners, `panel`, `--shadow-panel`, no border.
- **Tiles:** project and container cards, home readings, home's agent lanes, plan items, the Tasks board's columns: body grey, 12px corners, no shadow; hover draws a `rule` hairline ring. Kanban cards sit raised on their column (panel colour with the panel shadow).

### Inputs / Fields
- **Field:** label in tracked caps above a well (12px corners, `--shadow-well`); focus draws an `ink-2` hairline.
- **Filter and search:** borderless, on a single soft underline.
- **Segmented:** a pill well holding its options; the pressed one is the graphite key. Module tabs are plain words on the head's rule, the open one underlined in ink.

### Navigation
- **Key strip:** the open module's key is graphite with a light legend; hover is a well. The agents' key carries an orange count on its corner.
- **Status:** a 10px light plus words: green "all clear", or orange "1 needs you" with a soft halo (it comes on with one fading ring).
- **Palette:** `/` or ⌘K opens search over everything, a floating panel; the selected result is graphite.

### Dial (signature)
A module's channel as a Braun dial (`Dial`): a round face sunk into the panel, a 270° scale (`track`, 9 units, round caps) from seven-thirty to four-thirty, open at the foot, and the reading in mono in the middle (name in tracked caps and a caption under it on large dials; the caption is hidden under 190px). What it shows comes from the module's `Summary` in `registry.ts`:
- **fraction**: the value as an ink arc along the scale, orange when it needs you; it sweeps in once on load.
- **trace** and **ticks**: the recent record as scale marks inside the arc, oldest at the left, as long as their values (ticks on a square-root scale); on the alarm the newest eighth is orange.
- **lanes**: the scale split into one segment per item: green working, slate done, `ink-3` off, orange fault.
- **light**: at twelve o'clock above the scale, green and breathing while something works, orange and steady when it needs you.
Off is an empty face with a dashed `pen-off` scale and "off" in `ink-2`. A quiet dial draws lighter. The time span is printed in the scale's open foot ("30 min", "12 wk").

### Round windows (the pets)
Every pet sits in a round window: a body-grey circle with `--shadow-well` and a few pixels of margin, in the agents' list and heading, home's agent lanes (several agents of one folder overlap their windows) and the top bar. A pet that needs you carries an orange light with a soft halo on its window's rim. The pets are drawn in ink; their fill takes the window's grey (`--critter-fill`).

### Machine panels (home)
Home (`modules/fleet.tsx`, readings in `modules/readouts.ts`) shows every machine as a panel:
- **Header:** the machine's light (green when well, orange with a halo when something needs you, a dashed grey ring while connecting), its name (opens its Machine page), a context line, its status ("all clear", "2 need you", "unreachable"), and Arrange and Fold icon keys.
- **Readings:** body-grey tiles on `repeat(auto-fill, minmax(136px, 1fr))` (140px on phones), so they wrap and every machine shares the same columns: the name in tracked caps with its **seal** (a 32px Braun dial: one ink arc along the 270° scale with a tick at its budget, or one segment per item) beside it, the value large in mono (`--text-3xl`), and a line of words under it, or for CPU its last half hour as a line with a dot at now. A reading that needs you keeps its place, with an orange ring on a faint orange wash. An absent module's value pales and its seal is dashed. New modules add an entry to `READOUTS`.
- **Per machine:** Arrange shows, hides and reorders readings; "Use on every machine" copies them. Saved per viewer in browser storage.
- **Order and folding:** machines that need you (or are unreachable) rise to the top and stay open; this machine is open; calm remote machines fold to one line with their vitals. In the side-by-side layout each machine is a narrow panel with one reading per line.

### Agents at work (home)
A panel at the top of home (`modules/agentPulse.tsx`, data from `/api/agents/pulse`): one tile per agent (agents of one kind in one folder share a tile), all on the same columns: the pets in their windows (each opens its agent), its name, state and project, the last thing it did in mono, and its **hour ribbon**: a bar a minute, as tall as the steps it took (square-root scale), split by kind in the module colours (reading in Momentum's, editing in URLs', running in Ports', thinking in a pale Agents colour), an ink rule where you wrote to it, an orange mark under the baseline where a step failed, a rule every ten minutes, and a dot at now (pulsing while it works). On the right, its turn ("at it 14m", "waiting", "quiet"), files changed, steps, failures. A tile waiting on you takes an orange ring and wash.

### The Agents page
The list panel (workspaces, sources, one thread per agent with its pet in a round window; the open one sits in a well) beside the open agent's panel: its head (pet, name, state, project, tools), the slim next-move bar (orange only while it waits on you, with the answer as the orange key), and the chat or the **terminal**, which takes the rest of the panel: a dark screen set into it (`--term-bg` in both themes, an inner shadow), since agents draw for dark terminals.

### Strip charts
On module pages (`DotChart`): a line across ruled space, oldest at the left, a dot at now on the right, axis values in mono, the span under it. A channel that went quiet (a URL down) ends at its last reading, marked by a dashed orange break. Meters are 6px pill grooves in `track` filled in the module colour (ink outside a module) with an ink budget tick, orange past budget.

### Tasks board
Tasks has two tabs under its head, a segmented control: **Tasks** (the board, the default) and **Plans** (the plans list); an "Archived" quiet button in the head opens the archive (finished plans and done tasks put away, each with Restore). As on a GitHub project board: five columns (To do, Working, Needs you, To review, Done), each headed by a small lamp in its state's colour (an outline for To do, moss for Working, orange for Needs you, a slate ring for To review, solid slate for Done), its name and its count. On desktop the board takes the height left under the tabs, so the foot of every column is in view; each column scrolls its own cards. Card titles stop at three lines. At the foot of every column but Needs you, a quiet full-width "+ Add a task" (Add and hand over, Add to review, Add as done) opens into a small card in the Tasks colour: the prompt (its first line names the task; Enter adds and keeps it open for the next one, Shift+Enter starts a new line, Escape closes it), the project (remembered per browser), Add and Cancel. A task added under Working is made, then goes to choosing its agent. On phones, a column per screen width, swiped across. Cards move between columns by dragging. Under Done, beside "Show all", a quiet "Archive all" (pressed twice). A task's page has its **Prompt** (a roomy text box: what the agent is told) and its **Title** (short, for lists; left empty, made again from the prompt), and once done an "Archive" quiet button beside Save.

### Plans
Under the Plans tab, plans grouped by state (Running, Scheduled, Paused, Draft, Finished; each group headed by its name and count, empty groups left out): each plan a tile of the body's grey with its name, project and progress, and its **strip**, the plan's shape in miniature (a column per row, a cell per step: the Tasks colour when at work, paler once finished, orange when it needs you, an outline while queued). A plan's page:
- **Setup** as a sentence with inline selects on a soft underline ("demo · new agents are claude on vm"); Start / Pause / Resume and Delete beside the title; once finished, Archive (the plan and its steps leave the plans list and the board; its page says so, with Restore).
- **Lanes**, the plan as a record: one lane per agent (named in mono), time running left to "now" over three quarters of the width; what ran inked in the Tasks colour (solid at work, paler finished, orange needing you), what is queued past "now", dashed, in the order it will start.
- **The builder**: the rows hang off a rail on the left: a numbered mono node per row (outlined; ringed while at work; filled in the Tasks colour once finished, orange when it needs you), "at once" under it when the row has several steps, a hairline with an arrowhead down to the next row, ending on a dashed "+" node for the next step. A row's steps sit side by side as cards: a grip, the lamp and title (made from the step's prompt), a folded "Prompt" under it that opens to the whole prompt, quiet arrow buttons top-right (up: earlier, on its own; down: later, on its own; join: with the row above; ×: remove), who takes it, and the who-select. A step that continues with the agent of the step above it is tied to it by a dotted line in the Tasks colour. A step that hasn't started is dragged onto a row (a dashed "Runs at the same time" card shows where it lands) or between rows (the gap opens into a dashed "Run on its own here" slot). After a row's steps, a dashed card the size of a step, "+ At the same time", opens into a card with a roomy text box (Enter adds, Shift+Enter a new line, Escape cancels); the last line, a three-line text box written as you'd tell the agent, adds the next step or takes one from To do.
- A queued task's lamp is a dashed ring.
- **Asking first**: a step marked "Ask me before it starts" (a checkbox on the step, and under the next-step field) doesn't start by itself. Once its turn comes it reads as needing you: orange lamp, cell and node, "waits for your go" in its sub-line, a Go button on the card, and a notice under the setup with the same Go. The Agents bell counts these steps, and the inbox lists each one above the questions, with its Go.
- **The plans modal**, over the Agents page (`modules/planModal.tsx`): the queue button in the agent's toolbar (a list with an arrow, the count of steps queued for it, orange when the next one waits for your go) and "Next: …" in its header line open it. It is a modal `<dialog>` on the floating shadow over a blurred ground, nearly the window's size (full screen on a phone), with a segmented control: **Next for <agent>**, a roomy text box (its first line names the step, all of it goes to the agent; Ctrl/⌘+Enter queues it), "Ask me before it starts" (remembered per browser), a sentence saying when it will start, and the queue as numbered dashed rings in the Tasks colour (solid orange when waiting for your go); and **Plans**, the plans list, a new plan and a plan's page, moving between them inside the modal. Escape or a click on the backdrop closes it.

### Agent critters (the dock)
Every running agent, from every source (plain terminals aside), is a small ink critter on a small panel floating in the bottom-right corner of every page (`modules/agentDock.tsx`, `components/Critter.tsx`). Each critter is generated from its agent's source and pane, so the same agent always looks the same: body proportions, a topper (ears, points, antenna, sprout, tuft, horns or none), a marking (a ring, spots, a band, a belly or none), eyes and feet. Shape tells agents apart; theme-aware ink and pose say the state everywhere critters appear: ink while working, orange when they need you, slate when finished, `ink-2` while idle, and a dashed `pen-off` grey when unknown.
- **working**: nods over a pen and writes a trace along the ground, the trace of its work.
- **needs you**: orange, lifts off the line and settles, and holds up a question mark. It stays in its place: state never reorders the dock.
- **finished its turn**: content eyes, a small bow, a check drawn once in slate.
- **idle**: asleep, breathing slowly, with a z.
- **unknown**: a dashed `pen-off` outline, still.
Blinks and breaths are out of step from one critter to the next. Under reduced motion every loop stops, and the poses alone tell the states apart. Choosing a critter opens its card above the dock (not modal; Escape or a click elsewhere closes it): name, kind, project, source, state, its live terminal (fitted: the pane takes the card's size while it is open, and you can type into it in control mode; Escape there goes to the agent), or, when it needs you, its question with the answer keys (`Question` from the inbox), then Open terminal and Project page. Folding the dock leaves out only the critters that need you (a small tab with the count otherwise), remembered per browser. Each critter keeps the place you give it, so an agent is always found where you left it: drag it along the line (touch too), or Alt+←/→ on a focused one; a new agent joins at the end; the order is remembered per browser (`marumado.dock.order`). Up to 8 critters (5 on a phone), then "+N" to the Agents page, in orange when one past the edge needs you. With no agents running, there is no dock. Pages pad their ends so the dock never hides the last row.

### Streaming mode
An eye key in the top bar (on by default, and forced by `?stream`) masks SSH logins, host names, paths, addresses, commands and logs with a quiet "… hidden" placeholder (`Secret`, `useRedact`). On, it is the graphite key.

### The desktop app's own pages
The first-run page and the starting page (`desktop/setup/`) follow the same world from their own copy of the tokens: the connect form is one panel on the body with well fields, a pill segmented control and a graphite pill key; the starting page shows a dial-like ring whose arc turns around a solid light.

## Do's and Don'ts

### Do:
- **Do** set every surface as panel on body, or well/tile in panel, with its one shadow (`--shadow-panel` or `--shadow-well`).
- **Do** make the pressed, open or selected control the graphite key.
- **Do** put every pet in a round window, and light its rim orange when it needs you.
- **Do** give every new module a label, an icon and a summary (value, fraction, caption, fault, off, and a `chart`) in `registry.ts`, and a reading in `readouts.ts`, so it appears on every machine's panel and as a dial.
- **Do** draw real data on a dial; with no history, show its items as lanes rather than inventing a trace.
- **Do** treat "unavailable" (Docker off, Herdr not running, a machine unreachable) as a calm, explained state: an empty dial and plain words, not an error.
- **Do** label states in plain words for someone who isn't the owner ("1 of 4 working", "Herdr not running").
- **Do** keep live numbers in tabular figures, and change a value's colour only when it crosses a budget.
- **Do** check both themes: every change ships in the T3 and the graphite T3.

### Don't:
- **Don't** use orange for anything that doesn't need the viewer, or green for decoration.
- **Don't** give a project, an item or a category a colour of its own; module colours are for chart channels, and state stays green, slate and orange.
- **Don't** put a border and a shadow on the same surface, or a panel inside a panel.
- **Don't** add gradients, glass, glow, neon, or bevels and metal beyond the panel, well and key shadows.
- **Don't** set sentences, names or statuses in mono, or actions in uppercase.
- **Don't** add kicker labels above titles or numbered section indexes.
- **Don't** give home fixed columns. Readings are wrapping tiles; details live in each module's page.
- **Don't** animate layout properties. Use transform, opacity or stroke drawing, with a short fade under reduced motion.

### Agent decisions (2026-10-05)
Waiting-agent alerts and home agent links open `#/m/agents/inbox/<source>/<pane>`. The named question comes first among agent questions and receives keyboard focus. Its project links back to the project page; the terminal remains available for fuller context.

After a successful input request, keep the question and the selected response in the inbox for the current visit. “Response sent” acknowledges delivery; “Agent resumed” requires a reported working state. Idle and finished states are named separately. Failed sends leave controls available for retry; unreadable screens disable input. Read-only connections explain where to answer. Responses are temporary UI receipts, not a persistent approval history.
