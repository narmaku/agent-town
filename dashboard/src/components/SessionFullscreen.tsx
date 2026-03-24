import type { AgentType, SessionInfo, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useEffect } from "react";
import { SessionDetail } from "./SessionDetail";

interface Props {
  session: SessionInfo;
  machineId: string;
  machineName?: string;
  onClose: () => void;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  autoDeleteOnClose?: boolean;
}

export function SessionFullscreen({
  session,
  machineId,
  machineName,
  onClose,
  onOpenTerminal,
  onResume,
  autoDeleteOnClose,
}: Props): React.JSX.Element {
  // Lock body scroll while overlay is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fullscreen-overlay">
      <div className="fullscreen-panel">
        <SessionDetail
          session={session}
          machineId={machineId}
          machineName={machineName}
          onOpenTerminal={onOpenTerminal}
          onResume={onResume}
          onClose={onClose}
          autoDeleteOnClose={autoDeleteOnClose}
        />
      </div>
    </div>
  );
}
