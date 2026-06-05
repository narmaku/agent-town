import { describe, expect, test } from "bun:test";
import {
  ALT_PREFIX,
  ENTER,
  ESCAPE,
  TAB,
  altCode,
  arrowCode,
  ctrlCode,
  parseKeyCombo,
} from "./key-codes";

describe("ctrlCode", () => {
  test("maps lowercase a-z to control codes", () => {
    expect(ctrlCode("a")).toBe("\x01");
    expect(ctrlCode("b")).toBe("\x02");
    expect(ctrlCode("c")).toBe("\x03");
    expect(ctrlCode("d")).toBe("\x04");
    expect(ctrlCode("l")).toBe("\x0c");
    expect(ctrlCode("z")).toBe("\x1a");
  });

  test("maps uppercase A-Z to same control codes", () => {
    expect(ctrlCode("A")).toBe("\x01");
    expect(ctrlCode("C")).toBe("\x03");
    expect(ctrlCode("Z")).toBe("\x1a");
  });

  test("returns empty string for non-letter keys", () => {
    expect(ctrlCode("1")).toBe("");
    expect(ctrlCode("")).toBe("");
    expect(ctrlCode(" ")).toBe("");
  });
});

describe("altCode", () => {
  test("prepends ESC to key", () => {
    expect(altCode("b")).toBe("\x1bb");
    expect(altCode("f")).toBe("\x1bf");
    expect(altCode("d")).toBe("\x1bd");
  });

  test("handles uppercase", () => {
    expect(altCode("B")).toBe("\x1bB");
  });

  test("returns just ESC for empty key", () => {
    expect(altCode("")).toBe("\x1b");
  });
});

describe("arrowCode", () => {
  test("returns correct ANSI sequences", () => {
    expect(arrowCode("up")).toBe("\x1b[A");
    expect(arrowCode("down")).toBe("\x1b[B");
    expect(arrowCode("right")).toBe("\x1b[C");
    expect(arrowCode("left")).toBe("\x1b[D");
  });
});

describe("parseKeyCombo", () => {
  test("parses Ctrl+letter combos", () => {
    expect(parseKeyCombo("Ctrl+C")).toBe("\x03");
    expect(parseKeyCombo("Ctrl+c")).toBe("\x03");
    expect(parseKeyCombo("Ctrl+B")).toBe("\x02");
    expect(parseKeyCombo("Ctrl+Z")).toBe("\x1a");
  });

  test("parses Alt+letter combos", () => {
    expect(parseKeyCombo("Alt+B")).toBe("\x1bb");
    expect(parseKeyCombo("Alt+f")).toBe("\x1bf");
  });

  test("parses standalone special keys", () => {
    expect(parseKeyCombo("Escape")).toBe("\x1b");
    expect(parseKeyCombo("Tab")).toBe("\x09");
    expect(parseKeyCombo("Enter")).toBe("\r");
  });

  test("parses arrow keys", () => {
    expect(parseKeyCombo("Up")).toBe("\x1b[A");
    expect(parseKeyCombo("Down")).toBe("\x1b[B");
    expect(parseKeyCombo("Left")).toBe("\x1b[D");
    expect(parseKeyCombo("Right")).toBe("\x1b[C");
  });

  test("is case-insensitive for modifiers", () => {
    expect(parseKeyCombo("ctrl+c")).toBe("\x03");
    expect(parseKeyCombo("CTRL+C")).toBe("\x03");
    expect(parseKeyCombo("alt+b")).toBe("\x1bb");
  });

  test("handles Ctrl+Shift combos by uppercasing", () => {
    expect(parseKeyCombo("Ctrl+Shift+C")).toBe("\x03");
  });

  test("returns empty string for empty input", () => {
    expect(parseKeyCombo("")).toBe("");
  });

  test("returns empty string for unknown keys", () => {
    expect(parseKeyCombo("SuperSpecialKey")).toBe("");
  });

  test("handles function keys with Ctrl", () => {
    expect(parseKeyCombo("Ctrl+A")).toBe("\x01");
  });
});

describe("constants", () => {
  test("TAB is correct", () => {
    expect(TAB).toBe("\x09");
  });

  test("ESCAPE is correct", () => {
    expect(ESCAPE).toBe("\x1b");
  });

  test("ENTER is correct", () => {
    expect(ENTER).toBe("\r");
  });

  test("ALT_PREFIX is ESC", () => {
    expect(ALT_PREFIX).toBe("\x1b");
  });
});
