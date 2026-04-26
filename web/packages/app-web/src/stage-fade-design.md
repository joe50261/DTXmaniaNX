# Stage-fade — design spec

The 64×64 tile-based fade-in / fade-out used at every scene
transition in DTXMania. Sourced from
`DTXMania/Code/Stage/CActFIFOBlack.cs` and the symmetric
`CActFIFOWhite` / `CActFIFOBlackStart` / `CActFIFOWhiteClear`
classes.

The C# implementation also has a 31-frame
`Runtime/System/Graphics/StageEffect/7_StageEffect_*.png` family
referenced in `CActPerfAVI.cs`, but the line that loads it is
commented out (line 394) — the bundled game never paints those
frames. Listed here for completeness; not shipped.

## Frame

- **Logical canvas:** 1280 × 720 px.
- **Tile size:** 64 × 64. The tile fills the canvas as a 20 × 12 grid
  with 8 px of overhang on the right edge (1280 / 64 = 20 exactly,
  720 / 64 ≈ 11.25 — rounds up to 12 rows).
- **Trigger:** scene-state machine starting / ending a transition.
  The host calls `start()` with a mode + nowMs and `paint()`s every
  frame until `isDone()` flips true.

## Modes

| Mode      | Source asset                | Direction              |
|-----------|-----------------------------|------------------------|
| `fade-in-black`   | `Tile black 64x64.png`  | alpha 1.0 → 0     |
| `fade-out-black`  | `Tile black 64x64.png`  | alpha 0 → 1.0     |
| `fade-in-white`   | `Tile white 64x64.png`  | alpha 1.0 → 0     |
| `fade-out-white`  | `Tile white 64x64.png`  | alpha 0 → 1.0     |

Mirrors `CActFIFOBlack` (fade-out-black + fade-in-black) and
`CActFIFOWhite` (fade-out-white + fade-in-white).

## Animation

C# default: counter 0..100 step 5 = 20 ticks × 16 ms ≈ 320 ms total.
Web port matches with `FADE_DURATION_MS = 320`.

| Mode             | Alpha formula                     |
|------------------|-----------------------------------|
| `fade-in-*`      | `(100 - counter) / 100`           |
| `fade-out-*`     | `counter / 100`                   |

Reformulated for the web port against `elapsedMs`:
    progress = clamp(elapsedMs / FADE_DURATION_MS, 0, 1)
    fade-in:  alpha = 1 - progress
    fade-out: alpha = progress

## Web-port deviations (intentional)

1. **Tile fill, not pure rect.** C# tiles a 64×64 sprite even
   though the visual reads identically to a flat rect. The web port
   keeps the tile path because some skins customise the tile (e.g.
   a logo dot pattern); falling back to a flat rect would lose that
   skin variation.
2. **Single-shot only.** `tフェードイン完了()` (instant complete)
   isn't exposed yet — the host should re-`start()` if it needs an
   abrupt reset.
3. **No StageEffect_*.png frames.** The 31-frame family stays out
   of the build pipeline; the C# code path that consumed it is
   commented out, so we'd just be shipping unused bytes.
