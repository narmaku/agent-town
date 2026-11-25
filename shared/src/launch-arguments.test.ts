import { describe, expect, test } from "bun:test";
import { parseLaunchArguments } from "./launch-arguments";
import { shellEscape } from "./shell";

describe("parseLaunchArguments", () => {
  test("parses flags, quoted values, and escaped spaces as separate arguments", () => {
    expect(parseLaunchArguments(String.raw` --flag "two words" --option='a b' path\ with\ spaces '' `)).toEqual([
      "--flag",
      "two words",
      "--option=a b",
      "path with spaces",
      "",
    ]);
  });

  test("preserves shell expressions and backslashes as literal text", () => {
    expect(parseLaunchArguments(String.raw`"$(printf hi)" '*.json' "$HOME" "dir\file" "say \"hi\""`)).toEqual([
      "$(printf hi)",
      "*.json",
      "$HOME",
      "dir\\file",
      'say "hi"',
    ]);
  });

  test("omits blank input and rejects unfinished quotes or escapes", () => {
    expect(parseLaunchArguments(" \t ")).toEqual([]);
    expect(() => parseLaunchArguments(`--flag "unfinished`)).toThrow("quote");
    expect(() => parseLaunchArguments("--flag unfinished\\")).toThrow("backslash");
  });

  test("round-trips prefilled arguments with spaces, quotes, backslashes, and empty values", () => {
    const args = ["--flag", "two words", "O'Brien", String.raw`two\\slashes`, "", "$HOME"];
    expect(parseLaunchArguments(args.map(shellEscape).join(" "))).toEqual(args);
  });
});
