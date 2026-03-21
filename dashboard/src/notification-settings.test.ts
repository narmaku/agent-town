import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  loadNotificationSettings,
  NOTIFICATION_STORAGE_KEY,
  type NotificationSettings,
  saveNotificationSettings,
} from "./notification-settings";

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

describe("DEFAULT_NOTIFICATION_SETTINGS", () => {
  test("enableNotifications defaults to true", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.enableNotifications).toBe(true);
  });

  test("enableSoundAlerts defaults to true", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.enableSoundAlerts).toBe(true);
  });

  test("notifyOnStatuses includes awaiting_input and action_required", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toContain("awaiting_input");
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toContain("action_required");
  });

  test("notifyOnStatuses includes error, done, and exited", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toContain("error");
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toContain("done");
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toContain("exited");
  });

  test("notifyOnStatuses has exactly 5 entries", () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses).toHaveLength(5);
  });
});

describe("loadNotificationSettings", () => {
  test("returns defaults when localStorage is empty", () => {
    const settings = loadNotificationSettings();
    expect(settings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  test("returns stored settings from localStorage", () => {
    const custom: NotificationSettings = {
      enableNotifications: false,
      enableSoundAlerts: false,
      notifyOnStatuses: ["error"],
    };
    storage.set(NOTIFICATION_STORAGE_KEY, JSON.stringify(custom));

    const settings = loadNotificationSettings();
    expect(settings.enableNotifications).toBe(false);
    expect(settings.enableSoundAlerts).toBe(false);
    expect(settings.notifyOnStatuses).toEqual(["error"]);
  });

  test("returns defaults when localStorage has invalid JSON", () => {
    storage.set(NOTIFICATION_STORAGE_KEY, "not valid json{{{");

    const settings = loadNotificationSettings();
    expect(settings).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  test("merges partial stored settings with defaults", () => {
    // Store only enableNotifications; other fields should come from defaults
    storage.set(NOTIFICATION_STORAGE_KEY, JSON.stringify({ enableNotifications: false }));

    const settings = loadNotificationSettings();
    expect(settings.enableNotifications).toBe(false);
    expect(settings.enableSoundAlerts).toBe(true);
    expect(settings.notifyOnStatuses).toEqual(DEFAULT_NOTIFICATION_SETTINGS.notifyOnStatuses);
  });
});

describe("saveNotificationSettings", () => {
  test("persists settings to localStorage", () => {
    const custom: NotificationSettings = {
      enableNotifications: true,
      enableSoundAlerts: false,
      notifyOnStatuses: ["done", "exited"],
    };
    saveNotificationSettings(custom);

    const stored = storage.get(NOTIFICATION_STORAGE_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string) as NotificationSettings;
    expect(parsed.enableSoundAlerts).toBe(false);
    expect(parsed.notifyOnStatuses).toEqual(["done", "exited"]);
  });

  test("overwrites previous settings", () => {
    saveNotificationSettings({
      enableNotifications: true,
      enableSoundAlerts: true,
      notifyOnStatuses: ["error"],
    });
    saveNotificationSettings({
      enableNotifications: false,
      enableSoundAlerts: false,
      notifyOnStatuses: [],
    });

    const stored = storage.get(NOTIFICATION_STORAGE_KEY);
    const parsed = JSON.parse(stored as string) as NotificationSettings;
    expect(parsed.enableNotifications).toBe(false);
    expect(parsed.notifyOnStatuses).toEqual([]);
  });
});

describe("NOTIFICATION_STORAGE_KEY", () => {
  test("follows the agentTown: namespace pattern", () => {
    expect(NOTIFICATION_STORAGE_KEY).toMatch(/^agentTown:/);
  });
});
