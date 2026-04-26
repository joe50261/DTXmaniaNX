/**
 * Result-screen canvas painter. Mirrors `DTXMania/Code/Stage/08.Result/`
 * (`CActResultRank`, `CActResultParameterPanel`) on the web port's
 * 1280 × 720 logical canvas — see `result-design.md`.
 *
 * Architecture: this class does not own a canvas. The host (`Renderer`)
 * passes its 2D context to `paint()` so the result paints on top of
 * the same HUD surface the playfield uses. That surface is the texture
 * source for both the desktop ortho quad and the VR floating panel,
 * so canvas-2D draws here are visible in both views by construction.
 *
 * Asset loading mirrors `song-select-canvas.loadSkinAssets`: a fixed
 * names list + `Promise.all` of resolve-on-error loaders so a single
 * 404 doesn't cascade. Each `paintX` checks for the asset and falls
 * back to a procedural draw, matching the existing renderer style.
 */

import type { JudgmentKind, Rank } from '@dtxmania/dtx-core';
import { skinUrl } from './skin-url.js';
import {
  rankAnimationDone,
  rankClip,
  rankReveal,
} from './result-animations.js';
import {
  BANNER_X,
  BANNER_Y,
  digitAtlasX,
  FOOTER_HINT_X,
  FOOTER_HINT_Y,
  JUDGE_LABEL_X,
  JUDGE_NUMBER_RIGHT_X,
  JUDGE_ROW_COUNT,
  JUDGE_TOP_Y,
  judgeRowY,
  LARGE_DIGIT_ATLAS_Y,
  LARGE_DIGIT_H,
  LARGE_DIGIT_W,
  MAXCOMBO_Y,
  METRICS_RIGHT_X,
  NEW_RECORD_X,
  NEW_RECORD_Y,
  RANK_X,
  RANK_Y,
  RATE_Y,
  RESULT_CANVAS_H,
  RESULT_CANVAS_W,
  SCORE_Y,
} from './result-layout.js';

/** Per-rank asset filename. Mirrors the switch in
 *  `CActResultRank.OnManagedCreateResources` (lines 113-149). */
const RANK_ASSET: Record<Rank, string> = {
  SS: '8_rankSS.png',
  S:  '8_rankS.png',
  A:  '8_rankA.png',
  B:  '8_rankB.png',
  C:  '8_rankC.png',
  D:  '8_rankD.png',
  E:  '8_rankE.png',
};

const ASSET_BACKGROUND   = '8_background.jpg';
const ASSET_NEW_RECORD   = '8_New Record.png';
const ASSET_NUMBERS      = '8_numbers_large.png';
const ASSET_PROGRESS_BAR = '8_progress_bar_panel.png';
const ASSET_BANNER_EXC   = 'ScreenResult Excellent.png';
const ASSET_BANNER_FC    = 'ScreenResult fullcombo.png';
const ASSET_BANNER_CLEAR = 'ScreenResult StageCleared.png';

const ASSET_NAMES: readonly string[] = [
  ASSET_BACKGROUND,
  ASSET_NEW_RECORD,
  ASSET_NUMBERS,
  ASSET_PROGRESS_BAR,
  ASSET_BANNER_EXC,
  ASSET_BANNER_FC,
  ASSET_BANNER_CLEAR,
  ...Object.values(RANK_ASSET),
];

/** Subset of `RenderState` the result canvas needs. Kept narrow so
 *  the model -> view interface is explicit. */
export interface ResultRenderInput {
  rank: Rank;
  excellent: boolean;
  fullCombo: boolean;
  score: number;
  achievementRate: number;
  maxCombo: number;
  totalNotes: number;
  counts: Record<JudgmentKind, number>;
  /** Title of the played chart, drawn small under the rank. */
  titleLine: string;
  /** Whether to show the new-record badge. The Game owns the
   *  best-score check and toggles this flag when a new high is set. */
  newRecord: boolean;
  /** True inside an immersive WebXR session — swaps the footer hint. */
  inXR: boolean;
}

export class ResultCanvas {
  private readonly skinAssets = new Map<string, HTMLImageElement>();
  /** Performance-now() timestamp at which the result scene started.
   *  Set by `start()`, drives the rank reveal counter. */
  private startedAtMs: number | null = null;

  /**
   * Kick off the asset preload. Returns a promise that resolves once
   * every asset has loaded or errored — same contract as
   * `SongSelectCanvas.loadSkinAssets`. Safe to call multiple times;
   * subsequent calls are cheap because the browser cache covers them.
   */
  async load(): Promise<void> {
    await Promise.all(ASSET_NAMES.map((name) => this.loadOne(name)));
  }

