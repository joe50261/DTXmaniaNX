# Config — design spec

The canonical layout for the config (key-bind / settings) scene,
sourced from `DTXMania/Code/Stage/04.Config/CStageConfig.cs` and
`CActConfigList.cs`. The web port currently ships two
implementations:

- **DOM modal** (`config-panel.ts`) — desktop-only, used because
  the modal hosts typed `<input>` elements (slider, checkbox,
  number) that genuinely need DOM (per `web/CLAUDE.md`).
- **VR canvas** (`vr-config.ts`) — paints a procedural panel at
  ~1024×1260 with hit-tracked toggle buttons.

This refactor adds a third piece — `config-canvas.ts` — which
paints the canonical 4_*.png chrome on top of either path. The
DOM modal can keep its typed inputs while gaining the original
game's visual frame; the VR canvas can replace its procedural
boxes with the same skinned chrome.

## Frame

- **Logical canvas:** 1280 × 720 px (matches every other 04 stage
  draw on the desktop).
- **Background:** `4_background.png` at (0, 0). Full-screen.
- **Header strip:** `4_header panel.png` at (0, 0). 1280 × 105.
- **Footer strip:** `4_footer panel.png` at (0, 720 − height).
  1280 × 30.

## Menu chrome — `CStageConfig.OnUpdateAndDraw` lines 199-237

| Element              | Asset                | Position             |
|----------------------|----------------------|----------------------|
| Item-bar (left rail) | `4_item bar.png`     | (400, 0)             |
| Menu panel           | `4_menu panel.png`   | (245, 140)           |
| Menu cursor (left)   | `4_menu cursor.png`  | (x, y), atlas (0,0,16,32) |
| Menu cursor (right)  | `4_menu cursor.png`  | (x+w−16, y), atlas (16,0,16,32) |
| Description panel    | `4_Description Panel.png` | (800, 270)     |

Cursor sprite (`4_menu cursor.png`) is 64 × 25 — split into two
halves: left bracket at atlas (0,0,16,32), right bracket at
(16,0,16,32). The remaining halves form a four-state animation
the C# code rotates per frame; the web port can pick any single
frame for now.

## Item box — `CActConfigList.cs`

| Element              | Asset                       | Used for                  |
|----------------------|-----------------------------|---------------------------|
| Item box (normal)    | `4_itembox.png`             | even rows                 |
| Item box (alt)       | `4_itembox other.png`       | odd rows                  |
| Item box cursor      | `4_itembox cursor.png`      | hover / selected highlight|
| Triangle arrow       | `4_triangle arrow.png`      | "has children" indicator  |
| Selection arrow      | `4_Arrow.png`               | left/right step indicator |

## Key-assign dialog — `CActConfigKeyAssign.cs` (out of scope)

- `4_hit key to assign dialog.png` — modal that pops while the
  player is mid-rebind. Web-port path uses the DOM modal; the
  asset stays in the allowlist for completeness so a future
  canvas-based key-assign flow can drop in.

## Migration note

The two existing config UIs each work fine for their target
device; we ship the chrome assets + the layout doc so a follow-up
can:

1. Wire `vr-config.ts` to draw `4_background.png` + `4_header panel.png`
   + `4_footer panel.png` underneath its procedural button rows
   (gives the VR view the original game's visual frame without
   changing the interaction model).
2. Mount `config-panel.ts`'s DOM modal inside an HTML element
   that uses `4_menu panel.png` as a CSS background, so the
   desktop view also reads as the canonical config screen.

Neither change is part of this refactor; the doc + layout module
+ asset allowlist are the prerequisites.

## Web-port deviations (intentional)

1. **Two UI paths kept.** Per `web/CLAUDE.md`, modals with typed
   inputs stay DOM. We don't fold the desktop and VR paths into
   one canvas-only renderer — that would lose IME / a11y for the
   typed numeric fields.
2. **Cursor animation simplified.** The C# game cycles four cursor
   frames per ~80 ms; the web port plans to pick the static
   frame at atlas y=0 to keep tests cheap.
