# Song Select — design spec

The canonical layout for the song-select scene, sourced from the C#
DTXMania reference (`DTXMania/Code/Stage/05.SongSelection/`). This file
exists to stop the web port from drifting away from the original game
the way the previous `vr-menu` / `song-wheel` pair did. When you
change layout, update this file; when you write a new panel, read this
file first.

## Frame

- **Logical canvas:** 1280 × 720 px. Every coordinate below is on this
  grid. The canvas may be drawn at any physical size (CSS pixel ratio,
  Three.js texture upload, VR plane); the painter scales to fit, the
  layout numbers do not change.
- **Background:** `5_background.jpg` underlay at (0, 0). If a chart
  declares a background AVI, it replaces the static jpeg in the same
  rect.
- **Header / footer chrome:** `5_header panel.png` slides in from the
  top during stage entry (y = `−h + h × sin(π/2 × progress)`);
  `5_footer panel.png` is static at the bottom. Both are decorative.

## Wheel — `CActSelectSongList`

- **Bar count:** 13 visible. Focus row is fixed at index 5 (counted
  from top), placing it slightly above the vertical centre.
- **Per-row anchor (x, y) for the left edge of the bar texture:**
  ```
  row  0:  (708,   5)
  row  1:  (626,  56)
  row  2:  (578, 107)
  row  3:  (546, 158)
  row  4:  (528, 209)
  row  5:  (464, 270)   ← focus
  row  6:  (548, 362)
  row  7:  (578, 413)
  row  8:  (624, 464)
  row  9:  (686, 515)
  row 10:  (788, 566)
  row 11:  (996, 617)
  row 12:  (1280, 668)
  ```
  The x-curve is the visual signature of DTXmania's wheel — bars away
  from the focus drift right and shrink off-screen, focus pops left.
  **Do not flatten this into a vertical column.**

- **Bar textures by node type** (`EBarType`):
  | Type     | Idle texture                    | Focused texture                 |
  |----------|---------------------------------|---------------------------------|
  | Score    | `5_bar score.png`               | `5_bar score selected.png`      |
  | Box      | `5_bar box.png`                 | `5_bar box selected.png`        |
  | Other    | `5_bar other.png`               | `5_bar other selected.png`      |
  ("Other" covers BACKBOX, RANDOM, and the non-Score/Box synthetic
  rows.)

- **Title text:** drawn ~55 px right of the bar's left edge, centred
  vertically inside the bar. Generated at 2× and downscaled in the
  horizontal axis (variable scale ratio) so long titles compress
  rather than truncate.

- **Per-row decorations:**
  - Clear lamp column (drum/guitar/bass), 7 × 41 px each, painted on
    the right side of the bar; instrument selector on the player's
    bound part picks which lamp shows.
  - Preview thumbnail (44 × 44, centred in a frame) on the focus row
    only.
  - Skill value on the focus row (currently hidden in the web port —
    add when status-panel skill % display is wired).

## Status panel — `CActSelectStatusPanel`

- **Origin:** (130, 350). Body texture: `5_status panel.png`.
- **Difficulty grid:** 5 difficulty rows × 3 instruments (Drums,
  Guitar, Bass). Frame texture: `5_difficulty frame.png`. Cell
  geometry inside the frame:
  - Y-baseline of difficulty `i` (0..4): `391 + (4 − i) × 60 − 2`,
    i.e. row 4 (Master) sits at the top, row 0 (Basic) at the bottom.
  - Per-cell content:
    - **Level** (decimal `0.00`), bottom-right corner of the cell.
      Glyphs from `5_level number.png`.
    - **Rank icon** (35 × 50), top-left at cell+(7, 5).
    - **Skill % gauge + numeric**, mid-right. Gauge from
      `5_skill number on gauge etc.png`.
- **BPM block:** label texture `5_BPM.png` at (32, 258); numeric BPM
  drawn at (42, 278) using `5_bpm font.png`.
- **Skill point summary:** top-right of the panel at (32, 180); large
  font for current drum/guitar/bass SP.
- **Bottom graph panels:** `5_graph panel drums.png` / `5_graph panel
  guitar bass.png` at (15, 368), 252 px tall, with per-lane bars
  (9 lanes drums, 6 lanes guitar/bass).

## Preimage / premovie — `CActSelectPreimagePanel`

- **Position:** (8, 57) when status panel is hidden, (250, 34) when
  shown. Size: 368 × 368 (or 292 × 292 in the compact layout).
- **Source priority:** `#PREMOVIE` AVI → `#PREIMAGE` PNG → cropped
  background → `5_preimage default.png` (or
  `5_preimage backbox.png` / `5_preimage random.png` for synthetic
  rows).
- **Animation:** configurable initial wait, then a 100-frame fade-in.
  Opacity multiplier `0.9 + 0.1 × (counter / 100)` so the panel never
  drops below 90 % once started.
- **Backing texture:** `5_preimage panel.png` frames the image.

## Artist + comment — `CActSelectArtistComment`

- **Artist name:** right-aligned at `(1260 − 25 − textWidth, 320)`, 40
  px MS PGothic, scaled 0.5× horizontally to hold long names.
- **Comment bar background:** `5_comment bar.png` at (560, 257).
- **Comment text:** drawn at (683, 339), clipped to a 750-px-wide
  rect, scaled 0.5× horizontally. If the rendered width exceeds 750,
  scrolls horizontally at 10 px/frame in an infinite loop.

## Performance history — `CActSelectPerfHistoryPanel`

- **Position:** x = 700 with status panel, x = 210 without. Y = 570.
- Up to 5 lines, 36 px row height, scaled 0.5× horizontally, drawn in
  yellow.

## Scrollbar — `CActSelectShowCurrentPosition`

- **Track:** x = 1306, y = 120, 12 × 492 px. Texture
  `5_scrollbar.png`.
- **Thumb:** 12 × 12 px, y = 120 + scrollOffset. The track has its
  own slide-down entrance animation tied to the same counter as the
  header panel.

## Animation summary

| Element              | Trigger                | Curve / rate            |
|----------------------|------------------------|-------------------------|
| Wheel scroll         | focus change           | per-frame interpolation, default `nアニメ間隔 = 2` |
| Status panel entry   | scene activation       | 100-frame counter, ~0.5 s |
| Preimage fade-in     | new focus ID           | 100-frame fade, opacity 0.9 → 1.0 |
| Comment scroll       | focused song change    | 10 px/frame, looped |
| Header panel         | scene activation       | sine-eased slide-down |
| Preview audio        | focus dwell            | configurable wait + BGM crossfade |

## Web-port deviations (intentional)

1. **Difficulty grid** is rendered with `[WIP]` overlays on cells
   whose data isn't yet routed (skill %, gauge bars). Geometry must
   still be canonical so the eventual fill drops in cleanly.
2. **Comment field** is not yet wired but the bar background and
   clipping rect must exist in the right place.
3. **Performance history** is currently shown as an empty 5-line
   stub.
4. **VR floating panel** uses the same 1280×720 canvas as the desktop
   render — the C# game targets a single-resolution skin and we
   inherit that. The Three.js plane is sized so the panel reads at
   roughly the same arc-minutes as the desktop view at 2 m.

When closing one of these deviations, remove the `[WIP]` line and
update the table above.
