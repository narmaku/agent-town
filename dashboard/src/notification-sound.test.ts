import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { getNotificationBody, NOTIFICATION_FREQUENCIES, playNotificationSound } from "./notification-sound";

describe("playNotificationSound", () => {
  let mockOscillator: {
    connect: ReturnType<typeof spyOn>;
    frequency: { value: number };
    start: ReturnType<typeof spyOn>;
    stop: ReturnType<typeof spyOn>;
  };

  let mockGain: {
    connect: ReturnType<typeof spyOn>;
    gain: { value: number; exponentialRampToValueAtTime: ReturnType<typeof spyOn> };
  };

  let mockCtx: {
    createOscillator: ReturnType<typeof spyOn>;
    createGain: ReturnType<typeof spyOn>;
    currentTime: number;
    destination: string;
  };

  beforeEach(() => {
    mockOscillator = {
      connect: spyOn({ connect() {} }, "connect"),
      frequency: { value: 0 },
      start: spyOn({ start() {} }, "start"),
      stop: spyOn({ stop() {} }, "stop"),
    };

    mockGain = {
      connect: spyOn({ connect() {} }, "connect"),
      gain: {
        value: 0,
        exponentialRampToValueAtTime: spyOn({ exponentialRampToValueAtTime() {} }, "exponentialRampToValueAtTime"),
      },
    };

    mockCtx = {
      createOscillator: spyOn({ createOscillator: () => mockOscillator }, "createOscillator"),
      createGain: spyOn({ createGain: () => mockGain }, "createGain"),
      currentTime: 0,
      destination: "speakers",
    };

    // biome-ignore lint/complexity/useArrowFunction: must be callable with `new`
    (globalThis as Record<string, unknown>).AudioContext = function () {
      return mockCtx;
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).AudioContext;
  });

  test("creates an oscillator and gain node", () => {
    playNotificationSound("awaiting_input");
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(1);
    expect(mockCtx.createGain).toHaveBeenCalledTimes(1);
  });

  test("connects oscillator to gain and gain to destination", () => {
    playNotificationSound("awaiting_input");
    expect(mockOscillator.connect).toHaveBeenCalledWith(mockGain);
    expect(mockGain.connect).toHaveBeenCalledWith("speakers");
  });

  test("starts and stops the oscillator", () => {
    playNotificationSound("awaiting_input");
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
    expect(mockOscillator.stop).toHaveBeenCalledTimes(1);
  });

  test("sets gain volume to 0.15", () => {
    playNotificationSound("awaiting_input");
    expect(mockGain.gain.value).toBe(0.15);
  });

  test("ramps gain down to near zero", () => {
    playNotificationSound("awaiting_input");
    expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 0.3);
  });

  test("uses higher frequency for error status", () => {
    playNotificationSound("error");
    expect(mockOscillator.frequency.value).toBe(NOTIFICATION_FREQUENCIES.error);
  });

  test("uses lower frequency for done status", () => {
    playNotificationSound("done");
    expect(mockOscillator.frequency.value).toBe(NOTIFICATION_FREQUENCIES.done);
  });

  test("uses default frequency for awaiting_input", () => {
    playNotificationSound("awaiting_input");
    expect(mockOscillator.frequency.value).toBe(NOTIFICATION_FREQUENCIES.default);
  });

  test("does not throw when AudioContext is unavailable", () => {
    delete (globalThis as Record<string, unknown>).AudioContext;
    expect(() => playNotificationSound("awaiting_input")).not.toThrow();
  });
});

describe("getNotificationBody", () => {
  test("returns input message for awaiting_input", () => {
    expect(getNotificationBody("awaiting_input", "my-session")).toBe("my-session — waiting for your input");
  });

  test("returns question message for action_required", () => {
    expect(getNotificationBody("action_required", "build-agent")).toBe("build-agent — agent is asking a question");
  });

  test("returns finished message for done", () => {
    expect(getNotificationBody("done", "task-runner")).toBe("task-runner — session finished");
  });

  test("returns error message for error", () => {
    expect(getNotificationBody("error", "broken")).toBe("broken — session encountered an error");
  });

  test("returns exited message for exited", () => {
    expect(getNotificationBody("exited", "old-session")).toBe("old-session — session exited");
  });

  test("returns generic message for other statuses", () => {
    expect(getNotificationBody("working", "sess")).toBe("sess — status changed to working");
  });
});

describe("NOTIFICATION_FREQUENCIES", () => {
  test("has a default frequency", () => {
    expect(NOTIFICATION_FREQUENCIES.default).toBe(660);
  });

  test("error frequency is higher than default", () => {
    expect(NOTIFICATION_FREQUENCIES.error).toBeGreaterThan(NOTIFICATION_FREQUENCIES.default);
  });

  test("done frequency is lower than default", () => {
    expect(NOTIFICATION_FREQUENCIES.done).toBeLessThan(NOTIFICATION_FREQUENCIES.default);
  });
});
