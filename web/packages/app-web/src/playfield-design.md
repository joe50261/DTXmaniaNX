# Playfield — design spec

The canonical layout for the in-play scene's lane chrome. Sourced
from the C# DTXMania reference under
`DTXMania/Code/Stage/07.Performance/DrumsScreen/`. Two sub-features
covered here:

1. **Permanent lane chrome** (`7_Paret.png`) — per-lane vertical
   strips painted every frame regardless of hit state. Includes
   the canonical **footprint pattern** stamped down the BD and LP
   foot-pedal lanes.
2. **Lane-flush overlay** — vertical streak that lights up the
   full-height of a struck lane for ~500 ms after a hit.

The 3D pad meshes and chip atlas are already wired in `renderer.ts`
and stay there for now (a follow-up will move them into
`playfield-canvas.ts` so the whole playfield lives behind one
entry point).

## Frame

- **Logical canvas:** 1280 × 720 px.
- **Lane geometry source:** `lane-layout.ts` — already pinned to the
  C# `CActPerfDrumsPad` x-table.

## Permanent lane chrome — `CActPerfDrumsLaneFlushD` (txLine path)

Source asset: `7_Paret.png` (558 × 720, RGB). Always-on background
painted every frame — *not* a hit-triggered effect. The C# code
reads named slices out of the same asset and pastes one per lane;
the BD (src x 278..347) and LP (src x 121..172) slices contain the
canonical **footprint pattern** stamped down those two pedal lanes
roughly every 120 px. The other slices are vertical separator
bars and lane tinting.

### Per-lane slice table (Type-A layout)

Pinned to `CActPerfDrumsLaneFlushD.cs:189-298`. C# uses fixed
destination X values for the canonical 1280-wide grid; the web
port re-anchors each slice to the lane centre from `lane-layout.ts`
so the pattern lines up with the chip stream regardless of any
lane drift.

| Lane | C# dst x | Source rect | Notes                  |
|------|---------:|-------------|------------------------|
| LC   | 295      | (0,0,72,720)   | left bar             |
| HH   | 367      | (72,0,49,720)  |                      |
| LP   | x2 − 12  | (121,0,51,720) | **footprint motif**  |
| SD   | 467      | (172,0,57,720) |                      |
| HT   | 524      | (229,0,49,720) |                      |
| BD   | 573      | (278,0,69,720) | **footprint motif**  |
| LT   | 642      | (347,0,49,720) |                      |
| FT   | 691      | (396,0,54,720) |                      |
| CY   | 745      | (450,0,70,720) |                      |
| RD   | xCY−55   | (520,0,38,720) |                      |

Slices paint at native source width — they may extend a few px
into adjacent lanes, which is the canonical look (the visible
motif inside each slice is centred narrower than its bounding
box, so the overlap is mostly transparent).

### Render order

`paintLaneChrome` runs before `paintLaneFlush` so a hit's flush
streak overlays the chrome rather than being painted under it.
Mirrors the C# `OnUpdateAndDraw` sequence (`txLine.tDraw2D` → flush
loop). When `7_Paret.png` is absent the chrome paint is silently
skipped — the lane fills + colored separators in
`renderer.drawLanes` keep the playfield readable.

## Lane-flush overlay — `CActPerfDrumsLaneFlushD`

A vertical streak that lights up the full height of a struck lane
for ~500 ms after a hit. The C# game uses 22 textures (11 lanes ×
{forward, reverse}); the web port honours the forward-scroll case
only — `bReverse.Drums` is wired into the renderer but the reverse
asset path is filed under future work.

### Per-lane asset map

| Lane code | Lane label | Forward asset                                          |
|-----------|------------|--------------------------------------------------------|
| LC        | left crash | `ScreenPlayDrums lane flush leftcymbal.png`            |
| HH        | hi-hat     | `ScreenPlayDrums lane flush hihat.png`                 |
| LP        | left pedal | `ScreenPlayDrums lane flush leftpedal.png`             |
| SD        | snare      | `ScreenPlayDrums lane flush snare.png`                 |
| HT        | hi tom     | `ScreenPlayDrums lane flush hitom.png`                 |
| BD        | bass       | `ScreenPlayDrums lane flush bass.png`                  |
| LT        | low tom    | `ScreenPlayDrums lane flush lowtom.png`                |
| FT        | floor tom  | `ScreenPlayDrums lane flush floortom.png`              |
| CY        | crash      | `ScreenPlayDrums lane flush cymbal.png`                |
| RD        | ride       | `ScreenPlayDrums lane flush cymbal.png` (RD-specific texture not shipped) |

Pinned by `CActPerfDrumsLaneFlushD.cs` lines 63-72 (note that line
72 spells RD as `ridecymbal` in the bundled skin).

### Sprite shape

42 × 128 per cell, 3 frames laid out horizontally (`k = 0..2`). The
streak repeats horizontally to fill the lane width: in C#
`for (int n = 0; n < w; n += 42)`. The animation frame index
advances at a configured rate so the streak shimmers as it falls.

### Motion

C# computes the y-position from a per-lane progress counter
(`ct進行[j]`, 0..100):
    y_forward = 700 − (counter × 740 / 100)
    y_reverse = 32  + (counter × 740 / 100)

Web-port reformulation: keyed on `lastPadHitMs[lane]` from the
existing renderer, the streak lives 500 ms; its y at age `t` ms
since the hit is:
    progress = t / 500            (0..1, clamped)
    y = 720 − progress × 740       // streak rides up + off-screen

This matches the C# fall-off shape (counter ramping up means the
streak is moving — y decreasing while counter increases on the
forward path).

### Opacity

C# sets the texture's `nTransparency` to the y-position (line 417),
making the streak fade as it climbs. Web-port mirrors that with
`alpha = 1 − progress` so the streak fades from full intensity at
the judgement line down to 0 at the top of the canvas.

### Frame cycle

The 3 animation frames cycle every ~16 ms (≈60 fps). Pure model
helper: `flushFrameIndex(elapsedMs)` returns 0..2.

## Web-port deviations (intentional)

1. **Forward scroll only** — `bReverse.Drums` not honoured yet. The
   reverse asset names are listed in the design doc above for the
   eventual port.
2. **No tom shifts for `eLaneType.B/C/D`** — `CActPerfDrumsLaneFlushD`
   re-positions HT / LT / FT / cymbals horizontally based on the
   chosen lane layout type. The web port locks to type A for now.
3. **`ridecymbal` / `cymbal` swap on `eRDPosition.RDRC`** — also
   omitted; the web port renders both at their default x.
