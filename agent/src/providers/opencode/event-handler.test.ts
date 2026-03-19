import { describe, expect, test } from "bun:test";

import { handleOpenCodeEvent, isSSEActive } from "./event-handler";

/**
 * Tests for event-handler.ts
 *
 * Covers:
 * - handleOpenCodeEvent: edge cases and event types NOT covered by opencode.test.ts
 * - isSSEActive: exported boolean accessor
 *
 * Skipped:
 * - startOpenCodeEventStream: async with SSE network I/O (requires live OpenCode server)
 * - mapSSEEvent: private function, not exported (indirectly tested via startOpenCodeEventStream)
 */

// --- handleOpenCodeEvent: event types not covered in opencode.test.ts ---

describe("handleOpenCodeEvent edge cases", () => {
  describe("uncovered event types", () => {
    test("handles message.updated as working", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_abc",
        event_type: "message.updated",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "ses_abc",
        status: "working",
        currentTool: undefined,
      });
    });

    test("handles permission.replied as working", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_abc",
        event_type: "permission.replied",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "ses_abc",
        status: "working",
        currentTool: undefined,
      });
    });

    test("handles tool.execute.before without tool_name", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_abc",
        event_type: "tool.execute.before",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "ses_abc",
        status: "working",
        currentTool: undefined,
      });
    });
  });

  describe("invalid payload shapes", () => {
    test("returns null for undefined", () => {
      expect(handleOpenCodeEvent(undefined)).toBeNull();
    });

    test("returns null for a number", () => {
      expect(handleOpenCodeEvent(42)).toBeNull();
    });

    test("returns null for a string", () => {
      expect(handleOpenCodeEvent("session.idle")).toBeNull();
    });

    test("returns null for a boolean", () => {
      expect(handleOpenCodeEvent(true)).toBeNull();
    });

    test("returns null for an array", () => {
      expect(
        handleOpenCodeEvent([
          {
            session_id: "ses_abc",
            event_type: "session.idle",
            agent_type: "opencode",
          },
        ]),
      ).toBeNull();
    });
  });

  describe("missing or wrong-typed fields", () => {
    test("returns null when agent_type is missing", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "ses_abc",
          event_type: "session.idle",
        }),
      ).toBeNull();
    });

    test("returns null when agent_type is not opencode", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "ses_abc",
          event_type: "session.idle",
          agent_type: "claude-code",
        }),
      ).toBeNull();
    });

    test("returns null when session_id is missing entirely", () => {
      expect(
        handleOpenCodeEvent({
          event_type: "session.idle",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null when event_type is missing entirely", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "ses_abc",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null when session_id is a number instead of string", () => {
      expect(
        handleOpenCodeEvent({
          session_id: 123,
          event_type: "session.idle",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null when event_type is a number instead of string", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "ses_abc",
          event_type: 42,
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null when agent_type is a number instead of string", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "ses_abc",
          event_type: "session.idle",
          agent_type: 1,
        }),
      ).toBeNull();
    });
  });

  describe("extra fields do not interfere", () => {
    test("ignores unrecognized extra properties", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_xyz",
        event_type: "session.idle",
        agent_type: "opencode",
        extra_field: "should be ignored",
        nested: { deep: true },
      });
      expect(result).toEqual({
        sessionId: "ses_xyz",
        status: "awaiting_input",
        currentTool: undefined,
      });
    });

    test("tool.execute.after ignores tool_name if present", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_abc",
        event_type: "tool.execute.after",
        agent_type: "opencode",
        tool_name: "bash",
      });
      // tool_name is only captured on tool.execute.before, not after
      expect(result).toEqual({
        sessionId: "ses_abc",
        status: "working",
        currentTool: undefined,
      });
    });
  });

  describe("session_id variations", () => {
    test("works with standard opencode session ID format", () => {
      const result = handleOpenCodeEvent({
        session_id: "ses_30163a6c1ffeYDGuDOrp0nH9vG",
        event_type: "session.created",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "ses_30163a6c1ffeYDGuDOrp0nH9vG",
        status: "awaiting_input",
        currentTool: undefined,
      });
    });

    test("works with UUID-style session ID", () => {
      const result = handleOpenCodeEvent({
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        event_type: "session.error",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "error",
        currentTool: undefined,
      });
    });

    test("works with minimal single-character session ID", () => {
      const result = handleOpenCodeEvent({
        session_id: "x",
        event_type: "session.deleted",
        agent_type: "opencode",
      });
      expect(result).toEqual({
        sessionId: "x",
        status: "done",
        currentTool: undefined,
      });
    });
  });

  describe("status mapping completeness", () => {
    test("session.created maps to awaiting_input", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "session.created",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("awaiting_input");
    });

    test("session.idle maps to awaiting_input", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "session.idle",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("awaiting_input");
    });

    test("session.deleted maps to done", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "session.deleted",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("done");
    });

    test("session.error maps to error", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "session.error",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("error");
    });

    test("tool.execute.before maps to working", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "tool.execute.before",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("working");
    });

    test("tool.execute.after maps to working", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "tool.execute.after",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("working");
    });

    test("message.updated maps to working", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "message.updated",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("working");
    });

    test("permission.asked maps to action_required", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "permission.asked",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("action_required");
    });

    test("permission.replied maps to working", () => {
      const result = handleOpenCodeEvent({
        session_id: "s",
        event_type: "permission.replied",
        agent_type: "opencode",
      });
      expect(result?.status).toBe("working");
    });
  });

  describe("unknown and edge-case event types", () => {
    test("returns null for event type with similar prefix", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "s",
          event_type: "session.updated",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null for event type with wrong casing", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "s",
          event_type: "Session.Idle",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null for empty event_type", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "s",
          event_type: "",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });

    test("returns null for event type with trailing whitespace", () => {
      expect(
        handleOpenCodeEvent({
          session_id: "s",
          event_type: "session.idle ",
          agent_type: "opencode",
        }),
      ).toBeNull();
    });
  });
});

// --- isSSEActive ---

describe("isSSEActive", () => {
  test("returns false by default when no stream has been started", () => {
    expect(isSSEActive()).toBe(false);
  });

  test("returns a boolean value", () => {
    expect(typeof isSSEActive()).toBe("boolean");
  });
});

// --- startOpenCodeEventStream ---
// Skipped: requires a live OpenCode server with SSE support.
// It uses getOpenCodeClient() which connects to http://127.0.0.1:4096,
// then subscribes to client.event.subscribe() for SSE streaming.
// Integration testing would require mocking the SDK client.
