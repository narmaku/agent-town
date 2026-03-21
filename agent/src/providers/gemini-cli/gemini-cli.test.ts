import { describe, expect, test } from "bun:test";
import { filterProcessesByBinary } from "../utils";
import { GeminiCliProvider } from "./index";
import { formatGeminiMessage } from "./message-parser";
import { extractGeminiSessionIdFromArgs } from "./process-mapper";
import type { GeminiMessage } from "./session-discovery";
import { extractTextContent } from "./session-discovery";

// --- Provider tests ---

describe("GeminiCliProvider", () => {
  const provider = new GeminiCliProvider();

  test("has correct type and display name", () => {
    expect(provider.type).toBe("gemini-cli");
    expect(provider.displayName).toBe("Gemini CLI");
    expect(provider.binaryName).toBe("gemini");
  });

  test("buildLaunchCommand with defaults returns array", () => {
    const parts = provider.buildLaunchCommand({});
    expect(parts).toEqual(["gemini"]);
  });

  test("buildLaunchCommand with model returns array with flag and value", () => {
    const parts = provider.buildLaunchCommand({ model: "gemini-2.5-pro" });
    expect(parts).toEqual(["gemini", "--model", "gemini-2.5-pro"]);
  });

  test("buildLaunchCommand with autonomous returns yolo flag", () => {
    const parts = provider.buildLaunchCommand({ autonomous: true });
    expect(parts).toEqual(["gemini", "--yolo"]);
  });

  test("buildLaunchCommand with model and autonomous", () => {
    const parts = provider.buildLaunchCommand({ model: "gemini-2.5-flash", autonomous: true });
    expect(parts).toEqual(["gemini", "--model", "gemini-2.5-flash", "--yolo"]);
  });

  test("buildResumeCommand with session ID returns array", () => {
    const parts = provider.buildResumeCommand({ sessionId: "4460d17e-9539-42da-a3e6-084cb7a932d6" });
    expect(parts).toEqual(["gemini", "--resume", "4460d17e-9539-42da-a3e6-084cb7a932d6"]);
  });

  test("buildResumeCommand with model and autonomous", () => {
    const parts = provider.buildResumeCommand({
      sessionId: "4460d17e-9539-42da-a3e6-084cb7a932d6",
      model: "gemini-2.5-pro",
      autonomous: true,
    });
    expect(parts).toEqual([
      "gemini",
      "--resume",
      "4460d17e-9539-42da-a3e6-084cb7a932d6",
      "--model",
      "gemini-2.5-pro",
      "--yolo",
    ]);
  });

  test("handleHookEvent always returns null (no hook support)", () => {
    expect(provider.handleHookEvent(null)).toBeNull();
    expect(provider.handleHookEvent({})).toBeNull();
    expect(provider.handleHookEvent({ session_id: "s1" })).toBeNull();
  });

  test("filterAgentProcesses filters only gemini binaries", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 100, args: "/usr/bin/gemini --resume abc" },
      { pid: 2, ppid: 0, etimes: 200, args: "claude --resume xyz" },
      { pid: 3, ppid: 0, etimes: 50, args: "gemini" },
      { pid: 4, ppid: 0, etimes: 300, args: "/home/user/.local/bin/node" },
      { pid: 5, ppid: 0, etimes: 150, args: "opencode --session ses_abc" },
    ];
    const result = provider.filterAgentProcesses(processes);
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(1);
    expect(result[1].pid).toBe(3);
  });
});

// --- Process mapper tests ---

