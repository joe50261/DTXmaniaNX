/**
 * Config-canvas — paints the canonical 4_x.png chrome of the
 * config screen. Mirrors `DTXMania/Code/Stage/04.Config/CStageConfig`
 * lines 190-274 + `CActConfigList` 2478-2483.
 *
 * Same shared-painter pattern as the rest of the 04 / 07 / 08
 * sub-canvases. The host owns the 2D context; this class owns
 * asset preload + draw logic.
 *
 * Scope: paints the static frame only — background + header +
 * footer + menu-panel + item-bar + description-panel. The
 * interactive content (menu items, hit-tracked buttons, typed
 * inputs) stays in `vr-config.ts` (VR) / `config-panel.ts` (DOM)
 * for now; both can call `paintFrame()` to gain the canonical
 * skin without changing their interaction model.
 */

import { skinUrl } from './skin-url.js';
import {
  CONFIG_ASSETS,
  CONFIG_ASSET_FILES,
  CONFIG_CANVAS_H,
  CONFIG_CANVAS_W,
  CURSOR_BRACKET_H,
  CURSOR_BRACKET_W,
  DESCRIPTION_PANEL_X,
  DESCRIPTION_PANEL_Y,
  FOOTER_H,
  FOOTER_W,
  FOOTER_X,
  FOOTER_Y,
  HEADER_H,
  HEADER_W,
  HEADER_X,
  HEADER_Y,
  ITEM_BAR_X,
  ITEM_BAR_Y,
  MENU_PANEL_X,
  MENU_PANEL_Y,
  type ConfigAssetKey,
} from './config-layout.js';

export interface ConfigPaintOptions {
  /** Skip the background paint when the host is layering chrome
   *  on top of an existing background (e.g. vr-config's procedural
   *  panel that already has a coloured base). */
  skipBackground?: boolean;
  /** Skip the description-panel paint when the host doesn't have
   *  contextual text to show in that region. */
  skipDescriptionPanel?: boolean;
}

export interface CursorPaintRequest {
  /** Top-left x of the cursor bracket pair. */
  x: number;
  /** Top-left y of the cursor bracket. */
  y: number;
  /** Width of the menu row the cursor wraps. The right bracket is
   *  drawn at `x + w - bracketWidth` so it tracks the row's right
   *  edge regardless of menu width. */
  w: number;
}

