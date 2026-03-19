import { describe, expect, test } from "bun:test";

import { extractOpenCodeSessionIdFromArgs } from "./process-mapper";

describe("extractOpenCodeSessionIdFromArgs", () => {
  describe("with --session flag", () => {
    test("extracts session ID after --session", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session ses_abc123")).toBe("ses_abc123");
    });

    test("extracts session ID when --session is at the end of args", () => {
      expect(extractOpenCodeSessionIdFromArgs("--session ses_end")).toBe("ses_end");
    });

    test("extracts session ID with full binary path", () => {
      expect(extractOpenCodeSessionIdFromArgs("/usr/local/bin/opencode --session ses_xyz789")).toBe("ses_xyz789");
    });

    test("extracts session ID when other flags precede --session", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --model gpt-4 --session ses_after")).toBe("ses_after");
    });

    test("extracts session ID when other flags follow --session", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session ses_before --model anthropic/claude-opus-4-6")).toBe(
        "ses_before",
      );
    });

    test("extracts session ID with multiple spaces between flag and value", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session   ses_spaces")).toBe("ses_spaces");
    });
  });

  describe("with -s flag", () => {
    test("extracts session ID after -s", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode -s ses_short")).toBe("ses_short");
    });

    test("extracts session ID from -s with full binary path", () => {
      expect(extractOpenCodeSessionIdFromArgs("/home/user/.local/bin/opencode -s ses_path")).toBe("ses_path");
    });

    test("extracts session ID from -s when other flags are present", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --model gpt-4 -s ses_mixed")).toBe("ses_mixed");
    });

    test("extracts session ID from -s with multiple spaces", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode -s    ses_multi")).toBe("ses_multi");
    });
  });

  describe("returns undefined for missing session flag", () => {
    test("returns undefined for bare opencode command", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode")).toBeUndefined();
    });

    test("returns undefined when no session flag is present", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --model gpt-4 --verbose")).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
      expect(extractOpenCodeSessionIdFromArgs("")).toBeUndefined();
    });

    test("returns undefined for unrelated command with session-like text", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --sessions ses_abc123")).toBeUndefined();
    });

    test("returns undefined when flag is missing value", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session")).toBeUndefined();
    });

    test("returns undefined when -s flag is missing value", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode -s")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("handles session ID with underscores and alphanumeric chars", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session ses_30163a6c1ffeYDGuDOrp0nH9vG")).toBe(
        "ses_30163a6c1ffeYDGuDOrp0nH9vG",
      );
    });

    test("handles session ID with hyphens", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session my-session-id")).toBe("my-session-id");
    });

    test("extracts only the first session ID when --session appears twice", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session ses_first --session ses_second")).toBe("ses_first");
    });

    test("does not match --session embedded in another flag name", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --no-session ses_none")).toBeUndefined();
    });

    test("handles tab characters between flag and value", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode --session\tses_tab")).toBe("ses_tab");
    });

    test("does not confuse -session (single dash, long name) with valid flags", () => {
      expect(extractOpenCodeSessionIdFromArgs("opencode -session ses_invalid")).toBeUndefined();
    });
  });
});