describe("extractGeminiSessionIdFromArgs", () => {
  test("extracts UUID from --resume flag", () => {
    expect(extractGeminiSessionIdFromArgs("gemini --resume 4460d17e-9539-42da-a3e6-084cb7a932d6")).toBe(
      "4460d17e-9539-42da-a3e6-084cb7a932d6",
    );
  });

  test("extracts UUID from -r flag", () => {
    expect(extractGeminiSessionIdFromArgs("gemini -r 4460d17e-9539-42da-a3e6-084cb7a932d6")).toBe(
      "4460d17e-9539-42da-a3e6-084cb7a932d6",
    );
  });

  test("returns undefined without --resume flag", () => {
    expect(extractGeminiSessionIdFromArgs("gemini")).toBeUndefined();
  });

  test("returns undefined for numeric index (not a UUID)", () => {
    expect(extractGeminiSessionIdFromArgs("gemini --resume 5")).toBeUndefined();
  });

  test("returns undefined for 'latest' (not a UUID)", () => {
    expect(extractGeminiSessionIdFromArgs("gemini --resume latest")).toBeUndefined();
  });

  test("extracts UUID with other flags present", () => {
    expect(
      extractGeminiSessionIdFromArgs(
        "/usr/bin/gemini --resume 550e8400-e29b-41d4-a716-446655440000 --model gemini-2.5-pro",
      ),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("extracts short hash prefix (8 hex chars)", () => {
    expect(extractGeminiSessionIdFromArgs("gemini --resume 4460d17e")).toBe("4460d17e");
  });
});

// --- filterProcessesByBinary (gemini) ---

describe("filterProcessesByBinary (gemini)", () => {
  test("filters only gemini binaries", () => {
    const processes = [
      { pid: 1, ppid: 0, etimes: 100, args: "/usr/bin/gemini --resume abc" },
      { pid: 2, ppid: 0, etimes: 200, args: "claude --resume xyz" },
      { pid: 3, ppid: 0, etimes: 50, args: "gemini" },
      { pid: 4, ppid: 0, etimes: 300, args: "/home/user/.local/bin/node" },
    ];
    const result = filterProcessesByBinary(processes, "gemini");
    expect(result).toHaveLength(2);
    expect(result[0].pid).toBe(1);
    expect(result[1].pid).toBe(3);
  });

  test("does not match node processes", () => {
    const processes = [{ pid: 1, ppid: 0, etimes: 100, args: "node /path/to/gemini.js" }];
    const result = filterProcessesByBinary(processes, "gemini");
    expect(result).toHaveLength(0);
  });
});

// --- extractTextContent tests ---

describe("extractTextContent", () => {
  test("extracts text from string content", () => {
    expect(extractTextContent("Hello world")).toBe("Hello world");
  });

  test("extracts text from array content with text blocks", () => {
    const content = [{ text: "Hello" }, { text: "world" }];
    expect(extractTextContent(content)).toBe("Hello\n\nworld");
  });

  test("returns empty string for null/undefined", () => {
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });

  test("returns empty string for non-text array blocks", () => {
    expect(extractTextContent([{ image: "data:..." }])).toBe("");
  });

  test("handles mixed array content", () => {
    const content = [{ text: "Hello" }, { image: "data" }, { text: "world" }];
    expect(extractTextContent(content)).toBe("Hello\n\nworld");
  });
});

// --- Message parser tests ---

describe("formatGeminiMessage", () => {
  test("formats user message with array content", () => {
    const msg: GeminiMessage = {
      id: "msg-1",
      timestamp: "2026-02-18T01:14:37.288Z",
      type: "user",
      content: [{ text: "Hello, Gemini!" }],
    };
    const result = formatGeminiMessage(msg);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello, Gemini!");
    expect(result.timestamp).toBe("2026-02-18T01:14:37.288Z");
    expect(result.toolUse).toBeUndefined();
    expect(result.thinking).toBeUndefined();
  });

  test("formats gemini message with string content", () => {
    const msg: GeminiMessage = {
      id: "msg-2",
      timestamp: "2026-02-18T01:14:55.557Z",
      type: "gemini",
      content: "I will help you with that task.",
      model: "gemini-3-pro-preview",
    };
    const result = formatGeminiMessage(msg);
    expect(result.role).toBe("assistant");
    expect(result.content).toBe("I will help you with that task.");
    expect(result.model).toBe("gemini-3-pro-preview");
  });

  test("formats gemini message with thoughts", () => {
    const msg: GeminiMessage = {
      id: "msg-3",
      timestamp: "2026-02-18T01:14:55.557Z",
      type: "gemini",
      content: "Let me think about this.",
      thoughts: [
        {
          subject: "Analyzing the problem",
          description: "I need to understand the requirements first.",
          timestamp: "2026-02-18T01:14:40.000Z",
        },
        {
          subject: "Planning the solution",
          description: "I will create a step-by-step plan.",
          timestamp: "2026-02-18T01:14:43.000Z",
        },
      ],
    };
    const result = formatGeminiMessage(msg);
    expect(result.thinking).toBe(
      "**Analyzing the problem**: I need to understand the requirements first.\n\n**Planning the solution**: I will create a step-by-step plan.",
    );
  });

  test("formats gemini message with tool calls", () => {
    const msg: GeminiMessage = {
      id: "msg-4",
      timestamp: "2026-02-18T01:15:23.617Z",
      type: "gemini",
      content: "Let me check the environment.",
      toolCalls: [
        {
          id: "tool-1",
          name: "run_shell_command",
          args: { command: "python3 --version" },
          result: [
            {
              functionResponse: {
                id: "tool-1",
                name: "run_shell_command",
                response: { output: "Python 3.13.11" },
              },
            },
          ],
          status: "success",
          timestamp: "2026-02-18T01:15:23.617Z",
          resultDisplay: "Python 3.13.11",
          displayName: "Shell",
        },
      ],
    };
    const result = formatGeminiMessage(msg);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse?.[0].name).toBe("Shell");
    expect(result.toolUse?.[0].id).toBe("tool-1");
    expect(result.toolUse?.[0].input).toContain("python3 --version");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults?.[0].content).toBe("Python 3.13.11");
  });

  test("formats gemini message with tool call using functionResponse fallback", () => {
    const msg: GeminiMessage = {
      id: "msg-5",
      timestamp: "2026-02-18T01:15:23.617Z",
      type: "gemini",
      content: "Checking git status.",
      toolCalls: [
        {
          id: "tool-2",
          name: "run_shell_command",
          args: { command: "git status" },
          result: [
            {
              functionResponse: {
                id: "tool-2",
                name: "run_shell_command",
                response: { output: "On branch main\nnothing to commit" },
              },
            },
          ],
          status: "success",
          timestamp: "2026-02-18T01:15:25.000Z",
        },
      ],
    };
    const result = formatGeminiMessage(msg);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse?.[0].name).toBe("run_shell_command");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults?.[0].content).toContain("On branch main");
  });

  test("formats gemini message with multiple tool calls", () => {
    const msg: GeminiMessage = {
      id: "msg-6",
      timestamp: "2026-02-18T01:20:00.000Z",
      type: "gemini",
      content: "Running multiple commands.",
      toolCalls: [
        {
          id: "tool-a",
          name: "run_shell_command",
          args: { command: "ls" },
          resultDisplay: "file1.txt\nfile2.txt",
          status: "success",
          timestamp: "2026-02-18T01:20:01.000Z",
          displayName: "Shell",
        },
        {
          id: "tool-b",
          name: "write_file",
          args: { path: "test.txt", content: "hello" },
          status: "success",
          timestamp: "2026-02-18T01:20:02.000Z",
          displayName: "Write",
        },
      ],
    };
    const result = formatGeminiMessage(msg);
    expect(result.toolUse).toHaveLength(2);
    expect(result.toolUse?.[0].name).toBe("Shell");
    expect(result.toolUse?.[1].name).toBe("Write");
    expect(result.toolResults).toHaveLength(1); // Only the one with resultDisplay
    expect(result.toolResults?.[0].content).toBe("file1.txt\nfile2.txt");
  });

  test("handles message with empty content", () => {
    const msg: GeminiMessage = {
      id: "msg-7",
      timestamp: "2026-02-18T01:00:00.000Z",
      type: "gemini",
      content: "",
    };
    const result = formatGeminiMessage(msg);
    expect(result.content).toBe("");
    expect(result.toolUse).toBeUndefined();
  });

  test("handles info messages as assistant role", () => {
    const msg: GeminiMessage = {
      id: "msg-8",
      timestamp: "2026-02-18T01:00:00.000Z",
      type: "info" as "user" | "gemini" | "info",
      content: "Update available.",
    };
    const result = formatGeminiMessage(msg);
    expect(result.role).toBe("assistant");
    expect(result.content).toBe("Update available.");
  });

  test("handles tool call without result", () => {
    const msg: GeminiMessage = {
      id: "msg-9",
      timestamp: "2026-02-18T01:00:00.000Z",
      type: "gemini",
      content: "Executing command.",
      toolCalls: [
        {
          id: "tool-c",
          name: "run_shell_command",
          args: { command: "sleep 100" },
          status: "pending",
          timestamp: "2026-02-18T01:00:01.000Z",
        },
      ],
    };
    const result = formatGeminiMessage(msg);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolResults).toBeUndefined();
  });

  test("handles user message with displayContent", () => {
    const msg: GeminiMessage = {
      id: "msg-10",
      timestamp: "2026-02-18T01:00:00.000Z",
      type: "user",
      content: [{ text: "Build a hello world app" }],
      displayContent: [{ text: "Build a hello world app\n" }],
    };
    const result = formatGeminiMessage(msg);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Build a hello world app");
  });
});
