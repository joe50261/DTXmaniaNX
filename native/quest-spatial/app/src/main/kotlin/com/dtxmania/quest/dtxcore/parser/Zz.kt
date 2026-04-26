package com.dtxmania.quest.dtxcore.parser

/**
 * DTX "zz" id decoding. Ids are two characters of base-36 (0-9, A-Z),
 * representing values 1..(36*36)-1 (id 0 means "no chip" / rest).
 *
 * Ported from `web/packages/dtx-core/src/parser/zz.ts`, which itself
 * traces back to CDTX.cs (various `nBaseTo10` helpers).
 */
fun decodeZz(pair: String): Int {
    require(pair.length == 2) { "zz id must be exactly 2 chars, got \"$pair\"" }
    val hi = base36Digit(pair[0].code)
    val lo = base36Digit(pair[1].code)
    require(hi >= 0 && lo >= 0) { "zz id has non-base36 character: \"$pair\"" }
    return hi * 36 + lo
}

private fun base36Digit(code: Int): Int = when (code) {
    in 48..57 -> code - 48          // 0-9
    in 65..90 -> code - 65 + 10     // A-Z
    in 97..122 -> code - 97 + 10    // a-z (tolerate lowercase)
    else -> -1
}
