import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectories, validateListDirsPath } from "./list-dirs";

describe("validateListDirsPath", () => {
  test("accepts valid absolute paths", () => {
    expect(validateListDirsPath("/home/user")).toBeNull();
    expect(validateListDirsPath("/tmp")).toBeNull();
    expect(validateListDirsPath("/")).toBeNull();
  });

  test("rejects empty path", () => {
    expect(validateListDirsPath("")).not.toBeNull();
  });

  test("rejects relative paths", () => {
    expect(validateListDirsPath("relative/path")).not.toBeNull();
    expect(validateListDirsPath("./local")).not.toBeNull();
  });

  test("rejects paths with directory traversal", () => {
    expect(validateListDirsPath("/home/../etc")).not.toBeNull();
    expect(validateListDirsPath("/tmp/../../etc")).not.toBeNull();
  });

  test("rejects paths with redundant slashes or dot segments", () => {
    expect(validateListDirsPath("/home/./user")).not.toBeNull();
    expect(validateListDirsPath("/home//user")).not.toBeNull();
  });

  test("rejects paths with trailing slash", () => {
    expect(validateListDirsPath("/home/user/")).not.toBeNull();
    expect(validateListDirsPath("/tmp/")).not.toBeNull();
  });

  test("returns specific error message for empty path", () => {
    expect(validateListDirsPath("")).toBe("Missing dir parameter");
  });

  test("returns specific error message for relative path", () => {
    expect(validateListDirsPath("relative")).toBe("dir must be an absolute path");
  });

  test("returns specific error message for non-canonical path", () => {
    const msg = validateListDirsPath("/home/../etc");
    expect(msg).toContain("canonical");
  });
});

describe("listDirectories", () => {
  const testDir = join(tmpdir(), `agent-town-list-dirs-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "subdir-a"), { recursive: true });
    mkdirSync(join(testDir, "subdir-b"), { recursive: true });
    mkdirSync(join(testDir, ".hidden-dir"), { recursive: true });
    writeFileSync(join(testDir, "file.txt"), "hello");
    writeFileSync(join(testDir, "script.sh"), "#!/bin/bash");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("lists only directories, not files", async () => {
    const result = await listDirectories(testDir);
    expect(result.dirs).toContain("subdir-a");
    expect(result.dirs).toContain("subdir-b");
    expect(result.dirs).toContain(".hidden-dir");
    expect(result.dirs).not.toContain("file.txt");
    expect(result.dirs).not.toContain("script.sh");
  });

  test("returns sorted directory names", async () => {
    const result = await listDirectories(testDir);
    const sorted = [...result.dirs].sort();
    expect(result.dirs).toEqual(sorted);
  });

  test("returns parent directory for non-root paths", async () => {
    const result = await listDirectories(testDir);
    expect(result.parent).not.toBeNull();
    expect(typeof result.parent).toBe("string");
  });

  test("returns null parent for root path", async () => {
    const result = await listDirectories("/");
    expect(result.parent).toBeNull();
  });

  test("throws for non-existent directory", async () => {
    await expect(listDirectories("/nonexistent-path-12345")).rejects.toThrow();
  });

  test("returns empty dirs array for empty directory", async () => {
    const emptyDir = join(testDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const result = await listDirectories(emptyDir);
    expect(result.dirs).toEqual([]);
  });

  test("returns correct parent path", async () => {
    const subDir = join(testDir, "subdir-a");
    const result = await listDirectories(subDir);
    expect(result.parent).toBe(testDir);
  });

  test("throws when path is a file, not a directory", async () => {
    const filePath = join(testDir, "file.txt");
    await expect(listDirectories(filePath)).rejects.toThrow();
  });

  test("returns only directory names without full paths", async () => {
    const result = await listDirectories(testDir);
    for (const dir of result.dirs) {
      expect(dir).not.toContain("/");
    }
  });
});
