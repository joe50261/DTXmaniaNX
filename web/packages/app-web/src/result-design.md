# Result — design spec

The canonical layout for the result scene, sourced from the C#
DTXMania reference (`DTXMania/Code/Stage/08.Result/`). Mirrors the
song-select doc style so the web port stays pinned to the desktop
game's pixel positions.

## Frame

- **Logical canvas:** 1280 × 720 px. Same as song-select; coordinates
  below are on this grid regardless of the physical render size.
- **Background:** `8_background.jpg` at (0, 0). DTXMania optionally
  swaps in `8_background rank{SS,S,A,B,C,D,E}.png` if present in the
  user skin, but the bundled assets only ship the base jpg, so the
  web port draws just that.

## Rank text — `CActResultRank`

- **Asset family:** `8_rank{SS,S,A,B,C,D,E}.png`. One of seven, picked
  by the player's letter grade.
- **Drum-only origin:** (480, 0). `CActResultRank.OnActivate`
  (lines 36-58) sets `n本体X[0] = 480, n本体Y[0] = 0` when drums are
  the only enabled instrument — which matches the web port's
  drum-first scope.
- **Reveal animation:** `ctランク表示` is a counter 0 → 500 (1 ms
  granularity). The image is hidden until counter ≥ 200; from there
  to 500 the visible slice fades down from the top:
    progress = (counter − 200) / 300                  // 0 → 1
    drawY    = baseY + texHeight × (1 − progress)
    clipH    = texHeight × progress
  i.e. a slot-machine drop-in. Once `counter == 500` the image sits
  flush at `baseY`.
- **Counter freeze:** `OnUpdateAndDraw` returns 1 only after the
  counter reaches its end — that's how `CStageResult` decides the
  scene is "done animating" and is safe to dismiss.

## Banner — `CActResultRank` (cont.)

- **Asset:** one of `ScreenResult Excellent.png`, `ScreenResult
  fullcombo.png`, `ScreenResult StageCleared.png`. Picked in this
  priority:
  1. `Excellent`     — every chip was PERFECT.
  2. `fullcombo`     — no MISS / POOR.
  3. `StageCleared`  — finished without bailing.
- **Position (drums):** `(rankX − 165, rankY + 100)` → (315, 100).
  Matches `CActResultRank.OnUpdateAndDraw` lines 193-194.
- **Animation:** none — it pops in at full opacity once the rank
  counter starts (no separate gate; if the rank slice is visible,
  the banner is drawn underneath).

## Score & metrics — `CActResultParameterPanel`

DTXMania paints these on top of `7_SkillPanel.png` per-instrument
panels at varying x; the web port omits the skill-panel chrome (no
guitar/bass yet) and lays the metrics out as a centred column
underneath the rank banner.

- **Numeric font:** `8_numbers_large.png` is a **142×112** atlas
  with two layouts stacked vertically:
  - **Normal mode** (top half, y ∈ [0, 48)) — 18 × 24 cells in a
    5-col × 2-row grid: digits 0..4 at row 0, 5..9 at row 1; `'%'`
    at (90, 0) and `'.'` at (90, 24).
  - **Extra-large mode** (bottom half, y ∈ [48, 112)) — 24 × 32
    cells offset by `(num, num2)` per glyph (C# `bExtraLarge=true`
    branch in `CActResultParameterPanel.cs:830-861`). Used by
    DTXMania for the SCORE display only.

  The web port uses the **normal mode** for every metric (score,
  rate, max combo, judgement counts) so the layout reads
  consistently. Mapping pinned by `digitAtlas()` in `result-layout.ts`.
- **Web layout (centred column, x-centre = 640):**
    SCORE     y = 470   28-px digits, 7-wide right-aligned
    RATE      y = 510   28-px digits + '%' suffix, 5-wide
    MAXCOMBO  y = 550   28-px digits, 4-wide
- **Judgement counts:** five rows on the left half:
    PERFECT  y = 470  x = 280
    GREAT    y = 510  x = 280
    GOOD     y = 550  x = 280
    POOR     y = 590  x = 280
    MISS     y = 630  x = 280
  Numbers right-aligned at x = 520 with the same `8_numbers_large`
  glyphs.

## New record badge — `CActResultParameterPanel` (cont.)

- **Asset:** `8_New Record.png`.
- **Position:** (220, 160) — first slot of `ptFullCombo位置` per
  `CActResultParameterPanel` line 215. Hidden if the run did not
  beat the best stored score.
- **Animation:** none (static draw in C#).

## Progress bar panel — `CActResultParameterPanel` (cont.)

- **Asset:** `8_progress_bar_panel.png`.
- **Use:** behind the per-judgement bar visualisation. The web port
  paints the panel chrome at (260, 460) and fills five horizontal
  bars (one per judgement) inside it, scaled by count / totalNotes.
- **Web-port deviation:** the C# game draws the bars as 1-px
  vertical stripes; the web port uses solid horizontal bars for
  legibility on lower-DPI screens.

## Footer hint

- **Text:** `Press Enter / squeeze to continue`. Painted at
  (640, 700), centre-aligned, 14 px MS PGothic-ish (the canonical
  font is `Screen font dfp.png` but the web port falls back to the
  CSS sans-serif when that asset is missing — see
  `result-canvas.ts`).
- **Hidden in VR**: shown as `Press squeeze to continue` instead.
  Mirrored from the existing `RenderState.inXR` flag; no separate
  asset needed.

## Animation summary

| Element        | Trigger        | Curve / duration                |
|----------------|----------------|---------------------------------|
| Rank reveal    | scene entry    | counter 200..500 (300 ms slot drop) |
| Banner         | rank ≥ 200     | no animation, full opacity       |
| Score / counts | scene entry    | no animation, drawn from frame 0 |
| New Record     | record beaten  | no animation, drawn from frame 0 |

## Web-port deviations (intentional)

1. **Drums-only**. The C# game draws three rank towers (drums /
   guitar / bass) at (480/300/720, ±15). The web port keeps only the
   drums tower at (480, 0); guitar / bass arrive when the playfield
   refactor lands.
2. **No skill-panel chrome**. `7_SkillPanel.png` is omitted. Score /
   counts sit on a flat-coloured strip painted procedurally so the
   layout still reads when the asset is absent.
3. **Rank-tinted background variants** (`8_background rankSS.png`
   etc.) are not shipped with the upstream asset pack, so the port
   only ships the plain `8_background.jpg`.
