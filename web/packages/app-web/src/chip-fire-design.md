# Chip-fire — design spec

The burst that pops at the judgement line whenever a chip is struck.
Sourced from `DTXMania/Code/Stage/07.Performance/DrumsScreen/CActPerfDrumsChipFireD.cs`.

The C# class draws four overlapping effect families on each hit:
fire (`tx火花[lane]`), blue stars (`tx青い星`), wave / ripple
(`tx大波` / `tx細波`), and scattered chip pieces (`txNotes`). The web
port ships the *fire* family first — that's the dominant visual
cue and a single-PNG-per-lane asset map. Stars / waves / scatter
are scoped out for a follow-up.

## Frame

- **Logical canvas:** 1280 × 720 px.
- **Trigger:** `RenderState.lastPadHitMs[lane]` ticking forward —
  same edge that drives `playfield-canvas`'s lane flush.
- **Position:** centred on the lane's `(spec.x + spec.width / 2,
  judgeLineY)`. The C# code radiates the fire outward via
  `(Cos(theta) × r, Sin(theta) × r)` per particle when the
  "explosion" config flag is on; the web port sticks the burst at
  the judgement line for now (cleaner read on a 2D canvas).

## Per-lane fire asset map

Pinned to lines 391-436 of `CActPerfDrumsChipFireD.cs`:

| Lane | Asset                                          |
|------|------------------------------------------------|
| LC   | `ScreenPlayDrums chip fire_LC.png`             |
| HH   | `ScreenPlayDrums chip fire_HH.png`             |
| LP   | `ScreenPlayDrums chip fire_LP.png`             |
| SD   | `ScreenPlayDrums chip fire_SD.png`             |
| HT   | `ScreenPlayDrums chip fire_HT.png`             |
| BD   | `ScreenPlayDrums chip fire_BD.png`             |
| LT   | `ScreenPlayDrums chip fire_LT.png`             |
| FT   | `ScreenPlayDrums chip fire_FT.png`             |
| CY   | `ScreenPlayDrums chip fire_CY.png`             |
| RD   | `ScreenPlayDrums chip fire_RD.png` *(missing in pack — falls back to CY)* |

Bonus burst: `ScreenPlayDrums chip fire_Bonus.png` is drawn on top
of the per-lane fire during chorus sections (C# line 721-722). The
web port ignores the chorus flag for now and never draws Bonus.

## Sprite geometry

Each per-lane PNG is 128 × 128 — a single static frame, not a
sprite sheet. The C# game animates by *spawning the same sprite
every frame at slightly offset positions* (radial fan); the web
port uses one sprite per hit and fades it out over the lifetime to
get the same "puff and disperse" feel cheaply.

## Composite mode (load-bearing)

The PNGs are authored as **black-background sprites** — corner
pixels sample as `(0, 0, 0, alpha=192-255)`, not transparent. C#
flags this texture family with `bAdditiveBlending = true`
(`CActPerfDrumsChipFireD.cs:510`); the web port mirrors that with
`globalCompositeOperation = 'lighter'`. Plain `source-over` would
paint visible black squares around every burst (the corner RGB is
opaque black) — visible as the "黑底" regression in the second CF
Pages preview before the revert.

This is **not** an alpha-channel bug in the source asset — it's
the canonical authoring convention: additive-blend sprites can
encode "no contribution" as RGB=(0,0,0) regardless of alpha.

## Animation

C# defaults: `nExplosionFrames = 70`, `nExplosionInterval = 3 ms`
⇒ **210 ms total**. Web port matches.

| Phase     | Window           | Visual transform                             |
|-----------|------------------|----------------------------------------------|
| Burst     | 0..210 ms        | scale 1.0 → 1.4 (linear)                     |
| Fade      | 0..210 ms        | alpha 1.0 → 0 (linear, same window)          |
| Done      | t ≥ 210 ms       | sprite skipped                                |

The fade is intentionally co-terminal with the scale so the burst
reads as one envelope instead of a separate "pop then fade" beat.

## Web-port deviations (intentional)

1. **No radial particle fan.** C# multiplies the matrix by
   `Translation(Cos×r, Sin×r, 0)` per frame so the sprite
   trajectories form an explosion. The web port draws the sprite
   in place; the motion comes from the scale-up alone.
2. **No bonus fire / blue star / wave / chip scatter.** Each is
   its own asset family in C# — `txボーナス花火`, `tx青い星`,
   `tx大波`, `tx細波`, `txNotes`. They land in a follow-up commit.
3. **No tom shifts for `eLaneType.B/C/D`** or `eRDPosition.RDRC`.
   Web port locks to type A — same scope as `playfield-canvas`.
4. **RD shares CY's asset** — the bundled skin has no
   `chip fire_RD.png`. Same gap as the lane-flush ridecymbal asset.
