import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionInfo, SessionStatus } from "@agent-town/shared";
import {
  filterRawSessionsByStatus,
  filterSessionsByStatus,
  loadStatusFilters,
  saveStatusFilters,
  toggleStatusFilter,
} from "./status-filter";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "test-session",
    agentType: "claude-code",
    slug: "test",
    projectPath: "/tmp/project",
    projectName: "project",
    gitBranch: "main",
    status: "idle",
    lastActivity: new Date().toISOString(),
    lastMessage: "",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("toggleStatusFilter", () => {
  test("adds a status to an empty set", () => {
    const result = toggleStatusFilter(new Set(), "working");
    expect(result.has("working")).toBe(true);
    expect(result.size).toBe(1);
  });

  test("removes a status that is already in the set", () => {
    const result = toggleStatusFilter(new Set(["working"] as SessionStatus[]), "working");
    expect(result.has("working")).toBe(false);
    expect(result.size).toBe(0);
  });

  test("adds a second status to an existing set", () => {
    const result = toggleStatusFilter(new Set(["working"] as SessionStatus[]), "idle");
    expect(result.has("working")).toBe(true);
    expect(result.has("idle")).toBe(true);
    expect(result.size).toBe(2);
  });

  test("removes one status from a multi-status set", () => {
    const initial = new Set(["working", "idle", "error"] as SessionStatus[]);
    const result = toggleStatusFilter(initial, "idle");
    expect(result.has("working")).toBe(true);
    expect(result.has("idle")).toBe(false);
    expect(result.has("error")).toBe(true);
    expect(result.size).toBe(2);
  });

  test("does not mutate the original set", () => {
    const original = new Set(["working"] as SessionStatus[]);
    toggleStatusFilter(original, "idle");
    expect(original.size).toBe(1);
    expect(original.has("working")).toBe(true);
  });

  test("toggling the same status twice returns to original state", () => {
    const original = new Set(["idle"] as SessionStatus[]);
    const afterAdd = toggleStatusFilter(original, "working");
    const afterRemove = toggleStatusFilter(afterAdd, "working");
    expect(afterRemove.size).toBe(1);
    expect(afterRemove.has("idle")).toBe(true);
    expect(afterRemove.has("working")).toBe(false);
  });
});

describe("filterSessionsByStatus", () => {
  const sessions = [
    { machineId: "m1", session: makeSession({ sessionId: "s1", status: "working" }) },
    { machineId: "m1", session: makeSession({ sessionId: "s2", status: "idle" }) },
    { machineId: "m2", session: makeSession({ sessionId: "s3", status: "error" }) },
    { machineId: "m2", session: makeSession({ sessionId: "s4", status: "working" }) },
    { machineId: "m3", session: makeSession({ sessionId: "s5", status: "awaiting_input" }) },
  ];

  test("returns all sessions when filter set is empty", () => {
    const result = filterSessionsByStatus(sessions, new Set());
    expect(result.length).toBe(5);
  });

  test("filters to single status", () => {
    const result = filterSessionsByStatus(sessions, new Set(["working"] as SessionStatus[]));
    expect(result.length).toBe(2);
    expect(result.every(({ session }) => session.status === "working")).toBe(true);
  });

  test("filters to multiple statuses", () => {
    const result = filterSessionsByStatus(sessions, new Set(["working", "error"] as SessionStatus[]));
    expect(result.length).toBe(3);
    expect(result.every(({ session }) => session.status === "working" || session.status === "error")).toBe(true);
  });

  test("returns empty array when no sessions match filter", () => {
    const result = filterSessionsByStatus(sessions, new Set(["done"] as SessionStatus[]));
    expect(result.length).toBe(0);
  });

  test("preserves session order", () => {
    const result = filterSessionsByStatus(sessions, new Set(["working"] as SessionStatus[]));
    expect(result[0].session.sessionId).toBe("s1");
    expect(result[1].session.sessionId).toBe("s4");
  });

  test("returns empty array when input is empty", () => {
    const result = filterSessionsByStatus([], new Set(["working"] as SessionStatus[]));
    expect(result.length).toBe(0);
  });

  test("returns empty array when input is empty and filter is empty", () => {
    const result = filterSessionsByStatus([], new Set());
    expect(result.length).toBe(0);
  });
});

