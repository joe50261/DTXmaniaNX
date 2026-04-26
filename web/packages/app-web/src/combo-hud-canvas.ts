/**
 * Combo-HUD canvas — paints the combo number sprite + danger
 * overlay (07.Performance sub-cluster). Mirrors
 * `CActPerfCommonCombo.tDrawCombo_Drums` and
 * `CActPerfCommonDanger.OnUpdateAndDraw`.
 *
 * Same shared-painter pattern as `playfield-canvas.ts`: host owns
 * the 2D context; this class owns asset preload + draw logic.
 */

import { skinUrl } from './skin-url.js';
import {
  COMBO_CENTRE_X,
  COMBO_DIGITS_OFFSET_Y,
  COMBO_DIGIT_H,
  COMBO_DIGIT_W,
  COMBO_LABEL_ATLAS_Y,
  COMBO_LABEL_H,
  COMBO_LABEL_OFFSET_Y,
  COMBO_LABEL_W,
  COMBO_RENDER_SCALE,
  comboDigitAtlasX,
  comboDigitAtlasY,
  comboDigits,
  dangerAlpha,
  isComboOverflow,
} from './combo-hud-layout.js';

const ASSET_COMBO  = 'ScreenPlayDrums combo.png';
const ASSET_DANGER = '7_Danger.png';

export interface ComboHudRenderInput {
  combo: number;
  /** 0..1 life gauge — drives the danger overlay opacity. */
  gauge: number;
  /** Y of the judge line on the canvas. Combo + label centre on
   *  this row with the COMBO_*_OFFSET_Y constants. */
  judgeLineY: number;
  /** Logical canvas dimensions — danger overlay is full-screen. */
  canvasW: number;
  canvasH: number;
  /** Current performance.now() — animation clock for the danger pulse. */
  nowMs: number;
}

export class ComboHudCanvas {
  private readonly assets = new Map<string, HTMLImageElement>();

  async load(): Promise<void> {
    await Promise.all([this.loadOne(ASSET_COMBO), this.loadOne(ASSET_DANGER)]);
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.assets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[combo-hud] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.assets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  paint(ctx: CanvasRenderingContext2D, input: ComboHudRenderInput): void {
    this.paintDanger(ctx, input);
    this.paintCombo(ctx, input);
  }

  private paintDanger(
    ctx: CanvasRenderingContext2D,
    input: ComboHudRenderInput
  ): void {
    const alpha = dangerAlpha(input.gauge, input.nowMs);
    if (alpha <= 0) return;
    const tex = this.getAsset(ASSET_DANGER);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (tex) {
      ctx.drawImage(tex, 0, 0, input.canvasW, input.canvasH);
    } else {
      // Procedural fallback: red vignette so the danger state still
      // reads when 7_Danger.png is absent.
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(0, 0, input.canvasW, input.canvasH);
    }
    ctx.restore();
  }

  private paintCombo(
    ctx: CanvasRenderingContext2D,
    input: ComboHudRenderInput
  ): void {
    if (input.combo <= 0) return;
    const digits = comboDigits(input.combo);
    if (digits.length === 0) return;
    const tex = this.getAsset(ASSET_COMBO);
    const overflow = isComboOverflow(input.combo);

    if (!tex) {
      // Fallback: text combo + label.
      this.paintComboFallback(ctx, input, digits, overflow);
      return;
    }

    // Digits centred on COMBO_CENTRE_X. Source atlas glyphs are
    // 120x160; we render at COMBO_RENDER_SCALE so a 4-digit combo
    // fits in the right-side gutter without crowding the chip
    // stream. Walk left-to-right from (centre − totalRenderedW/2);
    // reverse-iterate `digits` since they're ones-first.
    const renderDigitW = COMBO_DIGIT_W * COMBO_RENDER_SCALE;
    const renderDigitH = COMBO_DIGIT_H * COMBO_RENDER_SCALE;
    const totalRenderedW = digits.length * renderDigitW;
    const startX = COMBO_CENTRE_X - totalRenderedW / 2;
    const digitsY = input.judgeLineY + COMBO_DIGITS_OFFSET_Y - renderDigitH / 2;

    ctx.save();
    for (let i = digits.length - 1; i >= 0; i--) {
      const digit = digits[i]!;
      const dx = startX + (digits.length - 1 - i) * renderDigitW;
      ctx.drawImage(
        tex,
        comboDigitAtlasX(digit), comboDigitAtlasY(digit),
        COMBO_DIGIT_W, COMBO_DIGIT_H,
        dx, digitsY, renderDigitW, renderDigitH
      );
    }

    if (overflow) {
      // Overflow tag — small "+" rendered with text since the atlas
      // has no '+' glyph slot. Sized to match the rendered digit height.
      ctx.fillStyle = '#fde047';
      ctx.font = `bold ${Math.round(renderDigitH / 2.5)}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', startX + totalRenderedW + 4, digitsY + renderDigitH / 2);
    }

    // COMBO label — full atlas strip pulled from y=320, drawn under
    // the digits at the same render scale.
    const renderLabelW = COMBO_LABEL_W * COMBO_RENDER_SCALE;
    const renderLabelH = COMBO_LABEL_H * COMBO_RENDER_SCALE;
    const labelX = COMBO_CENTRE_X - renderLabelW / 2;
    const labelY = input.judgeLineY + COMBO_LABEL_OFFSET_Y - renderLabelH / 2;
    ctx.drawImage(
      tex,
      0, COMBO_LABEL_ATLAS_Y, COMBO_LABEL_W, COMBO_LABEL_H,
      labelX, labelY, renderLabelW, renderLabelH
    );
    ctx.restore();
  }

  private paintComboFallback(
    ctx: CanvasRenderingContext2D,
    input: ComboHudRenderInput,
    digits: number[],
    overflow: boolean
  ): void {
    const text = digits.slice().reverse().join('') + (overflow ? '+' : '');
    ctx.save();
    ctx.fillStyle = '#fde047';
    ctx.font = 'bold 96px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, COMBO_CENTRE_X, input.judgeLineY + COMBO_DIGITS_OFFSET_Y);
    ctx.fillStyle = '#9ca3af';
    ctx.font = 'bold 28px ui-monospace, monospace';
    ctx.fillText('COMBO', COMBO_CENTRE_X, input.judgeLineY + COMBO_LABEL_OFFSET_Y);
    ctx.restore();
  }
}
