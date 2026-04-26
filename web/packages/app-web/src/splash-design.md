# Splash — design spec

A single canvas painter that covers the four "background + optional
foreground glyph" scenes the C# game uses outside of song-select /
play / result:

| Scene         | Background           | Foreground       | C# stage           |
|---------------|----------------------|------------------|--------------------|
| `startup`     | `1_background.jpg`   | —                | `01.Startup`       |
| `title`       | `2_background.jpg`   | `2_menu.png`     | `02.Title`         |
| `loading`     | `6_background.jpg`   | `6_FadeOut.jpg`  | `06.SongLoading`   |
| `end`         | `9_background.jpg`   | —                | `09.End`           |

DTXMania paints these stages with `CStageStartup` / `CStageTitle` /
`CStageSongLoading` / `CStageEnd` — each is a thin wrapper that
fills the screen with one or two textures plus a fade timer. The
shared web-port helper folds them into one class so we don't end up
with four near-identical files.

## Frame

- **Logical canvas:** 1280 × 720, painted edge-to-edge.
- **Background:** drawn first, scaled to canvas size. If absent, a
  solid `#0b0f1a` falls in to keep the screen non-blank.
- **Foreground glyph:** drawn centred. Default sizing keeps the
  glyph's natural pixel dimensions (the bundled assets are already
  authored at the correct 1280×720-grid scale).

## Timings

| Scene     | Fade-in  | Hold     | Fade-out | Notes                          |
|-----------|----------|----------|----------|--------------------------------|
| startup   | 200 ms   | 1500 ms  | 400 ms   | DTXMania logo / boot           |
| title     | 300 ms   | ∞        | 0        | hold until user picks an entry |
| loading   | 0        | ∞        | 200 ms   | paint while files stream in    |
| end       | 0        | 800 ms   | 400 ms   | brief goodbye splash           |

Hold = ∞ means the scene state machine (`scene-state.ts`) is
responsible for the next transition; the splash canvas itself never
times out.

## Foreground positioning

- **`title` / `2_menu.png`**: centred on the canvas — the texture is
  authored so the menu items overlap the background's empty centre.
  Position computed as `((canvasW - texW) / 2, (canvasH - texH) / 2)`.
- **`loading` / `6_FadeOut.jpg`**: drawn with a per-frame alpha so it
  acts as a vignette over the background. Alpha grows linearly from
  0 to 1 across `fadeOut` ms once the scene's exit signal fires.

## Web-port deviations

1. **No menu navigation here.** When `title` is wired up, controller
   input goes to a *separate* menu module that draws on top of the
   splash canvas. Splash itself only paints the static glyph.
2. **No 3D camera changes.** Splash always paints onto the same
   1280×720 hud canvas, picked up by the desktop ortho quad and the
   VR floating panel without further plumbing.
3. **`6_FadeOut.jpg`** is reused as the loading vignette even though
   the C# game uses a separate `FadeOut.jpg`. They appear identical
   in the bundled skins; if a future skin diverges, plumb a
   per-scene `foreground` override into `splash-canvas.ts` (the
   constructor accepts arbitrary filenames already).
