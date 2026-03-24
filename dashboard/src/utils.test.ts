import { describe, expect, test } from "bun:test";
import { API, STATUS_CONFIG, shortenPath, timeAgo } from "./utils";

describe("timeAgo", () => {
  test("returns 'just now' for timestamps less than 10 seconds ago", () => {
    const now = new Date().toISOString();
    expect(timeAgo(now)).toBe("just now");
  });

  test("returns 'just now' for a timestamp 5 seconds ago", () => {
    const fiveSecondsAgo = new Date(Date.now() - 5_000).toISOString();
    expect(timeAgo(fiveSecondsAgo)).toBe("just now");
  });

  test("returns seconds ago for timestamps between 10 and 59 seconds", () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    expect(timeAgo(thirtySecondsAgo)).toBe("30s ago");
  });

  test("returns seconds ago at the 10-second boundary", () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    expect(timeAgo(tenSecondsAgo)).toBe("10s ago");
  });

  test("returns seconds ago at the 59-second boundary", () => {
    const fiftyNineSecondsAgo = new Date(Date.now() - 59_000).toISOString();
    expect(timeAgo(fiftyNineSecondsAgo)).toBe("59s ago");
  });

  test("returns minutes ago for timestamps between 1 and 59 minutes", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(timeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  test("returns minutes ago at the 1-minute boundary", () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    expect(timeAgo(oneMinuteAgo)).toBe("1m ago");
  });

  test("returns minutes ago at the 59-minute boundary", () => {
    const fiftyNineMinutesAgo = new Date(Date.now() - 59 * 60_000).toISOString();
    expect(timeAgo(fiftyNineMinutesAgo)).toBe("59m ago");
  });

  test("returns hours ago for timestamps 1 hour or more", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(timeAgo(oneHourAgo)).toBe("1h ago");
  });

  test("returns hours ago for multi-hour timestamps", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  test("returns large hour count for timestamps days ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    expect(timeAgo(twoDaysAgo)).toBe("48h ago");
  });

  test("returns hours ago for a future timestamp (negative seconds floors to 0)", () => {
    const futureTimestamp = new Date(Date.now() + 10 * 60_000).toISOString();
    // Math.floor of a negative number goes further negative,
    // so seconds < 10 is true => "just now"
    expect(timeAgo(futureTimestamp)).toBe("just now");
  });
});

describe("shortenPath", () => {
  test("replaces /home/username with ~ for Linux paths", () => {
    expect(shortenPath("/home/alice/projects/my-app")).toBe("~/projects/my-app");
  });

  test("replaces /home/username with ~ when path is exactly home dir", () => {
    expect(shortenPath("/home/bob")).toBe("~");
  });

  test("replaces /home/username with ~ for deeply nested paths", () => {
    expect(shortenPath("/home/carol/a/b/c/d/e")).toBe("~/a/b/c/d/e");
  });

  test("does not modify paths outside /home", () => {
    expect(shortenPath("/var/log/syslog")).toBe("/var/log/syslog");
  });

  test("does not modify root path", () => {
    expect(shortenPath("/")).toBe("/");
  });

  test("does not modify /tmp paths", () => {
    expect(shortenPath("/tmp/some-file")).toBe("/tmp/some-file");
  });

  test("handles /home with no username gracefully", () => {
    expect(shortenPath("/home")).toBe("/home");
  });

  test("handles /home/ with trailing slash but no username", () => {
    expect(shortenPath("/home/")).toBe("/home/");
  });

  test("handles empty string", () => {
    expect(shortenPath("")).toBe("");
  });

  test("handles relative paths without modification", () => {
    expect(shortenPath("relative/path")).toBe("relative/path");
  });

  test("handles usernames with hyphens and underscores", () => {
    expect(shortenPath("/home/my-user_name/work")).toBe("~/work");
  });
});

