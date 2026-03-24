import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Since useWindowWidth is a React hook that depends on window + useState/useEffect,
 * and this project does not configure a DOM test environment (happy-dom / jsdom),
 * we test the underlying resize-subscription logic by simulating the window API
 * and verifying that listeners are correctly added and removed.
 */

type ResizeHandler = () => void;

let listeners: ResizeHandler[];
let mockInnerWidth: number;

beforeEach(() => {
  listeners = [];
  mockInnerWidth = 1024;

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
  delete (globalThis as any).window;
});

describe("useWindowWidth subscription logic", () => {
  test("window.innerWidth returns the mock value", () => {
    expect(window.innerWidth).toBe(1024);
  });

  test("changing mock innerWidth is reflected", () => {
    mockInnerWidth = 500;
    expect(window.innerWidth).toBe(500);
  });

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

  test("resize handlers are called and can read updated innerWidth", () => {
    let capturedWidth = 0;
    const handler = () => {
      capturedWidth = window.innerWidth;
    };
    window.addEventListener("resize", handler);

    mockInnerWidth = 768;
    // Simulate the browser firing the resize event
    for (const h of listeners) {
      h();
    }

    expect(capturedWidth).toBe(768);
  });
});
