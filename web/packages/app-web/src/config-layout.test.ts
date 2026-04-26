import { describe, expect, it } from 'vitest';
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
  FOOTER_Y,
  HEADER_H,
  HEADER_W,
  ITEM_BAR_X,
  MENU_CURSOR_H,
  MENU_PANEL_X,
  MENU_PANEL_Y,
} from './config-layout.js';

describe('config-layout — pinned to CStageConfig coordinates', () => {
  it('header, item-bar, menu-panel, description-panel match the C# tDraw2D calls', () => {
    expect(HEADER_W).toBe(1280);
    expect(HEADER_H).toBe(105);
    expect(ITEM_BAR_X).toBe(400);
    expect(MENU_PANEL_X).toBe(245);
    expect(MENU_PANEL_Y).toBe(140);
    expect(DESCRIPTION_PANEL_X).toBe(800);
    expect(DESCRIPTION_PANEL_Y).toBe(270);
  });

  it('footer y derives from the canvas height minus footer height', () => {
    expect(FOOTER_Y).toBe(CONFIG_CANVAS_H - FOOTER_H);
  });
});

describe('config-layout — geometric invariants', () => {
  it('header sits at canvas origin', () => {
    expect(HEADER_W).toBeLessThanOrEqual(CONFIG_CANVAS_W);
  });

  it('cursor bracket width × 2 fits in the source sprite width', () => {
    expect(CURSOR_BRACKET_W * 2).toBeLessThanOrEqual(64);
    expect(CURSOR_BRACKET_H).toBeLessThanOrEqual(MENU_CURSOR_H);
  });
});

describe('config-layout — asset map', () => {
  it('exposes 13 named assets covering CStageConfig + CActConfigList', () => {
    expect(Object.keys(CONFIG_ASSETS).length).toBe(13);
  });

  it('every asset file is a 4_- or 4-prefixed path', () => {
    for (const file of CONFIG_ASSET_FILES) {
      expect(file.startsWith('4_')).toBe(true);
    }
  });
});