describe("STATUS_CONFIG", () => {
  const ALL_STATUSES = [
    "starting",
    "working",
    "awaiting_input",
    "action_required",
    "idle",
    "done",
    "error",
    "exited",
  ] as const;

  test("has an entry for every SessionStatus value", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_CONFIG[status]).toBeDefined();
    }
  });

  test("every entry has the required StatusStyle fields", () => {
    for (const status of ALL_STATUSES) {
      const style = STATUS_CONFIG[status];
      expect(typeof style.label).toBe("string");
      expect(typeof style.color).toBe("string");
      expect(typeof style.bg).toBe("string");
      expect(typeof style.pulse).toBe("boolean");
    }
  });

  test("labels are human-readable and non-empty", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_CONFIG[status].label.length).toBeGreaterThan(0);
    }
  });

  test("colors are valid hex color strings", () => {
    const hexColorRegex = /^#[0-9a-fA-F]{6}$/;
    for (const status of ALL_STATUSES) {
      expect(STATUS_CONFIG[status].color).toMatch(hexColorRegex);
      expect(STATUS_CONFIG[status].bg).toMatch(hexColorRegex);
    }
  });

  test("active statuses pulse and inactive statuses do not", () => {
    expect(STATUS_CONFIG.starting.pulse).toBe(true);
    expect(STATUS_CONFIG.working.pulse).toBe(true);
    expect(STATUS_CONFIG.action_required.pulse).toBe(true);
    expect(STATUS_CONFIG.error.pulse).toBe(true);
    expect(STATUS_CONFIG.exited.pulse).toBe(true);

    expect(STATUS_CONFIG.awaiting_input.pulse).toBe(false);
    expect(STATUS_CONFIG.idle.pulse).toBe(false);
    expect(STATUS_CONFIG.done.pulse).toBe(false);
  });

  test("has correct labels for each status", () => {
    expect(STATUS_CONFIG.starting.label).toBe("Starting");
    expect(STATUS_CONFIG.working.label).toBe("Working");
    expect(STATUS_CONFIG.awaiting_input.label).toBe("Awaiting Input");
    expect(STATUS_CONFIG.action_required.label).toBe("Action Required");
    expect(STATUS_CONFIG.idle.label).toBe("Idle");
    expect(STATUS_CONFIG.done.label).toBe("Done");
    expect(STATUS_CONFIG.error.label).toBe("Error");
    expect(STATUS_CONFIG.exited.label).toBe("Exited");
  });
});

describe("API", () => {
  test("SETTINGS endpoint is correct", () => {
    expect(API.SETTINGS).toBe("/api/settings");
  });

  test("MACHINES endpoint is correct", () => {
    expect(API.MACHINES).toBe("/api/machines");
  });

  test("SESSION_MESSAGES endpoint is correct", () => {
    expect(API.SESSION_MESSAGES).toBe("/api/session-messages");
  });

  test("SESSIONS_RENAME endpoint is correct", () => {
    expect(API.SESSIONS_RENAME).toBe("/api/sessions/rename");
  });

  test("SESSIONS_KILL endpoint is correct", () => {
    expect(API.SESSIONS_KILL).toBe("/api/sessions/kill");
  });

  test("SESSIONS_DELETE endpoint is correct", () => {
    expect(API.SESSIONS_DELETE).toBe("/api/sessions/delete");
  });

  test("SESSIONS_SEND endpoint is correct", () => {
    expect(API.SESSIONS_SEND).toBe("/api/sessions/send");
  });

  test("AGENTS_LAUNCH endpoint is correct", () => {
    expect(API.AGENTS_LAUNCH).toBe("/api/agents/launch");
  });

  test("AGENTS_RESUME endpoint is correct", () => {
    expect(API.AGENTS_RESUME).toBe("/api/agents/resume");
  });

  test("SESSIONS_RECONNECT endpoint is correct", () => {
    expect(API.SESSIONS_RECONNECT).toBe("/api/sessions/reconnect");
  });

  test("NODES endpoint is correct", () => {
    expect(API.NODES).toBe("/api/nodes");
  });

  test("NODES_TEST endpoint is correct", () => {
    expect(API.NODES_TEST).toBe("/api/nodes/test");
  });

  test("GIT_DIFF endpoint is correct", () => {
    expect(API.GIT_DIFF).toBe("/api/git-diff");
  });

  test("all endpoints start with /api/", () => {
    for (const value of Object.values(API)) {
      expect(value).toMatch(/^\/api\//);
    }
  });

  test("contains exactly 15 endpoints", () => {
    expect(Object.keys(API)).toHaveLength(15);
  });
});
