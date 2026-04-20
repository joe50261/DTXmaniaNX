import type { Chip } from '@dtxmania/dtx-core';
import { LANE_LAYOUT, channelToLane, type LaneSpec } from './lane-layout.js';
import type { LaneValue } from '@dtxmania/input';

export const CANVAS_W = 1280;
export const CANVAS_H = 720;
export const JUDGE_LINE_Y = 600;
export const PX_PER_MS = 0.45;   // scroll speed (px per ms)
export const CHIP_H = 14;

export interface JudgmentFlash {
  text: string;
  color: string;
  lane: LaneValue;
  spawnedMs: number;
}

export interface HitFlash {
  lane: LaneValue;
  spawnedMs: number;
}

export interface RenderState {
  songTimeMs: number;
  chips: Chip[];
  combo: number;
  score: number;
  maxCombo: number;
  judgmentFlash: JudgmentFlash | null;
  hitFlashes: HitFlash[];
  status: 'idle' | 'playing' | 'finished';
  titleLine: string;
  songLengthMs: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2D context unavailable');
    this.ctx = c;
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    this.drawLanes(state);
    this.drawJudgmentLine();
    this.drawChips(state);
    this.drawHitFlashes(state);
    this.drawHUD(state);
    this.drawJudgmentFlash(state);
    ctx.restore();
  }

  private drawLanes(_state: RenderState): void {
    const ctx = this.ctx;
    for (const lane of LANE_LAYOUT) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(lane.x, 40, lane.width, JUDGE_LINE_Y - 40);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lane.x + 0.5, 40.5, lane.width - 1, JUDGE_LINE_Y - 40);

      ctx.fillStyle = lane.color;
      ctx.font = 'bold 14px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(lane.label, lane.x + lane.width / 2, 32);
    }
  }

  private drawJudgmentLine(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(LANE_LAYOUT[0]!.x, JUDGE_LINE_Y);
    const last = LANE_LAYOUT[LANE_LAYOUT.length - 1]!;
    ctx.lineTo(last.x + last.width, JUDGE_LINE_Y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawChips(state: RenderState): void {
    const ctx = this.ctx;
    const now = state.songTimeMs;
    for (const chip of state.chips) {
      const lane = channelToLane(chip.channel);
      if (!lane) continue;

      const y = JUDGE_LINE_Y - (chip.playbackTimeMs - now) * PX_PER_MS;
      if (y < -20 || y > CANVAS_H + 20) continue;

      // Already-passed chips fade out slightly
      const alpha = y > JUDGE_LINE_Y + 50 ? 0.2 : 1;
      this.fillChip(lane, y, alpha, chip);
    }
  }

  private fillChip(lane: LaneSpec, y: number, alpha: number, chip: Chip): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = lane.color;
    const pad = 4;
    ctx.fillRect(lane.x + pad, y - CHIP_H / 2, lane.width - pad * 2, CHIP_H);
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = alpha * 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(lane.x + pad + 0.5, y - CHIP_H / 2 + 0.5, lane.width - pad * 2 - 1, CHIP_H - 1);
    ctx.globalAlpha = 1;
    void chip;
  }

  private drawHitFlashes(state: RenderState): void {
    const ctx = this.ctx;
    for (const flash of state.hitFlashes) {
      const age = state.songTimeMs - flash.spawnedMs;
      const life = 200;
      if (age < 0 || age > life) continue;
      const alpha = 1 - age / life;
      const lane = LANE_LAYOUT.find((l) => l.lane === flash.lane);
      if (!lane) continue;
      ctx.globalAlpha = alpha * 0.8;
      const grad = ctx.createRadialGradient(
        lane.x + lane.width / 2, JUDGE_LINE_Y, 0,
        lane.x + lane.width / 2, JUDGE_LINE_Y, 60
      );
      grad.addColorStop(0, lane.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(lane.x - 20, JUDGE_LINE_Y - 60, lane.width + 40, 120);
      ctx.globalAlpha = 1;
    }
  }

  private drawHUD(state: RenderState): void {
    const ctx = this.ctx;

    ctx.fillStyle = '#aaa';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(state.titleLine, 20, 30);

    // Progress bar
    const progress = state.songLengthMs > 0
      ? Math.max(0, Math.min(1, state.songTimeMs / state.songLengthMs))
      : 0;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(20, 50, 200, 6);
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(20, 50, 200 * progress, 6);

    // Score
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(state.score.toString().padStart(7, '0'), CANVAS_W - 40, 80);

    // Combo
    ctx.fillStyle = state.combo >= 10 ? '#fbbf24' : '#9ca3af';
    ctx.font = 'bold 64px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      state.combo > 0 ? `${state.combo}` : '',
      CANVAS_W / 2,
      JUDGE_LINE_Y - 90
    );
    if (state.combo > 0) {
      ctx.fillStyle = '#6b7280';
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.fillText('COMBO', CANVAS_W / 2, JUDGE_LINE_Y - 60);
    }

    // Max combo bottom-right
    ctx.fillStyle = '#4b5563';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`MAX COMBO ${state.maxCombo}`, CANVAS_W - 20, CANVAS_H - 20);

    if (state.status === 'finished') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 64px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FINISHED', CANVAS_W / 2, CANVAS_H / 2 - 20);
      ctx.font = '22px ui-monospace, monospace';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(`Score ${state.score}  •  Max Combo ${state.maxCombo}`, CANVAS_W / 2, CANVAS_H / 2 + 20);
      ctx.fillText('Press Esc to restart', CANVAS_W / 2, CANVAS_H / 2 + 60);
    }
  }

  private drawJudgmentFlash(state: RenderState): void {
    if (!state.judgmentFlash) return;
    const ctx = this.ctx;
    const age = state.songTimeMs - state.judgmentFlash.spawnedMs;
    const life = 400;
    if (age < 0 || age > life) return;
    const lane = LANE_LAYOUT.find((l) => l.lane === state.judgmentFlash!.lane);
    if (!lane) return;
    const alpha = 1 - age / life;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = state.judgmentFlash.color;
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const y = JUDGE_LINE_Y + 36 - (age / life) * 20;
    ctx.fillText(state.judgmentFlash.text, lane.x + lane.width / 2, y);
    ctx.globalAlpha = 1;
  }
}
