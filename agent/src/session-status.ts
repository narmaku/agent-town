import type { SessionInfo } from "@agent-town/shared";

import type { ProcessMapping } from "./providers/types";

export function applyProviderStatusFallback(session: SessionInfo, mapping: ProcessMapping | undefined): void {
  if (session.multiplexerSession) {
    if (mapping?.hasActiveChildren) {
      session.status = "working";
    } else if (session.status === "idle") {
      session.status = "awaiting_input";
    }
    return;
  }

  if (session.statusSource === "provider") return;
  session.status = "idle";
}
