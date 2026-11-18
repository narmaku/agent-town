import { describe, expect, test } from "bun:test";

import { findLinks } from "./links";
import { charWidth, unicodeWidthProvider } from "./unicode-width";

describe("charWidth", () => {
  test("measures ASCII, wide, emoji and combining characters", () => {
    expect(charWidth("a".codePointAt(0) as number)).toBe(1);
    expect(charWidth("─".codePointAt(0) as number)).toBe(1); // box drawing
    expect(charWidth("中".codePointAt(0) as number)).toBe(2);
    expect(charWidth("✅".codePointAt(0) as number)).toBe(2);
    expect(charWidth("🚀".codePointAt(0) as number)).toBe(2);
    expect(charWidth(0x0301)).toBe(0); // combining acute accent
    expect(charWidth(0x200d)).toBe(0); // zero-width joiner
    expect(charWidth(0x07)).toBe(0); // control
  });

  test("joins a combining mark to the preceding character", () => {
    const base = unicodeWidthProvider.charProperties("e".codePointAt(0) as number, 0);
    const mark = unicodeWidthProvider.charProperties(0x0301, base);
    expect(mark & 1).toBe(1); // shouldJoin
    expect((mark >> 1) & 3).toBe(1); // keeps the base width
  });
});

describe("findLinks", () => {
  test("finds URLs and trims trailing punctuation", () => {
    expect(findLinks("open https://example.com/a. or (http://x.dev/b)")).toEqual([
      { index: 5, url: "https://example.com/a" },
      { index: 32, url: "http://x.dev/b" },
    ]);
  });

  test("keeps balanced parentheses inside a URL", () => {
    expect(findLinks("https://en.wikipedia.org/wiki/Bun_(software)")).toEqual([
      { index: 0, url: "https://en.wikipedia.org/wiki/Bun_(software)" },
    ]);
  });
});
