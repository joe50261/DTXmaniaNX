# Combo-HUD — design spec

The in-play HUD elements that aren't lane-flush, chip-fire, or
result. Sourced from:

- `DTXMania/Code/Stage/07.Performance/CActPerfCommonCombo.cs`
- `DTXMania/Code/Stage/07.Performance/CActPerfCommonDanger.cs`

This first pass covers the **combo number** sprite (replacing the
fillText-based combo display the renderer ships today) and the
**danger overlay** (the full-screen red flash when the gauge is
critically low). Wailing bonus / fillin / bonus 100 are deferred.

## Frame

- **Logical canvas:** 1280 × 720 px.
- **Combo trigger:** `RenderState.combo` ticks > 0.
- **Danger trigger:** `RenderState.gauge` ≤ `DANGER_THRESHOLD`
  (default 0.3).

## Combo number — `CActPerfCommonCombo.tDrawCombo_Drums`

### Asset

- **Filename:** `ScreenPlayDrums combo.png` (600 × 380).
- **Atlas layout** (pinned by `CActPerfCommonCombo` constants
  `nドラムコンボの幅 = 120`, `nドラムコンボの高さ = 160`):
    - Digits 0-4: row 0, x = `digit × 120`, y = 0
    - Digits 5-9: row 1, x = `(digit − 5) × 120`, y = 160
    - "COMBO" label: full-width strip at y = 320, height 60,
      width 250 (drawn from x=0 in the source).

### Position

C# centre: `(nX中央位置px, nY上辺位置px)` chosen by the host —
DTXMania exposes `ドラムコンボ文字の表示位置` (top / side / off) so the
combo never has to sit in the middle of the chip stream. The
web port pins it to the **right of the playfield** (RD lane right
edge sits at x ≈ 839) at half scale so the canonical sprite reads
without crowding chips.

```
combo centre x        = 1040       // right gutter, between playfield + canvas right edge
combo digit centre y  = judgeLineY − 160
COMBO label centre y  = judgeLineY − 40
render scale          = 0.5        // 120×160 source → 60×80 rendered
```

**Why not centre?** The first preview pass anchored the combo at
`x = 640` (canvas centre) at full scale — the digits dropped right
on top of the chip stream and blocked falling notes. Original DTXMania
never paints the combo over the playfield centre; this matches that
canonical layout.

### Layout

Digits are drawn from least-significant rightwards toward most-
significant leftwards, walking left from the centre x. The
"COMBO" label sits below the digits.

- **No jump / bounce animation** — the C# code modulates y by
  `nジャンプ差分値[]` per digit on milestones; web port keeps the
  digits static so VR users don't get a wobble at high BPMs.

### Size

The combo number is large by default (digit 120×160 → 4-digit
combo is 480×160 px in source). The web port renders 1:1 and lets
the canvas downscale when the device pixel ratio is low; same
read at the standard 1280×720 logical canvas as in C#.

### Cap

Combos > 999 use a smaller asset (`ScreenPlayDrums combo_2.png`)
in C#. The web port caps the digit count at 4 and shows "999+"
once combo ≥ 1000 — keeps the layout deterministic.

## Danger overlay — `CActPerfCommonDanger`

### Asset

- **Filename:** `7_Danger.png` (1280 × 720, full-screen vignette).

### Trigger

Gauge ≤ 0.3 (`DANGER_THRESHOLD`). The renderer already exposes
`gauge` on `RenderState`.

### Animation

Full-screen alpha that pulses sinusoidally at 4 Hz so the player
notices but it doesn't strobe. Web-port formula:
    alpha_base = (DANGER_THRESHOLD − gauge) / DANGER_THRESHOLD   // 0..1
    alpha_pulse = 0.5 + 0.5 × sin(2π × 4 Hz × t)                 // 0..1
    final = clamp(alpha_base × 0.6 + alpha_pulse × 0.2, 0, 0.7)

### Z order

Painted after the chip-fire bursts but before judgement / combo so
the overlay tints the playfield without obscuring the score
readout.

## Web-port deviations (intentional)

1. **No combo bounce / jump.** Skipped for VR comfort.
2. **No combo_2.png path.** Combos ≥ 1000 render as "999+" rather
   than swap to the smaller digit atlas.
3. **No wailing / fillin / bonus 100.** These need new
   `RenderState` fields (wailing strike, fillin trigger, bonus
   accumulator) that aren't wired through `Game` yet — filed under
   future work.
4. **Danger overlay is procedural** (sin pulse on a tinted rect)
   when `7_Danger.png` is missing — same fallback rule as every
   other sub-canvas.