  private loadOne(name: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.skinAssets.set(name, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[result] skin asset missing:', name);
        resolve();
      };
      img.src = skinUrl(name);
    });
  }

  private getAsset(name: string): HTMLImageElement | null {
    const img = this.skinAssets.get(name);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * Call once when entering the result scene so the rank reveal
   * counter is anchored to the right `performance.now()` value.
   * Re-entering the scene from a fresh play resets the animation.
   */
  start(nowMs: number): void {
    this.startedAtMs = nowMs;
  }

  /** Whether the rank reveal counter has finished. The host uses
   *  this to decide whether `result-dismissed` events are honoured. */
  isAnimationComplete(nowMs: number): boolean {
    if (this.startedAtMs === null) return false;
    return rankAnimationDone(nowMs - this.startedAtMs);
  }

  paint(ctx: CanvasRenderingContext2D, state: ResultRenderInput, nowMs: number): void {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    const elapsed = nowMs - this.startedAtMs;

    this.paintBackground(ctx);
    this.paintBanner(ctx, state);
    this.paintRank(ctx, state, elapsed);
    this.paintTitle(ctx, state);
    this.paintScoreAndRate(ctx, state);
    this.paintJudgeCounts(ctx, state);
    this.paintNewRecord(ctx, state);
    this.paintProgressBar(ctx, state);
    this.paintFooterHint(ctx, state, elapsed);
  }

  private paintBackground(ctx: CanvasRenderingContext2D): void {
    const bg = this.getAsset(ASSET_BACKGROUND);
    if (bg) {
      ctx.drawImage(bg, 0, 0, RESULT_CANVAS_W, RESULT_CANVAS_H);
      return;
    }
    // Procedural fallback — keep the result legible if 8_background.jpg
    // is missing from the build (e.g. a stripped skin).
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, RESULT_CANVAS_W, RESULT_CANVAS_H);
  }

  private paintRank(
    ctx: CanvasRenderingContext2D,
    state: ResultRenderInput,
    elapsedMs: number
  ): void {
    const tex = this.getAsset(RANK_ASSET[state.rank]);
    const reveal = rankReveal(elapsedMs);

    if (!tex) {
      // Procedural fallback: giant rank letter once the reveal would
      // have completed. Mirrors the previous in-renderer drawResult.
      if (!reveal.hidden) {
        ctx.save();
        ctx.globalAlpha = reveal.progress;
        ctx.fillStyle = rankFallbackColor(state.rank);
        ctx.font = 'bold 220px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(state.rank, RANK_X + 160, RANK_Y + 20);
        ctx.restore();
      }
      return;
    }

    if (reveal.hidden) return;
    const clip = rankClip(RANK_Y, tex.height, reveal.progress);
    if (clip.clipH <= 0) return;
    ctx.drawImage(
      tex,
      0, 0, tex.width, clip.clipH,
      RANK_X, clip.drawY, tex.width, clip.clipH
    );
  }

  private paintBanner(ctx: CanvasRenderingContext2D, state: ResultRenderInput): void {
    // Priority order matches CActResultRank.OnUpdateAndDraw 196-210:
    // Excellent (all PERFECT) > FullCombo (no MISS/POOR) > StageCleared.
    const name = state.excellent
      ? ASSET_BANNER_EXC
      : state.fullCombo
        ? ASSET_BANNER_FC
        : ASSET_BANNER_CLEAR;
    const tex = this.getAsset(name);
    if (tex) {
      ctx.drawImage(tex, BANNER_X, BANNER_Y);
      return;
    }
    // Fallback: big text label.
    const text = state.excellent
      ? 'EXCELLENT'
      : state.fullCombo
        ? 'FULL COMBO'
        : 'STAGE CLEARED';
    ctx.save();
    ctx.fillStyle = state.excellent ? '#fde047' : state.fullCombo ? '#fbbf24' : '#94a3b8';
    ctx.font = 'bold 36px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, BANNER_X, BANNER_Y);
    ctx.restore();
  }

  private paintTitle(ctx: CanvasRenderingContext2D, state: ResultRenderInput): void {
    if (!state.titleLine) return;
    ctx.save();
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const truncated =
      state.titleLine.length > 80
        ? state.titleLine.slice(0, 79) + '…'
        : state.titleLine;
    ctx.fillText(truncated, RESULT_CANVAS_W / 2, 440);
    ctx.restore();
  }

  private paintScoreAndRate(
    ctx: CanvasRenderingContext2D,
    state: ResultRenderInput
  ): void {
    this.paintNumberRightAligned(ctx, state.score.toString().padStart(7, '0'), METRICS_RIGHT_X, SCORE_Y);
    const rateText = state.totalNotes === 0 ? '---' : state.achievementRate.toFixed(2) + '%';
    this.paintNumberRightAligned(ctx, rateText, METRICS_RIGHT_X, RATE_Y);
    this.paintNumberRightAligned(ctx, state.maxCombo.toString(), METRICS_RIGHT_X, MAXCOMBO_Y);

    // Labels (text — no canonical label sprite ships with the game's
    // base skin for these rows). Drawn left of the numbers.
    ctx.save();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('SCORE',     METRICS_RIGHT_X - LARGE_DIGIT_W * 9,  SCORE_Y    + LARGE_DIGIT_H / 2);
    ctx.fillText('RATE',      METRICS_RIGHT_X - LARGE_DIGIT_W * 9,  RATE_Y     + LARGE_DIGIT_H / 2);
    ctx.fillText('MAX COMBO', METRICS_RIGHT_X - LARGE_DIGIT_W * 9,  MAXCOMBO_Y + LARGE_DIGIT_H / 2);
    ctx.restore();
  }

  private paintJudgeCounts(
    ctx: CanvasRenderingContext2D,
    state: ResultRenderInput
  ): void {
    const rows: { label: string; key: JudgmentKind; color: string }[] = [
      { label: 'PERFECT', key: 'PERFECT', color: '#7dd3fc' },
      { label: 'GREAT',   key: 'GREAT',   color: '#4ade80' },
      { label: 'GOOD',    key: 'GOOD',    color: '#fbbf24' },
      { label: 'POOR',    key: 'POOR',    color: '#f472b6' },
      { label: 'MISS',    key: 'MISS',    color: '#ef4444' },
    ];
    ctx.save();
    ctx.font = '20px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < JUDGE_ROW_COUNT; i++) {
      const row = rows[i]!;
      const y = judgeRowY(i);
      ctx.fillStyle = row.color;
      ctx.textAlign = 'left';
      ctx.fillText(row.label, JUDGE_LABEL_X, y + LARGE_DIGIT_H / 2);
      this.paintNumberRightAligned(
        ctx,
        state.counts[row.key].toString(),
        JUDGE_NUMBER_RIGHT_X,
        y
      );
    }
    ctx.restore();
  }

  private paintNumberRightAligned(
    ctx: CanvasRenderingContext2D,
    text: string,
    rightX: number,
    y: number
  ): void {
    const sprite = this.getAsset(ASSET_NUMBERS);
    if (sprite) {
      // Walk right-to-left so we don't have to pre-compute total
      // width (the strip is monospace at 28 px / glyph but '%' has
      // no slot — we measure by atlas hit/miss and fall back to a
      // CSS char on miss).
      let cursorX = rightX;
      for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i]!;
        const sx = digitAtlasX(ch);
        if (sx !== null) {
          cursorX -= LARGE_DIGIT_W;
          ctx.drawImage(
            sprite,
            sx, LARGE_DIGIT_ATLAS_Y, LARGE_DIGIT_W, LARGE_DIGIT_H,
            cursorX, y, LARGE_DIGIT_W, LARGE_DIGIT_H
          );
        } else {
          // '%', '.', '-', etc. — paint as text at the same monospace step.
          cursorX -= LARGE_DIGIT_W;
          ctx.save();
          ctx.fillStyle = '#e5e7eb';
          ctx.font = `bold ${LARGE_DIGIT_H}px ui-monospace, monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(ch, cursorX, y);
          ctx.restore();
        }
      }
      return;
    }
    // No sprite: pure text fallback.
    ctx.save();
    ctx.fillStyle = '#e5e7eb';
    ctx.font = `bold ${LARGE_DIGIT_H}px ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(text, rightX, y);
    ctx.restore();
  }

  private paintNewRecord(ctx: CanvasRenderingContext2D, state: ResultRenderInput): void {
    if (!state.newRecord) return;
    const tex = this.getAsset(ASSET_NEW_RECORD);
    if (tex) {
      ctx.drawImage(tex, NEW_RECORD_X, NEW_RECORD_Y);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#fde047';
    ctx.font = 'bold 28px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('NEW RECORD', NEW_RECORD_X, NEW_RECORD_Y);
    ctx.restore();
  }

  private paintProgressBar(
    ctx: CanvasRenderingContext2D,
    state: ResultRenderInput
  ): void {
    const tex = this.getAsset(ASSET_PROGRESS_BAR);
    if (!tex) return;
    // Decorative panel only — actual breakdown bars are out of scope
    // for this pass (see result-design.md "Progress bar panel").
    ctx.drawImage(tex, JUDGE_LABEL_X - 20, JUDGE_TOP_Y - 16);
  }

  private paintFooterHint(
    ctx: CanvasRenderingContext2D,
    state: ResultRenderInput,
    elapsedMs: number
  ): void {
    if (elapsedMs < 400) return; // matches the prior 400-ms fade-in
    ctx.save();
    ctx.fillStyle = '#6b7280';
    ctx.font = '16px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = state.inXR
      ? 'Squeeze controller to return (auto-return in 5s)'
      : 'Press Esc to return';
    ctx.fillText(text, FOOTER_HINT_X, FOOTER_HINT_Y);
    ctx.restore();
  }
}

function rankFallbackColor(rank: Rank): string {
  switch (rank) {
    case 'SS': return '#fde047';
    case 'S':  return '#fbbf24';
    case 'A':  return '#4ade80';
    case 'B':  return '#60a5fa';
    case 'C':  return '#a78bfa';
    case 'D':  return '#f472b6';
    case 'E':  return '#94a3b8';
  }
}

