import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clampValue, computeNewSize, isVerticalSide, loadStoredSize, STORAGE_PREFIX } from "./useResizable";

// Minimal localStorage mock for Bun test environment
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (_index: number) => null,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("STORAGE_PREFIX", () => {
  test("follows the agentTown: namespace pattern", () => {
    expect(STORAGE_PREFIX).toBe("agentTown:panelSize:");
  });
});

describe("loadStoredSize", () => {
  test("returns fallback when no stored value exists", () => {
    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns stored value when it is a valid positive number", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "450");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(450);
  });

  test("returns fallback for NaN stored value", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "not-a-number");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns fallback for negative stored value", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "-100");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns fallback for zero stored value", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "0");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns fallback for Infinity stored value", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "Infinity");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns fallback for empty string stored value", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("returns stored value for decimal numbers", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "275.5");

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(275.5);
  });

  test("returns fallback when localStorage throws", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error("localStorage unavailable");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      get length() {
        return 0;
      },
      key: () => null,
    };

    const size = loadStoredSize("sidebar", 300);
    expect(size).toBe(300);
  });

  test("uses correct storage key with prefix", () => {
    storage.set(`${STORAGE_PREFIX}info-pane`, "500");
    storage.set(`${STORAGE_PREFIX}sidebar`, "250");

    expect(loadStoredSize("info-pane", 300)).toBe(500);
    expect(loadStoredSize("sidebar", 300)).toBe(250);
  });

  test("loading after removing stored value returns fallback", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "450");
    expect(loadStoredSize("sidebar", 300)).toBe(450);

    localStorage.removeItem(`${STORAGE_PREFIX}sidebar`);

    expect(loadStoredSize("sidebar", 300)).toBe(300);
  });

  test("removing one key does not affect other keys", () => {
    storage.set(`${STORAGE_PREFIX}sidebar`, "450");
    storage.set(`${STORAGE_PREFIX}info-pane`, "500");

    localStorage.removeItem(`${STORAGE_PREFIX}sidebar`);

    expect(loadStoredSize("sidebar", 300)).toBe(300);
    expect(loadStoredSize("info-pane", 300)).toBe(500);
  });
});

describe("clampValue", () => {
  test("clamps to minimum when value is below range", () => {
    expect(clampValue(50, 200, 800)).toBe(200);
  });

  test("clamps to maximum when value exceeds range", () => {
    expect(clampValue(1000, 200, 800)).toBe(800);
  });

  test("returns value unchanged when within range", () => {
    expect(clampValue(500, 200, 800)).toBe(500);
  });

  test("returns minimum when value equals minimum", () => {
    expect(clampValue(200, 200, 800)).toBe(200);
  });

  test("returns maximum when value equals maximum", () => {
    expect(clampValue(800, 200, 800)).toBe(800);
  });
});

describe("isVerticalSide", () => {
  test("left is horizontal", () => {
    expect(isVerticalSide("left")).toBe(false);
  });

  test("right is horizontal", () => {
    expect(isVerticalSide("right")).toBe(false);
  });

  test("top is vertical", () => {
    expect(isVerticalSide("top")).toBe(true);
  });

  test("bottom is vertical", () => {
    expect(isVerticalSide("bottom")).toBe(true);
  });
});

describe("computeNewSize", () => {
  test("positive delta increases size for left panel", () => {
    expect(computeNewSize(300, 50, "left")).toBe(350);
  });

  test("negative delta decreases size for left panel", () => {
    expect(computeNewSize(300, -50, "left")).toBe(250);
  });

  test("positive delta decreases size for right panel", () => {
    expect(computeNewSize(300, 50, "right")).toBe(250);
  });

  test("negative delta increases size for right panel", () => {
    expect(computeNewSize(300, -50, "right")).toBe(350);
  });

  test("positive delta increases size for top panel", () => {
    expect(computeNewSize(200, 30, "top")).toBe(230);
  });

  test("negative delta decreases size for top panel", () => {
    expect(computeNewSize(200, -30, "top")).toBe(170);
  });

  test("positive delta decreases size for bottom panel", () => {
    expect(computeNewSize(200, 30, "bottom")).toBe(170);
  });

  test("negative delta increases size for bottom panel", () => {
    expect(computeNewSize(200, -30, "bottom")).toBe(230);
  });
});

describe("computeNewSize with clamping", () => {
  test("left panel drag clamped to maximum", () => {
    const newSize = clampValue(computeNewSize(750, 100, "left"), 200, 800);
    expect(newSize).toBe(800);
  });

  test("right panel drag clamped to minimum", () => {
    const newSize = clampValue(computeNewSize(250, 100, "right"), 200, 800);
    expect(newSize).toBe(200);
  });

  test("top panel drag clamped to minimum", () => {
    const newSize = clampValue(computeNewSize(210, -50, "top"), 200, 800);
    expect(newSize).toBe(200);
  });

  test("bottom panel large negative drag clamped to maximum", () => {
    const newSize = clampValue(computeNewSize(750, -100, "bottom"), 200, 800);
    expect(newSize).toBe(800);
  });
});
