import { describe, expect, test } from "bun:test";
import { buildShellCommand, shellEscape } from "./shell";

describe("shellEscape", () => {
  test("returns safe strings unquoted", () => {
    expect(shellEscape("claude")).toBe("claude");
    expect(shellEscape("--model")).toBe("--model");
    expect(shellEscape("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(shellEscape("anthropic/claude-3")).toBe("anthropic/claude-3");
    expect(shellEscape("/home/user/project")).toBe("/home/user/project");
  });

  test("wraps strings with spaces in single quotes", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  test("wraps strings with shell metacharacters in single quotes", () => {
    expect(shellEscape("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(shellEscape("$(whoami)")).toBe("'$(whoami)'");
    expect(shellEscape("test`id`")).toBe("'test`id`'");
    expect(shellEscape("foo&bar")).toBe("'foo&bar'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("a>b")).toBe("'a>b'");
  });

  test("escapes single quotes within strings", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape("O'Brien")).toBe("'O'\\''Brien'");
  });

  test("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });
});

describe("buildShellCommand", () => {
  test("joins command parts with shell escaping", () => {
    const result = buildShellCommand(["claude", "--model", "claude-opus-4-6"]);
    expect(result).toBe("claude --model claude-opus-4-6");
  });

  test("escapes parts containing special characters", () => {
    const result = buildShellCommand(["claude", "--model", "model with spaces"]);
    expect(result).toBe("claude --model 'model with spaces'");
  });

  test("prepends cd when projectDir is provided", () => {
    const result = buildShellCommand(["claude"], "/home/user/project");
    expect(result).toBe("cd /home/user/project && claude");
  });

  test("escapes projectDir with special characters", () => {
    const result = buildShellCommand(["claude"], "/home/user/my project");
    expect(result).toBe("cd '/home/user/my project' && claude");
  });
});
