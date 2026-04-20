import { describe, it, expect } from 'vitest';
import { parseSetDef, SET_DEF_DEFAULT_LABELS } from '../src/scanner/setdef.js';

describe('parseSetDef', () => {
  it('parses a single block with all 5 difficulties', () => {
    const txt = [
      '#TITLE My Song',
      '#L1FILE nov.dtx',
      '#L2FILE reg.dtx',
      '#L3FILE exp.dtx',
      '#L4FILE mas.dtx',
      '#L5FILE dtx.dtx',
    ].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.title).toBe('My Song');
    expect(blocks[0]?.files).toEqual(['nov.dtx', 'reg.dtx', 'exp.dtx', 'mas.dtx', 'dtx.dtx']);
    expect(blocks[0]?.labels).toEqual(Array.from(SET_DEF_DEFAULT_LABELS));
  });

  it('parses multiple blocks separated by #TITLE', () => {
    const txt = [
      '#TITLE A',
      '#L1FILE a.dtx',
      '#TITLE B',
      '#L1FILE b.dtx',
    ].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.title).toBe('A');
    expect(blocks[1]?.title).toBe('B');
  });

  it('respects custom labels', () => {
    const txt = ['#TITLE Foo', '#L1LABEL EASY', '#L1FILE foo.dtx'].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks[0]?.labels[0]).toBe('EASY');
  });

  it('drops labels that have no file', () => {
    const txt = [
      '#TITLE Foo',
      '#L1LABEL NOVICE',  // no file -> label dropped
      '#L2LABEL REGULAR',
      '#L2FILE reg.dtx',
    ].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks[0]?.labels[0]).toBeNull();
    expect(blocks[0]?.labels[1]).toBe('REGULAR');
    expect(blocks[0]?.files[1]).toBe('reg.dtx');
  });

  it('skips comments and blank lines', () => {
    const txt = [
      '; comment',
      '',
      '#TITLE Foo   ; trailing',
      '#L1FILE foo.dtx',
    ].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks[0]?.title).toBe('Foo');
  });

  it('accepts colon-separated syntax', () => {
    const txt = ['#TITLE: Colon Syntax', '#L1FILE: foo.dtx'].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks[0]?.title).toBe('Colon Syntax');
    expect(blocks[0]?.files[0]).toBe('foo.dtx');
  });

  it('parses FONTCOLOR', () => {
    const txt = ['#TITLE Foo', '#FONTCOLOR FF0000', '#L1FILE foo.dtx'].join('\n');
    const blocks = parseSetDef(txt);
    expect(blocks[0]?.fontColor).toBe('#FF0000');
  });
});
