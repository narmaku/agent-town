import { basename } from "node:path";

import type { SessionInfo } from "@agent-town/shared";

import type { ProcessMapping } from "./process-mapper";

/**
 * Create placeholder sessions for running agents that haven't exchanged
 * any messages yet (no JSONL file). The process mapper finds the agent
 * process but discoverSessions() has nothing to report. Creates synthetic
 * sessions so the dashboard shows agents immediately.
 *
 * Skips placeholder creation when a real session with the same CWD already
 * exists (even if unmapped) — this prevents duplication when the user delays
 * before sending their first message and the birth-time matching fails.
 */
export function createPlaceholderSessions(
  sessions: SessionInfo[],
  processMappings: Map<string, ProcessMapping>,
  activeMuxNames: Set<string>,
): void {
  const mappedMuxSessions = new Set(sessions.filter((s) => s.multiplexerSession).map((s) => s.multiplexerSession));
  // Track CWDs of real (non-placeholder) sessions to prevent duplication
  const realSessionCwds = new Set(
    sessions.filter((s) => !s.sessionId.startsWith("pending-") && s.cwd).map((s) => s.cwd),
  );

  for (const [key, mapping] of processMappings) {
    if (mappedMuxSessions.has(mapping.session)) continue; // already mapped
    if (!activeMuxNames.has(mapping.session)) continue; // multiplexer session doesn't exist

    const cwd = key.startsWith("cwd:") ? key.slice(4) : "";
    if (!cwd) continue; // session ID-based key but no matching session — skip

    // Skip if a real session already exists in this CWD — the CWD fallback
    // in discoverAndMapSessions should have already mapped it
    if (realSessionCwds.has(cwd)) continue;

    const placeholder: SessionInfo = {
      sessionId: `pending-${mapping.session}`,
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
