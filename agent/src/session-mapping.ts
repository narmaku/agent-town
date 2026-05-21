import { createLogger, type MultiplexerSessionInfo, type SessionInfo, truncateId } from "@agent-town/shared";
import type { ProcessMapping } from "./process-mapper";

const log = createLogger("mapping");

/**
 * Discover sessions from all providers and map them to multiplexer sessions
 * using process-level inspection. Validates that mapped multiplexer sessions
 * actually exist (rejects zombie process associations).
 *
 * Two-pass matching:
 * 1. By sessionId (exact match from process args or JSONL birth time)
 * 2. By CWD fallback (when process mapper couldn't extract session ID)
 */
export function discoverAndMapSessions(
  sessions: SessionInfo[],
  multiplexerSessions: MultiplexerSessionInfo[],
  processMappings: Map<string, ProcessMapping>,
): Set<string> {
  const activeMuxNames = new Set(multiplexerSessions.map((s) => s.name));
  log.debug(`active mux sessions: [${[...activeMuxNames].join(", ")}]`);

  const claimedMux = new Set<string>();

  // Pass 1: match by sessionId
  for (const session of sessions) {
    const mapping = processMappings.get(session.sessionId);
    if (mapping) {
      if (activeMuxNames.has(mapping.session)) {
        session.multiplexer = mapping.multiplexer;
        session.multiplexerSession = mapping.session;
        claimedMux.add(mapping.session);
      } else {
        log.debug(
          `rejected mapping: session=${truncateId(session.sessionId)} mux=${mapping.session} (not in active mux list)`,
        );
      }
    }
  }

  // Pass 2: CWD-based fallback for sessions not matched by sessionId
  for (const session of sessions) {
    if (session.multiplexerSession) continue;
    if (!session.cwd) continue;

    const cwdMapping = processMappings.get(`cwd:${session.cwd}`);
    if (!cwdMapping) continue;
    if (!activeMuxNames.has(cwdMapping.session)) continue;
    if (claimedMux.has(cwdMapping.session)) continue;

    session.multiplexer = cwdMapping.multiplexer;
    session.multiplexerSession = cwdMapping.session;
    claimedMux.add(cwdMapping.session);
    log.info(`cwd fallback: session=${truncateId(session.sessionId)} mux=${cwdMapping.session} cwd=${session.cwd}`);
  }

  return activeMuxNames;
}
