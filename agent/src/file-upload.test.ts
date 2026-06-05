import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupOldUploads, MAX_UPLOAD_SIZE_BYTES, sanitizeFilename, UPLOAD_DIR } from "./file-upload";

describe("sanitizeFilename", () => {
  test("strips path separators", () => {
    const result = sanitizeFilename("../../etc/passwd");
    expect(result).not.toContain("/");
    expect(result).not.toContain("..");
    expect(result).toContain("passwd");
  });

  test("strips backslash path separators", () => {
    const result = sanitizeFilename("C:\\Users\\file.txt");
    expect(result).not.toContain("\\");
    expect(result).toContain("file.txt");
  });

  test("removes special characters but keeps alphanumeric, dots, hyphens, underscores", () => {
    const result = sanitizeFilename("my file (1).png");
    expect(result).toMatch(/^[a-f0-9-]+-my_file_1.png$/);
  });

  test("prepends UUID", () => {
    const result = sanitizeFilename("photo.png");
    expect(result).toMatch(/^[a-f0-9-]{36}-photo.png$/);
  });

  test("handles empty string", () => {
    const result = sanitizeFilename("");
    expect(result).toMatch(/^[a-f0-9-]{36}-upload$/);
  });

  test("handles filename with only special chars", () => {
    const result = sanitizeFilename("@#$%^&*");
    expect(result).toMatch(/^[a-f0-9-]{36}-upload$/);
  });

  test("preserves file extension", () => {
    const result = sanitizeFilename("document.pdf");
    expect(result).toEndWith("-document.pdf");
  });

  test("handles multiple dots in filename", () => {
    const result = sanitizeFilename("my.file.name.tar.gz");
    expect(result).toEndWith("-my.file.name.tar.gz");
  });
});

describe("MAX_UPLOAD_SIZE_BYTES", () => {
  test("defaults to 50MB", () => {
    expect(MAX_UPLOAD_SIZE_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("UPLOAD_DIR", () => {
  test("points to /tmp/agent-town-uploads", () => {
    expect(UPLOAD_DIR).toBe("/tmp/agent-town-uploads");
  });
});

describe("cleanupOldUploads", () => {
  const testDir = "/tmp/agent-town-uploads-test";

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("removes files older than maxAge", async () => {
    const filePath = join(testDir, "old-file.txt");
    writeFileSync(filePath, "old content");

    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { utimesSync } = await import("node:fs");
    utimesSync(filePath, twoHoursAgo, twoHoursAgo);

    const removed = await cleanupOldUploads(60 * 60 * 1000, testDir);
    expect(removed).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  test("keeps recent files", async () => {
    const filePath = join(testDir, "recent-file.txt");
    writeFileSync(filePath, "recent content");

    const removed = await cleanupOldUploads(60 * 60 * 1000, testDir);
    expect(removed).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  test("returns 0 when directory does not exist", async () => {
    const removed = await cleanupOldUploads(60 * 60 * 1000, "/tmp/nonexistent-cleanup-test");
    expect(removed).toBe(0);
  });
});