describe("filterRawSessionsByStatus", () => {
  const sessions = [
    makeSession({ sessionId: "s1", status: "working" }),
    makeSession({ sessionId: "s2", status: "idle" }),
    makeSession({ sessionId: "s3", status: "error" }),
  ];

  test("returns all sessions when filter set is empty", () => {
    const result = filterRawSessionsByStatus(sessions, new Set());
    expect(result.length).toBe(3);
  });

  test("filters to matching statuses", () => {
    const result = filterRawSessionsByStatus(sessions, new Set(["working", "error"] as SessionStatus[]));
    expect(result.length).toBe(2);
    expect(result[0].sessionId).toBe("s1");
    expect(result[1].sessionId).toBe("s3");
  });

  test("returns empty array when no sessions match", () => {
    const result = filterRawSessionsByStatus(sessions, new Set(["done"] as SessionStatus[]));
    expect(result.length).toBe(0);
  });

  test("filters to a single status", () => {
    const result = filterRawSessionsByStatus(sessions, new Set(["idle"] as SessionStatus[]));
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s2");
  });

  test("returns empty array when input is empty", () => {
    const result = filterRawSessionsByStatus([], new Set(["working"] as SessionStatus[]));
    expect(result.length).toBe(0);
  });

  test("returns empty array when input is empty and filter is empty", () => {
    const result = filterRawSessionsByStatus([], new Set());
    expect(result.length).toBe(0);
  });
});

describe("loadStatusFilters and saveStatusFilters", () => {
  const storageKey = "agentTown:explorerStatusFilters";
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    // Provide a minimal localStorage mock for Bun test environment
    const mockStorage = {
      getItem: (key: string): string | null => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    };
    (globalThis as Record<string, unknown>).localStorage = mockStorage;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  test("returns empty set when nothing is stored", () => {
    const result = loadStatusFilters();
    expect(result.size).toBe(0);
  });

  test("returns empty set when stored value is invalid JSON", () => {
    store[storageKey] = "not-json";
    const result = loadStatusFilters();
    expect(result.size).toBe(0);
  });

  test("returns empty set when stored value is not an array", () => {
    store[storageKey] = JSON.stringify({ key: "value" });
    const result = loadStatusFilters();
    expect(result.size).toBe(0);
  });

  test("ignores invalid status values in stored array", () => {
    store[storageKey] = JSON.stringify(["working", "bogus", 42, "error", null]);
    const result = loadStatusFilters();
    expect(result.size).toBe(2);
    expect(result.has("working")).toBe(true);
    expect(result.has("error")).toBe(true);
  });

  test("loads saved filters", () => {
    store[storageKey] = JSON.stringify(["working", "error"]);
    const result = loadStatusFilters();
    expect(result.size).toBe(2);
    expect(result.has("working")).toBe(true);
    expect(result.has("error")).toBe(true);
  });

  test("saveStatusFilters persists to localStorage", () => {
    const filters = new Set(["idle", "done"] as SessionStatus[]);
    saveStatusFilters(filters);
    const stored = store[storageKey];
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored);
    expect(parsed).toContain("idle");
    expect(parsed).toContain("done");
    expect(parsed.length).toBe(2);
  });

  test("round-trip: save then load returns same filters", () => {
    const original = new Set(["working", "awaiting_input", "error"] as SessionStatus[]);
    saveStatusFilters(original);
    const loaded = loadStatusFilters();
    expect(loaded.size).toBe(3);
    expect(loaded.has("working")).toBe(true);
    expect(loaded.has("awaiting_input")).toBe(true);
    expect(loaded.has("error")).toBe(true);
  });

  test("saving empty set clears the filter", () => {
    saveStatusFilters(new Set(["working"] as SessionStatus[]));
    saveStatusFilters(new Set());
    const loaded = loadStatusFilters();
    expect(loaded.size).toBe(0);
  });

  test("returns empty set when stored array is empty", () => {
    store[storageKey] = JSON.stringify([]);
    const result = loadStatusFilters();
    expect(result.size).toBe(0);
  });

  test("deduplicates stored values", () => {
    store[storageKey] = JSON.stringify(["working", "working", "error"]);
    const result = loadStatusFilters();
    expect(result.size).toBe(2);
    expect(result.has("working")).toBe(true);
    expect(result.has("error")).toBe(true);
  });

  test("loads all valid status types", () => {
    const allStatuses: SessionStatus[] = [
      "starting",
      "working",
      "awaiting_input",
      "action_required",
      "idle",
      "done",
      "error",
      "exited",
    ];
    saveStatusFilters(new Set(allStatuses));
    const loaded = loadStatusFilters();
    expect(loaded.size).toBe(8);
    for (const status of allStatuses) {
      expect(loaded.has(status)).toBe(true);
    }
  });

  test("saveStatusFilters handles localStorage setItem throwing", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    // Should not throw
    expect(() => saveStatusFilters(new Set(["working"] as SessionStatus[]))).not.toThrow();
  });

  test("loadStatusFilters handles localStorage getItem throwing", () => {
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    const result = loadStatusFilters();
    expect(result.size).toBe(0);
  });
});
