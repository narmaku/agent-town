import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome, validateSshKeyPath } from "./ssh-manager";

describe("resolveHome", () => {
  test("expands ~ to HOME directory", () => {
    const home = process.env.HOME || "/root";
    expect(resolveHome("~/.ssh/id_rsa")).toBe(`${home}/.ssh/id_rsa`);
  });

  test("returns absolute paths unchanged", () => {
    expect(resolveHome("/etc/ssh/key")).toBe("/etc/ssh/key");
  });

  test("returns relative paths unchanged", () => {
    expect(resolveHome("keys/my-key")).toBe("keys/my-key");
  });
});

describe("validateSshKeyPath", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null for valid key file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ssh-test-"));
    const keyPath = join(tempDir, "id_rsa");
    await writeFile(keyPath, "fake-key-content");
    await chmod(keyPath, 0o600);

    expect(validateSshKeyPath(keyPath)).toBeNull();
  });

  test("returns error for non-existent file", () => {
    expect(validateSshKeyPath("/nonexistent/path/key")).not.toBeNull();
    expect(validateSshKeyPath("/nonexistent/path/key")).toContain("not accessible");
  });

  test("returns error for directory instead of file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ssh-test-"));
    const dirPath = join(tempDir, "not-a-file");
    await mkdir(dirPath);

    expect(validateSshKeyPath(dirPath)).not.toBeNull();
    expect(validateSshKeyPath(dirPath)).toContain("not a regular file");
  });
});
