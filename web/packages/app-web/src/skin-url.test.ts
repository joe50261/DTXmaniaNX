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

  it('URL-encodes spaces in the filename (DTXMania assets keep them; raw spaces break the URL constructor + service-worker Request matching)', () => {
    expect(buildSkinUrl('/', 'ScreenPlay judge strings 1.png')).toBe(
      '/skin/ScreenPlay%20judge%20strings%201.png'
    );
  });

  it('encodes other reserved characters in filenames', () => {
    // Defensive — DTXmania doesn't ship filenames with `?` / `#` today,
    // but the encoder should cover them so a future skin doesn't break
    // silently.
    expect(buildSkinUrl('/', 'odd?name#x.png')).toBe('/skin/odd%3Fname%23x.png');
  });
});
