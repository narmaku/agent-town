import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code/index";
import { GeminiCliProvider } from "./gemini-cli/index";
import { OpenCodeProvider } from "./opencode/index";
import { clearProviders, getAllProviders, getProvider, registerProvider } from "./registry";

describe("provider registry", () => {
  afterEach(() => {
    clearProviders();
  });

  test("starts empty", () => {
    expect(getAllProviders()).toHaveLength(0);
  });

  test("registers and retrieves a provider", () => {
    const provider = new ClaudeCodeProvider();
    registerProvider(provider);

    expect(getProvider("claude-code")).toBe(provider);
    expect(getAllProviders()).toHaveLength(1);
  });

  test("registers multiple providers", () => {
    registerProvider(new ClaudeCodeProvider());
    registerProvider(new OpenCodeProvider());

    expect(getAllProviders()).toHaveLength(2);
    expect(getProvider("claude-code")).toBeDefined();
    expect(getProvider("opencode")).toBeDefined();
  });

  test("registers all three providers", () => {
    registerProvider(new ClaudeCodeProvider());
    registerProvider(new OpenCodeProvider());
    registerProvider(new GeminiCliProvider());

    expect(getAllProviders()).toHaveLength(3);
    expect(getProvider("claude-code")).toBeDefined();
    expect(getProvider("opencode")).toBeDefined();
    expect(getProvider("gemini-cli")).toBeDefined();
  });

  test("returns undefined for unregistered type", () => {
    expect(getProvider("claude-code")).toBeUndefined();
  });

  test("clearProviders removes all", () => {
    registerProvider(new ClaudeCodeProvider());
    registerProvider(new OpenCodeProvider());
    registerProvider(new GeminiCliProvider());
    expect(getAllProviders()).toHaveLength(3);

    clearProviders();
    expect(getAllProviders()).toHaveLength(0);
  });
});
