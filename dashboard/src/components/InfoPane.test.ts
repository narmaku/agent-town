import { describe, expect, test } from "bun:test";
import { shouldShowCwd } from "./InfoPane";

describe("shouldShowCwd", () => {
  test("returns true when cwd differs from projectPath", () => {
    expect(shouldShowCwd("/home/user/project/subdir", "/home/user/project")).toBe(true);
  });

  test("returns false when cwd equals projectPath", () => {
    expect(shouldShowCwd("/home/user/project", "/home/user/project")).toBe(false);
  });

  test("returns false when cwd is empty string", () => {
    expect(shouldShowCwd("", "/home/user/project")).toBe(false);
  });

  test("returns false when cwd is undefined", () => {
    expect(shouldShowCwd(undefined as unknown as string, "/home/user/project")).toBe(false);
  });

  test("returns true when cwd is set and projectPath is empty", () => {
    expect(shouldShowCwd("/home/user/project", "")).toBe(true);
  });

  test("returns true for different paths of similar length", () => {
    expect(shouldShowCwd("/home/user/other", "/home/user/project")).toBe(true);
  });

  test("returns false when cwd is null", () => {
    expect(shouldShowCwd(null as unknown as string, "/home/user/project")).toBe(false);
  });

  test("returns false when both cwd and projectPath are empty", () => {
    expect(shouldShowCwd("", "")).toBe(false);
  });

  test("returns true when cwd has trailing slash but projectPath does not", () => {
    expect(shouldShowCwd("/home/user/project/", "/home/user/project")).toBe(true);
  });

  test("returns true when projectPath has trailing slash but cwd does not", () => {
    expect(shouldShowCwd("/home/user/project", "/home/user/project/")).toBe(true);
  });

  test("returns true when cwd is a deeply nested subdirectory of projectPath", () => {
    expect(shouldShowCwd("/home/user/project/src/components/deep", "/home/user/project")).toBe(true);
  });

  test("returns true when cwd is the parent of projectPath", () => {
    expect(shouldShowCwd("/home/user", "/home/user/project")).toBe(true);
  });
});
