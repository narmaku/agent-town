import type React from "react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalMultiplexer } from "@agent-town/shared";
import { TerminalPane } from "./TerminalPane";

interface Props {
  machineId: string;
  sessionName: string;
  multiplexer: TerminalMultiplexer;
  onClose: () => void;
}

export function TerminalOverlay({ machineId, sessionName, multiplexer, onClose }: Props): React.JSX.Element {
  return (
    <div className="terminal-overlay">
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="terminal-session-name">{sessionName}</span>
          <span className="terminal-multiplexer">{multiplexer}</span>
        </div>
        <div className="terminal-controls">
          <span className="terminal-hint">ESC ESC to close</span>
          <button type="button" className="terminal-close-btn" onClick={onClose} aria-label="Close terminal">
            Close
          </button>
        </div>
      </div>
      <TerminalPane machineId={machineId} sessionName={sessionName} multiplexer={multiplexer} onDoubleEsc={onClose} />
    </div>
  );
}
