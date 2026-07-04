/**
 * Pure path helpers that map an archive's flat entry list onto directory-tree
 * semantics for the zip-aware backend. This is *not* zip parsing (zip.js does
 * that) — it is the small virtual-filesystem glue that turns a list of member
 * names into "what are the immediate children of this folder" / "does this
 * path exist", including directories that only exist implicitly because a zip
 * omitted their explicit `dir/` entry.
 */

/** A minimal, library-agnostic view of one archive member. `name` is a
 * normalised forward-slash path with no trailing slash (even for directories —
 * the kind is carried by `isDirectory`). */
export interface ZipMember {
  name: string;
  isDirectory: boolean;
}

/** Strip leading/trailing slash runs and collapse repeats, so archive paths
 * compare identically regardless of how a member was stored. */
export function normalizeZipPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

/**
 * Split a POSIX path at its first `.zip` segment. Returns the archive path
 * (through and including the `.zip` segment) plus the remaining in-archive
 * path, or `null` when no segment is a `.zip`. First `.zip` wins, so a
 * (pathological) nested archive stays opaque bytes rather than a second
 * directory layer.
 */
export function splitZipPath(path: string): { zipPath: string; innerPath: string } | null {
  const segments = normalizeZipPath(path)
    .split('/')
    .filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    if (hasZipExt(segments[i]!)) {
      return {
        zipPath: segments.slice(0, i + 1).join('/'),
        innerPath: segments.slice(i + 1).join('/'),
      };
    }
  }
  return null;
}

export function hasZipExt(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

/**
 * Immediate children of `prefix` within the archive. Files come from members
 * whose remaining path has no slash; directories are synthesised from the
 * first segment of any deeper member (so a pack that stored only
 * `song/adv.dtx` still yields a `song` directory).
 */
export function listZipChildren(
  members: readonly ZipMember[],
  prefix: string
): ZipMember[] {
  const norm = normalizeZipPath(prefix);
  const full = norm === '' ? '' : norm + '/';
  const seen = new Map<string, boolean>(); // name -> isDirectory
  for (const member of members) {
    const raw = member.isDirectory ? member.name + '/' : member.name;
    if (!raw.startsWith(full)) continue;
    const rest = raw.slice(full.length);
    if (rest === '') continue; // the prefix directory itself
    const slash = rest.indexOf('/');
    if (slash === -1) {
      // Slash-less remainder: a direct file child (directory members always
      // carry a trailing slash, so they can't land here).
      if (!seen.has(rest)) seen.set(rest, false);
    } else {
      // Deeper member: its first segment is a child directory.
      seen.set(rest.slice(0, slash), true);
    }
  }
  return Array.from(seen, ([name, isDirectory]) => ({ name, isDirectory }));
}

/** True if `path` names a file, an explicit directory, or an implied
 * directory (a prefix of some member). "" (the archive root) always exists. */
export function zipEntryExists(members: readonly ZipMember[], path: string): boolean {
  const norm = normalizeZipPath(path);
  if (norm === '') return true;
  const asDir = norm + '/';
  for (const member of members) {
    if (member.name === norm) return true;
    if (member.name.startsWith(asDir)) return true;
  }
  return false;
}
