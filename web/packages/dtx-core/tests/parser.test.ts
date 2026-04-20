import { describe, it, expect } from 'vitest';
import { parseDtx } from '../src/parser/parser.js';
import { Channel } from '../src/model/channel.js';

describe('parseDtx', () => {
  it('parses metadata', () => {
    const dtx = [
      '#TITLE Test Song',
      '#ARTIST Some Artist',
      '#GENRE Rock',
      '#BPM 145',
      '#DLEVEL 550',
    ].join('\n');

    const song = parseDtx(dtx);
    expect(song.title).toBe('Test Song');
    expect(song.artist).toBe('Some Artist');
    expect(song.genre).toBe('Rock');
    expect(song.baseBpm).toBe(145);
    expect(song.drumLevel).toBe(550);
  });

  it('parses WAV definitions with volume and pan', () => {
    const dtx = [
      '#WAV01 kick.wav',
      '#WAVVOL01 80',
      '#WAVPAN01 -20',
      '#WAV02 snare.wav',
      '#VOLUME02 90',
      '#PAN02 10',
    ].join('\n');

    const song = parseDtx(dtx);
    expect(song.wavTable.get(1)).toMatchObject({ path: 'kick.wav', volume: 80, pan: -20 });
    expect(song.wavTable.get(2)).toMatchObject({ path: 'snare.wav', volume: 90, pan: 10 });
  });

  it('parses BPM table', () => {
    const dtx = ['#BPM01 145', '#BPM02 90.5'].join('\n');
    const song = parseDtx(dtx);
    expect(song.bpmTable.get(1)).toBe(145);
    expect(song.bpmTable.get(2)).toBe(90.5);
  });

  it('parses chip line with four slots of snare', () => {
    // Snare (0x12) at four equal positions (each 1/4 of the measure).
    const dtx = ['#BPM 120', '#WAV01 s.wav', '#00012:01010101'].join('\n');
    const song = parseDtx(dtx);

    const snare = song.chips.filter((c) => c.channel === Channel.Snare);
    expect(snare).toHaveLength(4);
    expect(snare.map((c) => c.tick)).toEqual([0, 96, 192, 288]);
    expect(snare.every((c) => c.wavId === 1)).toBe(true);
  });

  it('skips 00 slots', () => {
    const dtx = ['#00013:00010002'].join('\n');
    const song = parseDtx(dtx);
    const bd = song.chips.filter((c) => c.channel === Channel.BassDrum);
    expect(bd).toHaveLength(2);
    expect(bd.map((c) => c.tick).sort((a, b) => a - b)).toEqual([96, 288]);
    expect(bd.map((c) => c.wavId).sort()).toEqual([1, 2]);
  });

  it('parses BPMChangeExtended chips (channel 0x08)', () => {
    const dtx = ['#BPM 120', '#BPM01 180', '#00108:01000000'].join('\n');
    const song = parseDtx(dtx);
    const bpmChips = song.chips.filter((c) => c.channel === Channel.BPMChangeExtended);
    expect(bpmChips).toHaveLength(1);
    expect(bpmChips[0]?.bpmId).toBe(1);
    expect(bpmChips[0]?.measure).toBe(1);
  });

  it('ignores comments and blank lines', () => {
    const dtx = [
      '; a comment',
      '',
      '#TITLE Foo   ; inline',
      '  ',
    ].join('\n');
    const song = parseDtx(dtx);
    expect(song.title).toBe('Foo');
  });

  it('strips UTF-8 BOM', () => {
    const dtx = '\uFEFF#TITLE BomSong';
    const song = parseDtx(dtx);
    expect(song.title).toBe('BomSong');
  });
});
