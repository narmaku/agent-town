import type { SessionInfo } from "@agent-town/shared";

import type { ProcessMapping } from "./providers/types";

const OMP_TERMINAL_STATUSES = new Set<SessionInfo["status"]>(["done", "error", "exited"]);

export function applyProviderStatusFallback(session: SessionInfo, mapping: ProcessMapping | undefined): void {
  if (session.multiplexerSession) {
    if (mapping?.hasActiveChildren) {
      session.status = "working";
    } else if (session.status === "idle") {
      session.status = "awaiting_input";
    }
    return;
  }

  if (session.agentType === "omp" && OMP_TERMINAL_STATUSES.has(session.status)) return;
  session.status = "idle";
}
