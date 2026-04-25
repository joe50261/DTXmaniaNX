import { describe, it, expect } from 'vitest';
import { buildSkinUrl } from './skin-url.js';

describe('buildSkinUrl', () => {
  it('joins root base with skin path', () => {
    expect(buildSkinUrl('/', '5_background.jpg')).toBe('/skin/5_background.jpg');
  });

  it('joins project-site base with skin path', () => {
    expect(buildSkinUrl('/DTXmaniaNX/', '5_background.jpg')).toBe(
      '/DTXmaniaNX/skin/5_background.jpg'
    );
  });

  it('appends a missing trailing slash on the base', () => {
    expect(buildSkinUrl('/DTXmaniaNX', '5_BPM.png')).toBe('/DTXmaniaNX/skin/5_BPM.png');
  });

  it('preserves spaces in the filename (DTXMania assets keep them)', () => {
    expect(buildSkinUrl('/', 'ScreenPlay judge strings 1.png')).toBe(
      '/skin/ScreenPlay judge strings 1.png'
    );
  });
});
