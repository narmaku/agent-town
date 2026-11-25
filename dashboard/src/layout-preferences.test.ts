import { describe, expect, test } from "bun:test";

import { normalizeLayoutMode } from "./layout-preferences";

describe("layout preferences", () => {
  test("opens Explorer for fresh installs and invalid preferences", () => {
    for (const value of [undefined, null, "", "unknown", {}, 1]) {
      expect(normalizeLayoutMode(value)).toBe("explorer");
    }
  });

  test("preserves each chosen layout and the legacy Cards preference", () => {
    for (const value of ["explorer", "control", "signal"] as const) {
      expect(normalizeLayoutMode(value)).toBe(value);
    }
    expect(normalizeLayoutMode("cards")).toBe("control");
  });
});
