/**
 * SDF-based HUD text via troika-three-text.
 *
 * Why this exists: text baked into the HUD canvas becomes blurry on a
 * VR floating panel — the canvas is sampled, MSAA-resolved and
 * lens-distorted in sequence. A signed-distance-field mesh stays sharp
 * at any viewing distance / scale because the GPU evaluates the glyph
 * outline per-fragment.
 *
 * Wrapper, not abstraction: troika ships no types and pulls in workers
 * lazily; this file narrows the API surface we use and keeps the
 * `as unknown as` cast contained.
 */
import * as THREE from 'three';
// Troika ships no .d.ts; we cast through an interface that mirrors
// only the fields we touch.
import { Text as TroikaText } from 'troika-three-text';

interface TroikaTextLike extends THREE.Object3D {
  text: string;
  fontSize: number;
  color: number | string;
  anchorX: 'left' | 'center' | 'right' | number | string;
  anchorY: 'top' | 'middle' | 'bottom' | number | string;
  font: string | null;
  outlineWidth: number | string;
  outlineColor: number | string;
  material: THREE.Material & { opacity: number; transparent: boolean; depthTest: boolean; depthWrite: boolean };
  sync(callback?: () => void): void;
  dispose(): void;
}

const TextCtor = TroikaText as unknown as new () => TroikaTextLike;

export interface HudTextOptions {
  fontSize: number;
  color?: number | string;
  anchorX?: 'left' | 'center' | 'right';
  anchorY?: 'top' | 'middle' | 'bottom';
  outlineWidth?: number;
  outlineColor?: number | string;
  renderOrder?: number;
}

export class HudText {
  readonly object: THREE.Object3D;
  private readonly mesh: TroikaTextLike;
  private currentText = '';

  constructor(opts: HudTextOptions) {
    const t = new TextCtor();
    t.fontSize = opts.fontSize;
    t.color = opts.color ?? 0xffffff;
    t.anchorX = opts.anchorX ?? 'center';
    t.anchorY = opts.anchorY ?? 'middle';
    if (opts.outlineWidth !== undefined) t.outlineWidth = opts.outlineWidth;
    if (opts.outlineColor !== undefined) t.outlineColor = opts.outlineColor;
    t.material.transparent = true;
    t.material.depthTest = false;
    t.material.depthWrite = false;
    t.renderOrder = opts.renderOrder ?? 5;
    t.visible = false;
    this.mesh = t;
    this.object = t;
  }

  setText(text: string): void {
    if (text === this.currentText) return;
    this.currentText = text;
    this.mesh.text = text;
    this.mesh.sync();
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  setOpacity(opacity: number): void {
    this.mesh.material.opacity = opacity;
  }

  setColor(color: number | string): void {
    this.mesh.color = color;
  }

  setPosition(x: number, y: number, z = 2): void {
    this.mesh.position.set(x, y, z);
  }

  dispose(): void {
    this.mesh.dispose();
    this.object.parent?.remove(this.object);
  }
}
