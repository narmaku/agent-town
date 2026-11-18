/**
 * Shared-secret storage. The server, the agent and the dashboard all
 * authenticate with one token kept in `~/.agent-town/token` (mode 0600).
 * Whichever process starts first creates it; the other reads it.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveDataDir } from "./data-dir";
import { createLogger } from "./logger";

const log = createLogger("token");

const TOKEN_BYTES = 32;
export const MIN_TOKEN_LENGTH = 32;
const TOKEN_FILE_MODE = 0o600;
const TOKEN_DIR_MODE = 0o700;

/** Token file path: `AGENT_TOWN_TOKEN_FILE` if set, else `token` in the data directory (`~/.agent-town`). */
export function resolveTokenFile(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_TOWN_TOKEN_FILE || join(resolveDataDir(env), "token");
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function readToken(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    log.warn(`token file ${path} had permissive mode ${mode.toString(8)}; tightening to 600`);
    chmodSync(path, TOKEN_FILE_MODE);
  }
  const token = readFileSync(path, "utf-8").trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `token file ${path} holds a token shorter than ${MIN_TOKEN_LENGTH} characters; delete it to regenerate`,
    );
  }
  return token;
}

/**
 * Create the token file atomically: write a private temp file, then hard-link
 * it into place. `link` fails if the target exists, so two processes starting
 * at once never overwrite each other — the loser just reads the winner's token.
 */
function createToken(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: TOKEN_DIR_MODE });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${generateToken()}\n`, { mode: TOKEN_FILE_MODE });
  try {
    linkSync(tmp, path);
    log.info(`generated new access token in ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    unlinkSync(tmp);
  }
}

/** Return the shared token, creating `path` (mode 0600) on first run. */
export function loadOrCreateToken(path: string = resolveTokenFile()): string {
  try {
    return readToken(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  createToken(path);
  return readToken(path);
}
