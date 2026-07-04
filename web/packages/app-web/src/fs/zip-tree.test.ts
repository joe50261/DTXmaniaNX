import { describe, expect, it } from 'vitest';
import {
  hasZipExt,
  listZipChildren,
  normalizeZipPath,
  splitZipPath,
  zipEntryExists,
  type ZipMember,
} from './zip-tree.js';

describe('normalizeZipPath', () => {
  it('strips slashes and collapses repeats', () => {
    expect(normalizeZipPath('/song//adv.dtx/')).toBe('song/adv.dtx');
    expect(normalizeZipPath('a\\b')).toBe('a/b');
    expect(normalizeZipPath('')).toBe('');
    expect(normalizeZipPath('/')).toBe('');
  });
});

describe('splitZipPath', () => {
  it('splits at the first .zip segment', () => {
    expect(splitZipPath('pack.zip')).toEqual({ zipPath: 'pack.zip', innerPath: '' });
    expect(splitZipPath('pack.zip/song/adv.dtx')).toEqual({
      zipPath: 'pack.zip',
      innerPath: 'song/adv.dtx',
    });
    expect(splitZipPath('a/b/pack.ZIP/x.dtx')).toEqual({
      zipPath: 'a/b/pack.ZIP',
      innerPath: 'x.dtx',
    });
  });

  it('returns null when no segment is a .zip', () => {
    expect(splitZipPath('songs/plain/adv.dtx')).toBeNull();
    expect(splitZipPath('')).toBeNull();
  });
});

describe('hasZipExt', () => {
  it('is case-insensitive', () => {
    expect(hasZipExt('Pack.ZIP')).toBe(true);
    expect(hasZipExt('pack.zip')).toBe(true);
    expect(hasZipExt('pack.dtx')).toBe(false);
  });
});

describe('listZipChildren', () => {
  const members: ZipMember[] = [
    { name: 'box.def', isDirectory: false },
    { name: 'song-a/set.def', isDirectory: false },
    { name: 'song-a/bas.dtx', isDirectory: false },
    { name: 'song-b/set.def', isDirectory: false },
  ];

  it('lists immediate children and synthesises implied directories', () => {
    const root = listZipChildren(members, '').sort((a, b) => a.name.localeCompare(b.name));
    expect(root).toEqual([
      { name: 'box.def', isDirectory: false },
      { name: 'song-a', isDirectory: true },
      { name: 'song-b', isDirectory: true },
    ]);

    const inner = listZipChildren(members, 'song-a').sort((a, b) => a.name.localeCompare(b.name));
    expect(inner).toEqual([
      { name: 'bas.dtx', isDirectory: false },
      { name: 'set.def', isDirectory: false },
    ]);
  });

  it('honours an explicit directory member', () => {
    const withDir: ZipMember[] = [
      { name: 'song', isDirectory: true },
      { name: 'song/adv.dtx', isDirectory: false },
    ];
    expect(listZipChildren(withDir, '')).toEqual([{ name: 'song', isDirectory: true }]);
  });
});

describe('zipEntryExists', () => {
  const members: ZipMember[] = [{ name: 'song/adv.dtx', isDirectory: false }];

  it('matches files, implied directories, and the root', () => {
    expect(zipEntryExists(members, '')).toBe(true);
    expect(zipEntryExists(members, 'song')).toBe(true); // implied dir
    expect(zipEntryExists(members, 'song/adv.dtx')).toBe(true);
    expect(zipEntryExists(members, 'song/missing.dtx')).toBe(false);
    expect(zipEntryExists(members, 'nope')).toBe(false);
  });
});
