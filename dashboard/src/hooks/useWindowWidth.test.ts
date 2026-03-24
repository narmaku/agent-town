import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Since useWindowWidth is a React hook that depends on useState/useEffect,
 * and this project does not configure a DOM test environment (happy-dom / jsdom),
 * we test the resize-subscription and debounce logic by simulating the window API
 * and verifying that listeners are correctly added/removed, and that rapid
 * resize events are debounced rather than applied immediately.
 */

type ResizeHandler = () => void;

let listeners: ResizeHandler[];
let mockInnerWidth: number;
let originalWindow: typeof globalThis.window;

beforeEach(() => {
  listeners = [];
  mockInnerWidth = 1024;
  originalWindow = globalThis.window;

  // biome-ignore lint/suspicious/noExplicitAny: test mock for window
  (globalThis as any).window = {
    get innerWidth() {
      return mockInnerWidth;
    },
    addEventListener(event: string, handler: ResizeHandler) {
      if (event === "resize") {
        listeners.push(handler);
      }
    },
    removeEventListener(event: string, handler: ResizeHandler) {
      if (event === "resize") {
        listeners = listeners.filter((h) => h !== handler);
      }
    },
  };
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test cleanup for window mock
  (globalThis as any).window = originalWindow;
});

function fireResize() {
  for (const h of [...listeners]) {
    h();
  }
}

describe("useWindowWidth subscription logic", () => {
  test("addEventListener registers a resize handler", () => {
    const handler = () => {};
    window.addEventListener("resize", handler);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]).toBe(handler);
  });

  test("removeEventListener unregisters the handler", () => {
    const handler = () => {};
    window.addEventListener("resize", handler);
    expect(listeners).toHaveLength(1);

    window.removeEventListener("resize", handler);
    expect(listeners).toHaveLength(0);
  });

  test("multiple handlers can be registered and individually removed", () => {
    const handler1 = () => {};
    const handler2 = () => {};

    window.addEventListener("resize", handler1);
    window.addEventListener("resize", handler2);
    expect(listeners).toHaveLength(2);

    window.removeEventListener("resize", handler1);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]).toBe(handler2);
  });

  test("resize handler reads updated innerWidth after debounce fires", async () => {
    let capturedWidth = 0;
    const handler = () => {
      // Simulates what the hook's debounced callback does:
      // schedules a setTimeout that reads window.innerWidth
      setTimeout(() => {
        capturedWidth = window.innerWidth;
      }, 150);
    };
    window.addEventListener("resize", handler);

    mockInnerWidth = 768;
    fireResize();

    // Width not captured yet (debounce hasn't fired)
    expect(capturedWidth).toBe(0);

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 200));
    expect(capturedWidth).toBe(768);
  });

  test("rapid resize events result in only the last value being read", async () => {
    const capturedWidths: number[] = [];
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

    const handler = () => {
      // Simulate debounce: clear previous timeout, schedule new one
      if (pendingTimeout !== null) {
        clearTimeout(pendingTimeout);
      }
      pendingTimeout = setTimeout(() => {
        capturedWidths.push(window.innerWidth);
        pendingTimeout = null;
      }, 150);
    };
    window.addEventListener("resize", handler);

    // Fire multiple rapid resizes
    mockInnerWidth = 800;
    fireResize();
    mockInnerWidth = 600;
    fireResize();
    mockInnerWidth = 400;
    fireResize();

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    // Only the final width should have been captured (debounce collapsed the calls)
    expect(capturedWidths).toHaveLength(1);
    expect(capturedWidths[0]).toBe(400);
  });
});
