/**
 * Config-screen layout constants. Pinned to
 * `DTXMania/Code/Stage/04.Config/CStageConfig.cs` (lines 190-274)
 * and `CActConfigList.cs` (lines 2478-2483). Pure data; no THREE,
 * no DOM.
 *
 * `config-canvas.ts` consumes these to paint the canonical 4_x.png
 * chrome. Both `vr-config.ts` (VR path) and a future skinned
 * `config-panel.ts` (DOM path) can use the same numbers via the
 * shared canvas.
 */

export const CONFIG_CANVAS_W = 1280;
export const CONFIG_CANVAS_H = 720;

// --- Backgrounds / chrome ----------------------------------------------

export const HEADER_X = 0;
export const HEADER_Y = 0;
export const HEADER_W = 1280;
export const HEADER_H = 105;

export const FOOTER_X = 0;
export const FOOTER_W = 1280;
export const FOOTER_H = 30;
/** Footer y is canvas height minus the asset height (the C# code
 *  uses `tDraw2D(0, 720 - txDecorationPanel.szTextureSize.Height)`). */
export const FOOTER_Y = CONFIG_CANVAS_H - FOOTER_H;

// --- Menu panel + item-bar --------------------------------------------

export const MENU_PANEL_X = 245;
export const MENU_PANEL_Y = 140;

export const ITEM_BAR_X = 400;
export const ITEM_BAR_Y = 0;

// --- Menu cursor (left + right bracket) -------------------------------

/** `4_menu cursor.png` source dimensions. */
export const MENU_CURSOR_W = 64;
export const MENU_CURSOR_H = 25;

/** Single bracket cell within the cursor sprite. C# `tDraw2D`
 *  passes `Rectangle(0, 0, 16, 32)` for the left bracket and
 *  `(16, 0, 16, 32)` for the right (lines 209-210); 32 height
 *  exceeds the sprite's actual 25 px so the C# code clips. We
 *  honour the canonical 16-wide sub-cell and use the actual
 *  sprite height. */
export const CURSOR_BRACKET_W = 16;
export const CURSOR_BRACKET_H = MENU_CURSOR_H;

// --- Description panel + arrows ---------------------------------------

export const DESCRIPTION_PANEL_X = 800;
export const DESCRIPTION_PANEL_Y = 270;

// --- Item-row chrome (CActConfigList) ---------------------------------

/** Asset filenames the canvas pre-loads. The host can override the
 *  set if a custom skin omits some entries; a missing asset
 *  triggers the per-paint fallback rather than blocking the load. */
export const CONFIG_ASSETS = {
  background: '4_background.png',
  header: '4_header panel.png',
  footer: '4_footer panel.png',
  menuCursor: '4_menu cursor.png',
  menuPanel: '4_menu panel.png',
  itemBar: '4_item bar.png',
  itemBoxNormal: '4_itembox.png',
  itemBoxOther: '4_itembox other.png',
  itemBoxCursor: '4_itembox cursor.png',
  triangleArrow: '4_triangle arrow.png',
  arrow: '4_Arrow.png',
  descriptionPanel: '4_Description Panel.png',
  hitKeyDialog: '4_hit key to assign dialog.png',
} as const;

export type ConfigAssetKey = keyof typeof CONFIG_ASSETS;

export const CONFIG_ASSET_FILES: readonly string[] = Object.values(CONFIG_ASSETS);
