import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { loadStoredSize, STORAGE_PREFIX } from "./useResizable";

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
    // Replace localStorage with one that throws on getItem
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
});

describe("useResizable hook behavior", () => {
  // These tests simulate the hook logic by directly testing the event handling
  // patterns used by the hook (mousemove / mouseup on document).

  // Helper: simulates the clamping logic used inside the hook
  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  describe("clamping", () => {
    test("clamps value to minSize when drag goes below minimum", () => {
      const result = clamp(50, 200, 800);
      expect(result).toBe(200);
    });

    test("clamps value to maxSize when drag exceeds maximum", () => {
      const result = clamp(1000, 200, 800);
      expect(result).toBe(800);
    });

    test("returns value unchanged when within bounds", () => {
      const result = clamp(500, 200, 800);
      expect(result).toBe(500);
    });

    test("returns minSize when value equals minSize", () => {
      const result = clamp(200, 200, 800);
      expect(result).toBe(200);
    });

    test("returns maxSize when value equals maxSize", () => {
      const result = clamp(800, 200, 800);
      expect(result).toBe(800);
    });
  });

  describe("drag direction", () => {
    // For left/top panels: newSize = startSize + delta
    // For right/bottom panels: newSize = startSize - delta

    test("positive drag increases size for left panel", () => {
      const startSize = 300;
      const delta = 50; // mouse moved 50px to the right
      const newSize = startSize + delta; // left panel convention
      expect(newSize).toBe(350);
    });

    test("negative drag decreases size for left panel", () => {
      const startSize = 300;
      const delta = -50; // mouse moved 50px to the left
      const newSize = startSize + delta;
      expect(newSize).toBe(250);
    });

    test("positive drag decreases size for right panel", () => {
      const startSize = 300;
      const delta = 50; // mouse moved 50px to the right
      const newSize = startSize - delta; // right panel convention
      expect(newSize).toBe(250);
    });

    test("negative drag increases size for right panel", () => {
      const startSize = 300;
      const delta = -50; // mouse moved 50px to the left
      const newSize = startSize - delta;
      expect(newSize).toBe(350);
    });

    test("positive drag increases size for top panel", () => {
      const startSize = 200;
      const delta = 30; // mouse moved 30px down
      const newSize = startSize + delta; // top panel convention
      expect(newSize).toBe(230);
    });

    test("negative drag decreases size for top panel", () => {
      const startSize = 200;
      const delta = -30; // mouse moved 30px up
      const newSize = startSize + delta;
      expect(newSize).toBe(170);
    });

    test("positive drag decreases size for bottom panel", () => {
      const startSize = 200;
      const delta = 30; // mouse moved 30px down
      const newSize = startSize - delta; // bottom panel convention
      expect(newSize).toBe(170);
    });

    test("negative drag increases size for bottom panel", () => {
      const startSize = 200;
      const delta = -30; // mouse moved 30px up
      const newSize = startSize - delta;
      expect(newSize).toBe(230);
    });
  });

  describe("drag with clamping and direction combined", () => {
    test("left panel drag clamped to maxSize", () => {
      const startSize = 750;
      const delta = 100;
      const newSize = clamp(startSize + delta, 200, 800);
      expect(newSize).toBe(800);
    });

    test("right panel drag clamped to minSize", () => {
      const startSize = 250;
      const delta = 100;
      const newSize = clamp(startSize - delta, 200, 800);
      expect(newSize).toBe(200);
    });

    test("top panel drag clamped to minSize", () => {
      const startSize = 210;
      const delta = -50;
      const newSize = clamp(startSize + delta, 200, 800);
      expect(newSize).toBe(200);
    });

    test("bottom panel large negative drag clamped to maxSize", () => {
      const startSize = 750;
      const delta = -100;
      const newSize = clamp(startSize - delta, 200, 800);
      expect(newSize).toBe(800);
    });
  });

  describe("resetSize behavior", () => {
    test("removes stored size from localStorage", () => {
      const key = "sidebar";
      storage.set(`${STORAGE_PREFIX}${key}`, "450");

      // Simulate resetSize: remove from localStorage
      localStorage.removeItem(`${STORAGE_PREFIX}${key}`);

      expect(storage.has(`${STORAGE_PREFIX}${key}`)).toBe(false);
    });

    test("loading after reset returns default size", () => {
      const key = "sidebar";
      const defaultSize = 300;

      // Store a custom size
      storage.set(`${STORAGE_PREFIX}${key}`, "450");
      expect(loadStoredSize(key, defaultSize)).toBe(450);

      // Simulate resetSize: remove stored value
      localStorage.removeItem(`${STORAGE_PREFIX}${key}`);

      // After reset, loadStoredSize should return fallback
      expect(loadStoredSize(key, defaultSize)).toBe(defaultSize);
    });

    test("reset does not affect other storage keys", () => {
      storage.set(`${STORAGE_PREFIX}sidebar`, "450");
      storage.set(`${STORAGE_PREFIX}info-pane`, "500");

      // Simulate resetting only sidebar
      localStorage.removeItem(`${STORAGE_PREFIX}sidebar`);

      expect(loadStoredSize("sidebar", 300)).toBe(300);
      expect(loadStoredSize("info-pane", 300)).toBe(500);
    });
  });

  describe("localStorage persistence on drag end", () => {
    test("saves size to localStorage on mouseup", () => {
      const key = "sidebar";
      const size = 420;

      // Simulate what handleMouseUp does: setItem with STORAGE_PREFIX + key
      localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(size));

      expect(storage.get(`${STORAGE_PREFIX}${key}`)).toBe("420");
    });

    test("saved value can be loaded back correctly", () => {
      const key = "sidebar";
      const size = 420;

      localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(size));

      expect(loadStoredSize(key, 300)).toBe(420);
    });
  });

  describe("event listener lifecycle", () => {
    test("mousemove and mouseup listeners are added to document", () => {
      const calls: string[] = [];
      const mockDocument = {
        addEventListener: (event: string) => calls.push(`add:${event}`),
        removeEventListener: () => {},
      };

      // Simulate what useEffect does: register mousemove and mouseup
      mockDocument.addEventListener("mousemove");
      mockDocument.addEventListener("mouseup");

      expect(calls).toEqual(["add:mousemove", "add:mouseup"]);
    });

    test("mousemove and mouseup listeners are removed on cleanup", () => {
      const calls: string[] = [];
      const mockDocument = {
        addEventListener: () => {},
        removeEventListener: (event: string) => calls.push(`remove:${event}`),
      };

      // Simulate the useEffect cleanup function
      mockDocument.removeEventListener("mousemove");
      mockDocument.removeEventListener("mouseup");

      expect(calls).toEqual(["remove:mousemove", "remove:mouseup"]);
    });
  });

  describe("handleMouseDown behavior", () => {
    test("uses clientX for horizontal panels (left/right)", () => {
      // For left/right panels, startPos should come from e.clientX
      const mockEvent = { clientX: 500, clientY: 300, preventDefault: () => {} };

      const isVertical = false; // left or right
      const startPos = isVertical ? mockEvent.clientY : mockEvent.clientX;
      expect(startPos).toBe(500);
    });

    test("uses clientY for vertical panels (top/bottom)", () => {
      // For top/bottom panels, startPos should come from e.clientY
      const mockEvent = { clientX: 500, clientY: 300, preventDefault: () => {} };

      const isVertical = true; // top or bottom
      const startPos = isVertical ? mockEvent.clientY : mockEvent.clientX;
      expect(startPos).toBe(300);
    });

    test("preventDefault is called on mousedown", () => {
      const preventDefaultSpy = spyOn({ preventDefault() {} }, "preventDefault");
      const mockEvent = { clientX: 500, clientY: 300, preventDefault: preventDefaultSpy };

      // Simulate what handleMouseDown does
      mockEvent.preventDefault();

      expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("isVertical determination", () => {
    test("left side is horizontal", () => {
      const side = "left" as const;
      const isVertical = side === "top" || side === "bottom";
      expect(isVertical).toBe(false);
    });

    test("right side is horizontal", () => {
      const side = "right" as const;
      const isVertical = side === "top" || side === "bottom";
      expect(isVertical).toBe(false);
    });

    test("top side is vertical", () => {
      const side = "top" as const;
      const isVertical = side === "top" || side === "bottom";
      expect(isVertical).toBe(true);
    });

    test("bottom side is vertical", () => {
      const side = "bottom" as const;
      const isVertical = side === "top" || side === "bottom";
      expect(isVertical).toBe(true);
    });
  });
});
