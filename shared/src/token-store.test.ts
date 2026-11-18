import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateToken, loadOrCreateToken, MIN_TOKEN_LENGTH, resolveTokenFile } from "./token-store";

describe("loadOrCreateToken", () => {
  let dir: string;
  let tokenFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "token-store-test-"));
    tokenFile = join(dir, "nested", "token");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a token file readable only by the owner on first run", () => {
    const token = loadOrCreateToken(tokenFile);
    expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(readFileSync(tokenFile, "utf-8").trim()).toBe(token);
  });

  test("returns the same token on later runs", () => {
    const first = loadOrCreateToken(tokenFile);
    expect(loadOrCreateToken(tokenFile)).toBe(first);
  });

  test("reads an existing token rather than replacing it", () => {
    loadOrCreateToken(tokenFile);
    const existing = "x".repeat(MIN_TOKEN_LENGTH);
    writeFileSync(tokenFile, `${existing}\n`, { mode: 0o600 });
    expect(loadOrCreateToken(tokenFile)).toBe(existing);
  });

  test("tightens a token file with permissive permissions", () => {
    loadOrCreateToken(tokenFile);
    chmodSync(tokenFile, 0o644);
    loadOrCreateToken(tokenFile);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  test("refuses a token that is too short instead of silently accepting it", () => {
    loadOrCreateToken(tokenFile);
    writeFileSync(tokenFile, "short\n");
    expect(() => loadOrCreateToken(tokenFile)).toThrow("shorter than");
  });

  test("leaves no temp files behind", () => {
    loadOrCreateToken(tokenFile);
    const leftovers = new Bun.Glob("*.tmp").scanSync(join(dir, "nested"));
    expect([...leftovers]).toEqual([]);
  });
});

describe("generateToken", () => {
  test("produces distinct URL-safe tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
  });
});

describe("resolveTokenFile", () => {
  test("honours AGENT_TOWN_TOKEN_FILE", () => {
    expect(resolveTokenFile({ AGENT_TOWN_TOKEN_FILE: "/srv/town/token" })).toBe("/srv/town/token");
  });

  test("defaults to ~/.agent-town/token", () => {
    expect(resolveTokenFile({})).toEndWith(join(".agent-town", "token"));
    expect(resolveTokenFile({ AGENT_TOWN_DATA_DIR: "/srv/town" })).toBe(join("/srv/town", "token"));
  });
});