export class ConfigCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();

  async load(): Promise<void> {
    await Promise.all(CONFIG_ASSET_FILES.map((n) => this.loadOne(n)));
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.assets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[config] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getByKey(key: ConfigAssetKey): HTMLImageElement | null {
    const name = CONFIG_ASSETS[key];
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * Paint the static frame: background → item-bar → menu-panel →
   * description-panel → header → footer. Order mirrors the C#
   * `OnUpdateAndDraw` sequence so callers can rely on the frame
   * looking identical to the desktop game.
   */
  paintFrame(ctx: CanvasRenderingContext2D, opts: ConfigPaintOptions = {}): void {
    if (!opts.skipBackground) this.paintBackground(ctx);
    this.paintItemBar(ctx);
    this.paintMenuPanel(ctx);
    if (!opts.skipDescriptionPanel) this.paintDescriptionPanel(ctx);
    this.paintHeader(ctx);
    this.paintFooter(ctx);
  }

  /**
   * Paint background + header + footer + side rail scaled to a
   * custom canvas width / height. The canonical `paintFrame()`
   * assumes the 1280×720 grid; this helper exists for hosts whose
   * canvas is a different aspect ratio (notably the VR config
   * panel at 1024×1260) but who still want the canonical chrome.
   *
   *   - `4_background.png` stretched edge-to-edge under everything
   *     so the panel reads as the original DTXMania config screen
   *     even when the user's VR view doesn't catch the header /
   *     footer strips at the top / bottom edges.
   *   - `4_header panel.png` width-scaled at top.
   *   - `4_footer panel.png` width-scaled at bottom.
   *   - `4_item bar.png` scaled to canvas height as a left-edge
   *     vertical rail (canonical x = 400 on the desktop grid → 39%
   *     of canvas width on any aspect).
   */
  paintHeaderFooter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const bg = this.getByKey('background');
    const header = this.getByKey('header');
    const footer = this.getByKey('footer');

    // Background first — stretched across the full canvas at low
    // alpha so the canonical DTXMania ambient palette tints the
    // panel without washing out the toggles / sliders. Skipped if
    // the asset is missing.
    if (bg) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(bg, 0, 0, w, h);
      ctx.restore();
    }
    if (header) {
      const scaledH = Math.round(HEADER_H * (w / HEADER_W));
      ctx.drawImage(header, 0, 0, w, scaledH);
    }
    if (footer) {
      const scaledH = Math.round(FOOTER_H * (w / FOOTER_W));
      ctx.drawImage(footer, 0, h - scaledH, w, scaledH);
    }
    // 4_item bar.png is intentionally skipped here — its canonical
    // x = 400 on the 1280-wide desktop grid would cut through the
    // vr-config section labels at 39% of a 1024-wide panel. Wire
    // it back in once vr-config grows a column-aware layout.
  }

  /**
   * Paint a menu cursor pair (left + right bracket) around a row.
   * The C# code re-uses the same source sprite twice with two
   * sub-rects; we honour that exactly.
   */
  paintCursor(ctx: CanvasRenderingContext2D, req: CursorPaintRequest): void {
    const tex = this.getByKey('menuCursor');
    if (!tex) {
      // Fallback: two thin yellow brackets so the selected row is
      // still visible without the skin.
      ctx.save();
      ctx.fillStyle = '#fde047';
      ctx.fillRect(req.x, req.y, 4, CURSOR_BRACKET_H);
      ctx.fillRect(req.x + req.w - 4, req.y, 4, CURSOR_BRACKET_H);
      ctx.restore();
      return;
    }
    // Left bracket — atlas (0, 0, 16, 25). Right bracket — atlas (16, 0, 16, 25).
    ctx.drawImage(
      tex,
      0, 0, CURSOR_BRACKET_W, CURSOR_BRACKET_H,
      req.x, req.y, CURSOR_BRACKET_W, CURSOR_BRACKET_H
    );
    ctx.drawImage(
      tex,
      CURSOR_BRACKET_W, 0, CURSOR_BRACKET_W, CURSOR_BRACKET_H,
      req.x + req.w - CURSOR_BRACKET_W, req.y, CURSOR_BRACKET_W, CURSOR_BRACKET_H
    );
  }

  // --- Frame elements ---------------------------------------------------

  private paintBackground(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('background');
    if (tex) {
      ctx.drawImage(tex, 0, 0, CONFIG_CANVAS_W, CONFIG_CANVAS_H);
      return;
    }
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, CONFIG_CANVAS_W, CONFIG_CANVAS_H);
  }

  private paintItemBar(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('itemBar');
    if (tex) {
      ctx.drawImage(tex, ITEM_BAR_X, ITEM_BAR_Y);
    }
    // No fallback — item bar is decorative; absence is fine.
  }

  private paintMenuPanel(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('menuPanel');
    if (tex) {
      ctx.drawImage(tex, MENU_PANEL_X, MENU_PANEL_Y);
    } else {
      // Fallback: subtle slate rect so the panel region still
      // contrasts with the background.
      ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';
      ctx.fillRect(MENU_PANEL_X, MENU_PANEL_Y, 180, 172);
    }
  }

  private paintDescriptionPanel(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('descriptionPanel');
    if (tex) {
      ctx.drawImage(tex, DESCRIPTION_PANEL_X, DESCRIPTION_PANEL_Y);
    }
  }

  private paintHeader(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('header');
    if (tex) {
      ctx.drawImage(tex, HEADER_X, HEADER_Y, HEADER_W, HEADER_H);
      return;
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(HEADER_X, HEADER_Y, HEADER_W, HEADER_H);
  }

  private paintFooter(ctx: CanvasRenderingContext2D): void {
    const tex = this.getByKey('footer');
    if (tex) {
      ctx.drawImage(tex, FOOTER_X, FOOTER_Y, FOOTER_W, FOOTER_H);
      return;
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(FOOTER_X, FOOTER_Y, FOOTER_W, FOOTER_H);
  }
}
