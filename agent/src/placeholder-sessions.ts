import { basename } from "node:path";

import type { SessionInfo } from "@agent-town/shared";

import type { ProcessMapping } from "./process-mapper";

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
    if (mappedMuxSessions.has(mapping.session)) continue; // already mapped
    if (!activeMuxNames.has(mapping.session)) continue; // multiplexer session doesn't exist

    const cwd = key.startsWith("cwd:") ? key.slice(4) : "";
    if (!cwd) continue; // session ID-based key but no matching session — skip

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
