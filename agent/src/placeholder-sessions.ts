import { basename } from "node:path";

import { createLogger, type SessionInfo } from "@agent-town/shared";

import type { ProcessMapping } from "./process-mapper";

const log = createLogger("placeholder");

/** How long a placeholder session lives before being expired (3 minutes). */
const PLACEHOLDER_TTL_MS = 180_000;

/** Tracks when each placeholder session was first created. Keyed by sessionId. */
const placeholderCreatedAt = new Map<string, number>();

/**
 * Create placeholder sessions for running agents that haven't exchanged
 * any messages yet (no JSONL file). The process mapper finds the agent
 * process but discoverSessions() has nothing to report. Creates synthetic
 * sessions so the dashboard shows agents immediately.
 */
export function createPlaceholderSessions(
  sessions: SessionInfo[],
  processMappings: Map<string, ProcessMapping>,
  activeMuxNames: Set<string>,
): void {
  const mappedMuxSessions = new Set(sessions.filter((s) => s.multiplexerSession).map((s) => s.multiplexerSession));

  for (const [key, mapping] of processMappings) {
    if (mappedMuxSessions.has(mapping.session)) {
      // Real session now claims this mux session — clean up any stale timestamp
      placeholderCreatedAt.delete(`pending-${mapping.session}`);
      continue;
    }
    if (!activeMuxNames.has(mapping.session)) continue; // multiplexer session doesn't exist

    const cwd = key.startsWith("cwd:") ? key.slice(4) : "";
    if (!cwd) continue; // session ID-based key but no matching session — skip

    const placeholderId = `pending-${mapping.session}`;

    // Track creation time for TTL expiry
    if (!placeholderCreatedAt.has(placeholderId)) {
      placeholderCreatedAt.set(placeholderId, Date.now());
    }

    const placeholder: SessionInfo = {
      sessionId: placeholderId,
      agentType: mapping.agentType ?? "claude-code",
      slug: mapping.session,
      projectPath: cwd,
      projectName: basename(cwd),
      gitBranch: "",
      status: "starting",
      lastActivity: new Date().toISOString(),
      lastMessage: "Starting up\u2026",
      cwd,
      multiplexer: mapping.multiplexer,
      multiplexerSession: mapping.session,
    };
    sessions.push(placeholder);
  }
}

/**
 * Remove placeholder sessions that have exceeded the TTL.
 * Non-placeholder sessions are always kept.
 * Returns a new array with expired placeholders removed.
 */
export function expirePlaceholders(sessions: SessionInfo[]): SessionInfo[] {
  const now = Date.now();
  return sessions.filter((s) => {
    if (!s.sessionId.startsWith("pending-")) return true;

    const createdAt = placeholderCreatedAt.get(s.sessionId);
    if (createdAt === undefined) return true; // no tracking info — keep it

    if (now - createdAt > PLACEHOLDER_TTL_MS) {
      placeholderCreatedAt.delete(s.sessionId);
      log.info(`expired placeholder: ${s.sessionId} (age=${Math.round((now - createdAt) / 1000)}s)`);
      return false;
    }
    return true;
  });
}

/**
 * Deduplicate sessions: when a real session (non-pending-*) and a placeholder
 * share the same multiplexerSession, keep only the real session.
 * Returns a new array with duplicates removed.
 */
export function deduplicateSessions(sessions: SessionInfo[]): SessionInfo[] {
  const realMuxSessions = new Set(
    sessions
      .filter((s) => !s.sessionId.startsWith("pending-"))
      .filter((s) => s.multiplexerSession)
      .map((s) => s.multiplexerSession),
  );

  return sessions.filter((s) => {
    if (s.sessionId.startsWith("pending-") && s.multiplexerSession && realMuxSessions.has(s.multiplexerSession)) {
      // Clean up the timestamp tracking for this removed placeholder
      placeholderCreatedAt.delete(s.sessionId);
      log.debug(`dedup: removed placeholder ${s.sessionId} (real session claims ${s.multiplexerSession})`);
      return false;
    }
    return true;
  });
}

// --- Test helpers (not used in production) ---

/** Reset all placeholder timestamps. Used in tests. */
export function resetPlaceholderTimestamps(): void {
  placeholderCreatedAt.clear();
}

/** Set a specific creation time for a placeholder. Used in tests. */
export function setPlaceholderCreatedAt(sessionId: string, timestamp: number): void {
  placeholderCreatedAt.set(sessionId, timestamp);
}
