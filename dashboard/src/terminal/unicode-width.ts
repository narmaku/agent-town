import type { IUnicodeVersionProvider } from "@xterm/xterm";

/**
 * Character widths matching what modern TUIs (Claude Code, Codex, OpenCode)
 * assume: emoji and East Asian wide characters take two cells, combining
 * marks take none. xterm.js defaults to Unicode 6 widths, which misaligns
 * their box drawing and spinners. Replaces @xterm/addon-unicode11 using the
 * browser's own Unicode tables (regex property escapes).
 */
export const UNICODE_VERSION = "agent-town";

const WIDE_RE =
  /[\p{Emoji_Presentation}ᄀ-ᅟ⌚⌛〈〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{16FE0}-\u{18D08}\u{1B000}-\u{1B2FF}\u{1F200}-\u{1F2FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
// U+2028/U+2029 are handled in computeWidth: line separators can't appear in a regex literal.
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}​-‏‪-‮⁠-⁤﻿ᅠ-ᇿ]/u;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

const BMP_SIZE = 0x10000;
let bmpWidths: Uint8Array | null = null;

function computeWidth(codepoint: number): 0 | 1 | 2 {
  if (codepoint < 32 || (codepoint >= 0x7f && codepoint < 0xa0)) return 0;
  if (codepoint < 0x300) return 1;
  if (codepoint === LINE_SEPARATOR || codepoint === PARAGRAPH_SEPARATOR) return 0;
  const ch = String.fromCodePoint(codepoint);
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  return WIDE_RE.test(ch) ? 2 : 1;
}

export function charWidth(codepoint: number): 0 | 1 | 2 {
  if (codepoint >= BMP_SIZE) return computeWidth(codepoint);
  if (!bmpWidths) {
    // Precompute the Basic Multilingual Plane once (~65k lookups, a few ms).
    bmpWidths = new Uint8Array(BMP_SIZE);
    for (let cp = 0; cp < BMP_SIZE; cp++) bmpWidths[cp] = computeWidth(cp);
  }
  return bmpWidths[codepoint] as 0 | 1 | 2;
}

// xterm packs char properties as (state << 3) | (width << 1) | shouldJoin.
function widthOf(properties: number): number {
  return (properties >> 1) & 3;
}

function packProperties(width: number, shouldJoin: boolean): number {
  return ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

export const unicodeWidthProvider: IUnicodeVersionProvider = {
  version: UNICODE_VERSION,
  wcwidth: charWidth,
  charProperties(codepoint: number, preceding: number): number {
    let width: number = charWidth(codepoint);
    // A zero-width mark joins the preceding character and keeps its width.
    let shouldJoin = width === 0 && preceding !== 0;
    if (shouldJoin) {
      const previous = widthOf(preceding);
      if (previous === 0) shouldJoin = false;
      else if (previous > width) width = previous;
    }
    return packProperties(width, shouldJoin);
  },
};
