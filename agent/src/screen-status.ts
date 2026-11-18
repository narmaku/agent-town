import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  errorMessage,
  type SessionInfo,
  type SessionStatus,
  type TerminalMultiplexer,
} from "@agent-town/shared";

const log = createLogger("screen-status");

/** Only the bottom of the visible screen matters: prompts and spinners live there. */
const SCREEN_TAIL_LINES = 25;
const CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Approval prompts the supported agents draw when they need a human decision.
 * Matched against the visible screen only (not scrollback), so old output
 * that merely mentions these phrases is not picked up once it scrolls away.
 */
const APPROVAL_PATTERNS: readonly RegExp[] = [
  /do you want to (?:proceed|make this edit|create|run|allow|apply)/i, // Claude Code, Gemini CLI
  /would you like to (?:run the following command|make the following edits|apply)/i, // Codex CLI
  /allow (?:execution|this action|command)\?/i, // Gemini CLI, Codex CLI
  /permission required/i, // OpenCode
  /\b(?:allow once|allow always)\b/i, // OpenCode, Gemini CLI
];

/** Spinner hints every supported TUI shows while a turn is running. */
const WORKING_PATTERNS: readonly RegExp[] = [/esc to (?:interrupt|cancel)/i, /ctrl\+c to (?:interrupt|cancel)/i];

/**
 * Infer a session status from the visible terminal screen. Returns undefined
 * when the screen gives no clear signal, so callers keep their heuristic.
 */
export function detectScreenStatus(screen: string): SessionStatus | undefined {
  const tail = screen
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-SCREEN_TAIL_LINES)
    .join("\n");
  if (!tail) return undefined;
  if (APPROVAL_PATTERNS.some((pattern) => pattern.test(tail))) return "action_required";
  if (WORKING_PATTERNS.some((pattern) => pattern.test(tail))) return "working";
  return undefined;
}

export type ScreenCapturer = (multiplexer: TerminalMultiplexer, session: string) => Promise<string | null>;

/**
 * Refine statuses of sessions attached to a multiplexer by reading what their
 * terminal currently shows. This replaces agent hooks: nothing is installed
 * into the agents, we only look at the screen the user would see.
 */
export async function applyScreenStatuses(
  sessions: SessionInfo[],
  capture: ScreenCapturer = captureScreen,
): Promise<void> {
  const targets = sessions.filter((session) => session.multiplexer && session.multiplexerSession);
  await Promise.all(
    targets.map(async (session) => {
      const screen = await capture(session.multiplexer as TerminalMultiplexer, session.multiplexerSession as string);
      const status = screen ? detectScreenStatus(screen) : undefined;
      if (status) session.status = status;
    }),
  );
}

/** Capture the visible screen of a multiplexer session, or null if it can't be read. */
export async function captureScreen(multiplexer: TerminalMultiplexer, session: string): Promise<string | null> {
  return multiplexer === "tmux" ? captureTmux(session) : captureZellij(session);
}

async function captureTmux(session: string): Promise<string | null> {
  return runCapture(["tmux", "capture-pane", "-p", "-t", session]);
}

async function captureZellij(session: string): Promise<string | null> {
  // zellij can only dump the screen to a file; use a private (0700) temp dir.
  const dir = mkdtempSync(join(tmpdir(), "agent-town-screen-"));
  const path = join(dir, "screen.txt");
  try {
    const ok = await runCapture(["zellij", "--session", session, "action", "dump-screen", path]);
    if (ok === null) return null;
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runCapture(command: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", timeout: CAPTURE_TIMEOUT_MS });
    const [output, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited]);
    if (exitCode !== 0) {
      log.debug(`screen capture failed: ${command[0]} exit=${exitCode}`);
      return null;
    }
    return output;
  } catch (err) {
    log.debug(`screen capture failed: ${command[0]} error=${errorMessage(err)}`);
    return null;
  }
}
