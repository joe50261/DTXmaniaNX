# Playfield — design spec

The canonical layout for the in-play scene's lane chrome. Sourced
from the C# DTXMania reference under
`DTXMania/Code/Stage/07.Performance/DrumsScreen/`. This doc covers
the **lane-flush** overlay only — the 3D pad meshes and chip atlas
are already wired in `renderer.ts` and stay there for now (a
follow-up will move them into `playfield-canvas.ts` so the whole
playfield lives behind one entry point).

## Frame

- **Logical canvas:** 1280 × 720 px.
- **Lane geometry source:** `lane-layout.ts` — already pinned to the
  C# `CActPerfDrumsPad` x-table.

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
