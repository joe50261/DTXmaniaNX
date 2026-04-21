import { describe, it, expect } from 'vitest';
import { parseBoxDef } from '../src/scanner/boxdef.js';

describe('parseBoxDef', () => {
  it('returns an empty object for an empty file', () => {
    expect(parseBoxDef('')).toEqual({});
  });

  it('parses the common directive set', () => {
    const text = [
      '#TITLE    Modern Jazz',
      '#ARTIST   Various',
      '#GENRE    Jazz',
      '#COMMENT  A selection of smooth tracks',
      '#FONTCOLOR #0099FF',
      '#PREIMAGE cover.png',
    ].join('\n');
    expect(parseBoxDef(text)).toEqual({
      title: 'Modern Jazz',
      artist: 'Various',
      genre: 'Jazz',
      comment: 'A selection of smooth tracks',
      fontColor: '#0099FF',
      preimage: 'cover.png',
    });
  });

  it('is case-insensitive on directive names', () => {
    const text = '#title Rock\n#FontColor #ff0000';
    expect(parseBoxDef(text)).toEqual({
      title: 'Rock',
      fontColor: '#ff0000',
    });
  });

  it('silently skips unknown directives and semicolon comments', () => {
    const text = [
      '; author: somebody',
      '#TITLE Real',
      '#SKINPATH custom',      // ignored
      '#DRUMPERFECTRANGE 34',  // ignored
    ].join('\n');
    expect(parseBoxDef(text)).toEqual({ title: 'Real' });
  });

  it('strips a UTF-8 BOM on the first line', () => {
    const text = '﻿#TITLE Beep';
    expect(parseBoxDef(text)).toEqual({ title: 'Beep' });
  });

  it('ignores lines without a value', () => {
    const text = '#TITLE \n#ARTIST ';
    expect(parseBoxDef(text)).toEqual({});
  });

  it('accepts COLOR as an alias for FONTCOLOR', () => {
    expect(parseBoxDef('#COLOR #123456')).toEqual({ fontColor: '#123456' });
  });
});
