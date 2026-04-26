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

    // Digits centred on COMBO_CENTRE_X. Walk left-to-right starting
    // at (centre − digits.length/2 × W) so the rendered string lines
    // up regardless of count. Reverse iterate digits since they're
    // ones-first.
    const totalW = digits.length * COMBO_DIGIT_W;
    const startX = COMBO_CENTRE_X - totalW / 2;
    const digitsY = input.judgeLineY + COMBO_DIGITS_OFFSET_Y - COMBO_DIGIT_H / 2;

    ctx.save();
    for (let i = digits.length - 1; i >= 0; i--) {
      const digit = digits[i]!;
      const dx = startX + (digits.length - 1 - i) * COMBO_DIGIT_W;
      ctx.drawImage(
        tex,
        comboDigitAtlasX(digit), comboDigitAtlasY(digit),
        COMBO_DIGIT_W, COMBO_DIGIT_H,
        dx, digitsY, COMBO_DIGIT_W, COMBO_DIGIT_H
      );
    }

    if (overflow) {
      // Overflow tag — small "+" rendered with text since the atlas
      // has no '+' glyph slot.
      ctx.fillStyle = '#fde047';
      ctx.font = 'bold 64px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', startX + totalW + 8, digitsY + COMBO_DIGIT_H / 2);
    }

    // COMBO label — full atlas strip pulled from y=320, drawn under
    // the digits.
    const labelX = COMBO_CENTRE_X - COMBO_LABEL_W / 2;
    const labelY = input.judgeLineY + COMBO_LABEL_OFFSET_Y - COMBO_LABEL_H / 2;
    ctx.drawImage(
      tex,
      0, COMBO_LABEL_ATLAS_Y, COMBO_LABEL_W, COMBO_LABEL_H,
      labelX, labelY, COMBO_LABEL_W, COMBO_LABEL_H
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
