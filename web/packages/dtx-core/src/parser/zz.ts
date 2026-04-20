/**
 * DTX "zz" id decoding. Ids are two characters of base-36 (0-9, A-Z), representing
 * values 1..(36*36)-1 (id 0 means "no chip" / rest).
 *
 * Ported from CDTX.cs (various `nBaseTo10` helpers).
 */
export function decodeZz(pair: string): number {
  if (pair.length !== 2) {
    throw new Error(`zz id must be exactly 2 chars, got ${JSON.stringify(pair)}`);
  }
  const hi = base36Digit(pair.charCodeAt(0));
  const lo = base36Digit(pair.charCodeAt(1));
  if (hi < 0 || lo < 0) {
    throw new Error(`zz id has non-base36 character: ${JSON.stringify(pair)}`);
  }
  return hi * 36 + lo;
}

function base36Digit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;           // 0-9
  if (code >= 65 && code <= 90) return code - 65 + 10;      // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 10;     // a-z (tolerate lowercase)
  return -1;
}
