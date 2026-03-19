import { describe, expect, test } from "bun:test";
import { handleClaudeHookEvent } from "./hook-handler";

/** Factory helper: build a minimal valid Claude hook event payload. */
function makeHookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    hook_event_name: "Stop",
    ...overrides,
  };
}

describe("handleClaudeHookEvent", () => {
  describe("invalid payloads return null", () => {
    test("null payload", () => {
      expect(handleClaudeHookEvent(null)).toBeNull();
    });

    test("undefined payload", () => {
      expect(handleClaudeHookEvent(undefined)).toBeNull();
    });

    test("numeric payload", () => {
      expect(handleClaudeHookEvent(42)).toBeNull();
    });

    test("string payload", () => {
      expect(handleClaudeHookEvent("not an object")).toBeNull();
    });

    test("boolean payload", () => {
      expect(handleClaudeHookEvent(true)).toBeNull();
    });

    test("array payload", () => {
      expect(handleClaudeHookEvent([1, 2, 3])).toBeNull();
    });

    test("empty object (missing required fields)", () => {
      expect(handleClaudeHookEvent({})).toBeNull();
    });

    test("missing session_id", () => {
      expect(handleClaudeHookEvent({ hook_event_name: "Stop" })).toBeNull();
    });

    test("missing hook_event_name", () => {
      expect(handleClaudeHookEvent({ session_id: "s1" })).toBeNull();
    });

    test("session_id is a number instead of string", () => {
      expect(handleClaudeHookEvent({ session_id: 123, hook_event_name: "Stop" })).toBeNull();
    });

    test("hook_event_name is a number instead of string", () => {
      expect(handleClaudeHookEvent({ session_id: "s1", hook_event_name: 456 })).toBeNull();
    });

    test("session_id is null", () => {
      expect(handleClaudeHookEvent({ session_id: null, hook_event_name: "Stop" })).toBeNull();
    });

    test("hook_event_name is null", () => {
      expect(handleClaudeHookEvent({ session_id: "s1", hook_event_name: null })).toBeNull();
    });

    test("session_id is an empty string", () => {
      expect(handleClaudeHookEvent(makeHookPayload({ session_id: "" }))).toBeNull();
    });
  });

  describe("UserPromptSubmit sets working status", () => {
    test("basic UserPromptSubmit", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "UserPromptSubmit" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: undefined,
      });
    });
  });

  describe("PreToolUse sets working status with tool name", () => {
    test("PreToolUse with tool_name", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PreToolUse", tool_name: "Bash" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: "Bash",
      });
    });

    test("PreToolUse without tool_name leaves currentTool undefined", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PreToolUse" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: undefined,
      });
    });

    test("PreToolUse with various tool names", () => {
      for (const toolName of ["Edit", "Read", "Write", "Grep", "Glob", "WebSearch"]) {
        const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PreToolUse", tool_name: toolName }));
        expect(result?.currentTool).toBe(toolName);
        expect(result?.status).toBe("working");
      }
    });
  });

  describe("PostToolUse sets working status and clears tool", () => {
    test("PostToolUse clears currentTool", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PostToolUse", tool_name: "Bash" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: undefined,
      });
    });

    test("PostToolUse without tool_name also works", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PostToolUse" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: undefined,
      });
    });
  });

  describe("PostToolUseFailure sets working status and clears tool", () => {
    test("PostToolUseFailure clears currentTool", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({ hook_event_name: "PostToolUseFailure", tool_name: "Bash" }),
      );
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "working",
        currentTool: undefined,
      });
    });

    test("PostToolUseFailure without tool_name", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PostToolUseFailure" }));
      expect(result?.status).toBe("working");
      expect(result?.currentTool).toBeUndefined();
    });
  });

  describe("Stop sets awaiting_input status", () => {
    test("Stop clears currentTool and sets awaiting_input", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "Stop" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "awaiting_input",
        currentTool: undefined,
      });
    });
  });

  describe("Notification maps status based on notification_type", () => {
    test("permission_prompt sets action_required", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
        }),
      );
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "action_required",
        currentTool: undefined,
      });
    });

    test("question sets action_required", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          hook_event_name: "Notification",
          notification_type: "question",
        }),
      );
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "action_required",
        currentTool: undefined,
      });
    });

    test("other notification_type sets awaiting_input", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          hook_event_name: "Notification",
          notification_type: "info",
        }),
      );
      expect(result?.status).toBe("awaiting_input");
    });

    test("missing notification_type sets awaiting_input", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "Notification" }));
      expect(result?.status).toBe("awaiting_input");
    });

    test("undefined notification_type sets awaiting_input", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          hook_event_name: "Notification",
          notification_type: undefined,
        }),
      );
      expect(result?.status).toBe("awaiting_input");
    });
  });

  describe("SessionStart sets awaiting_input status", () => {
    test("SessionStart returns awaiting_input", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "SessionStart" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "awaiting_input",
        currentTool: undefined,
      });
    });
  });

  describe("SessionEnd sets done status", () => {
    test("SessionEnd returns done and clears currentTool", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "SessionEnd" }));
      expect(result).toEqual({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        status: "done",
        currentTool: undefined,
      });
    });
  });

  describe("unknown hook_event_name defaults to awaiting_input", () => {
    test("unknown event name returns awaiting_input", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "SomeUnknownEvent" }));
      expect(result?.status).toBe("awaiting_input");
    });

    test("empty string hook_event_name returns awaiting_input", () => {
      // empty string passes the type guard (typeof === "string") but hits the default case
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "", session_id: "s1" }));
      // empty hook_event_name is still a valid string, so type guard passes but session_id
      // check passes too — hits default switch branch
      expect(result?.status).toBe("awaiting_input");
    });

    test("misspelled event name returns awaiting_input", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "userpromptsubmit" }));
      expect(result?.status).toBe("awaiting_input");
    });
  });

  describe("session ID passthrough", () => {
    test("preserves the original session_id as sessionId", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          session_id: "my-custom-session-id-123",
          hook_event_name: "Stop",
        }),
      );
      expect(result?.sessionId).toBe("my-custom-session-id-123");
    });

    test("handles UUID format session IDs", () => {
      const result = handleClaudeHookEvent(
        makeHookPayload({
          session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          hook_event_name: "SessionStart",
        }),
      );
      expect(result?.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    });
  });

  describe("extra fields in payload are ignored", () => {
    test("payload with extra fields still works", () => {
      const result = handleClaudeHookEvent({
        session_id: "s1",
        hook_event_name: "Stop",
        extra_field: "some value",
        another_field: 42,
        nested: { deep: true },
      });
      expect(result).toEqual({
        sessionId: "s1",
        status: "awaiting_input",
        currentTool: undefined,
      });
    });
  });

  describe("return value shape", () => {
    test("result always includes sessionId, status, and currentTool", () => {
      const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "SessionStart" }));
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("sessionId");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("currentTool");
    });

    test("currentTool is defined only for PreToolUse", () => {
      const withTool = handleClaudeHookEvent(makeHookPayload({ hook_event_name: "PreToolUse", tool_name: "Read" }));
      expect(withTool?.currentTool).toBe("Read");

      const events = [
        "UserPromptSubmit",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "Notification",
        "SessionStart",
        "SessionEnd",
      ];
      for (const eventName of events) {
        const result = handleClaudeHookEvent(makeHookPayload({ hook_event_name: eventName }));
        expect(result?.currentTool).toBeUndefined();
      }
    });
  });
});
