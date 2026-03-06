import { useWebSocket } from "./hooks/useWebSocket";
import { MachineGroup } from "./components/MachineGroup";

export function App() {
  const { machines, connected } = useWebSocket();

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
          <MachineGroup key={machine.machineId} machine={machine} />
        ))}
      </main>
    </div>
  );
}
