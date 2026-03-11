import { useState } from "react";
import type { TerminalMultiplexer } from "@agent-town/shared";
import { useWebSocket } from "./hooks/useWebSocket";
import { MachineGroup } from "./components/MachineGroup";
import { TerminalOverlay } from "./components/TerminalOverlay";
import { SettingsModal } from "./components/SettingsModal";
import { LaunchAgentModal } from "./components/LaunchAgentModal";

interface TerminalTarget {
  machineId: string;
  sessionName: string;
  multiplexer: TerminalMultiplexer;
}

export function App() {
  const { machines, connected } = useWebSocket();
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);

  const totalSessions = machines.reduce((sum, m) => sum + m.sessions.length, 0);
  const totalAttention = machines.reduce(
    (sum, m) =>
      sum + m.sessions.filter((s) => s.status === "needs_attention").length,
    0
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Agent Town</h1>
          <span className={`connection-status ${connected ? "online" : "offline"}`}>
            {connected ? "Connected" : "Reconnecting..."}
          </span>
        </div>
        <div className="header-right">
          <div className="header-stats">
            <span className="header-stat">
              {machines.length} machine{machines.length !== 1 ? "s" : ""}
            </span>
            <span className="header-stat">
              {totalSessions} session{totalSessions !== 1 ? "s" : ""}
            </span>
            {totalAttention > 0 && (
              <span className="header-stat attention">
                {totalAttention} need attention
              </span>
            )}
          </div>
          <div className="header-actions">
            <button
              className="header-btn"
              onClick={() => setLaunchOpen(true)}
              title="Launch new agent"
            >
              + New Agent
            </button>
            <button
              className="header-btn header-btn-icon"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z"/>
                <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0a1.97 1.97 0 0 1-2.929 1.1c-1.541-.971-3.327.813-2.355 2.355a1.97 1.97 0 0 1-1.1 2.929c-1.79.527-1.79 3.065 0 3.592a1.97 1.97 0 0 1 1.1 2.929c-.972 1.541.813 3.327 2.355 2.355a1.97 1.97 0 0 1 2.929 1.1c.527 1.79 3.065 1.79 3.592 0a1.97 1.97 0 0 1 2.929-1.1c1.541.972 3.327-.813 2.355-2.355a1.97 1.97 0 0 1 1.1-2.929c1.79-.527 1.79-3.065 0-3.592a1.97 1.97 0 0 1-1.1-2.929c.972-1.541-.813-3.327-2.355-2.355a1.97 1.97 0 0 1-2.929-1.1ZM8 0c.463 0 .898.248 1.13.666.332.6 1.089.832 1.727.527.442-.212.957-.06 1.216.352.26.414.173.95-.18 1.282-.508.476-.554 1.27-.103 1.8.312.37.363.896.118 1.32-.247.427-.737.641-1.218.518-.69-.177-1.403.241-1.523.952-.083.494-.507.852-1.007.867a1.05 1.05 0 0 1-1.04-.83c-.14-.703-.862-1.131-1.554-.938-.482.135-.984-.066-1.242-.49a1.05 1.05 0 0 1 .083-1.166c.435-.54.37-1.324-.147-1.784-.36-.32-.457-.85-.207-1.267.252-.42.765-.58 1.215-.377.644.29 1.406.047 1.729-.562A1.3 1.3 0 0 1 8 0Z"/>
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="app-main">
        {machines.length === 0 && (
          <div className="empty-state">
            <h2>No machines connected</h2>
            <p>
              Start an agent on a machine to see its sessions here.
            </p>
            <pre>
              <code>AGENT_TOWN_SERVER=http://&lt;this-server&gt;:4680 bun run agent/src/index.ts</code>
            </pre>
          </div>
        )}
        {machines.map((machine) => (
          <MachineGroup
            key={machine.machineId}
            machine={machine}
            onOpenTerminal={(sessionName, multiplexer) =>
              setTerminal({ machineId: machine.machineId, sessionName, multiplexer })
            }
          />
        ))}
      </main>

      {terminal && (
        <TerminalOverlay
          machineId={terminal.machineId}
          sessionName={terminal.sessionName}
          multiplexer={terminal.multiplexer}
          onClose={() => setTerminal(null)}
        />
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <LaunchAgentModal
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        machines={machines}
      />
    </div>
  );
}
