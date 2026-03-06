import type { MachineInfo } from "@agent-town/shared";
import { SessionCard } from "./SessionCard";

function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

interface Props {
  machine: MachineInfo;
}

export function MachineGroup({ machine }: Props) {
  const needsAttention = machine.sessions.filter(
    (s) => s.status === "needs_attention"
  ).length;
  const working = machine.sessions.filter(
    (s) => s.status === "working"
  ).length;

  // Sort: needs_attention first, then working, then idle, then done
  const statusOrder = { needs_attention: 0, error: 1, working: 2, idle: 3, done: 4 };
  const sortedSessions = [...machine.sessions].sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status]
  );

  return (
    <div className="machine-group">
      <div className="machine-header">
        <div className="machine-info">
          <span className="machine-hostname">{machine.hostname}</span>
          <span className="machine-platform">{machine.platform}</span>
          <span className="machine-multiplexers">
            {machine.multiplexers.join(", ")}
          </span>
        </div>
        <div className="machine-stats">
          {needsAttention > 0 && (
            <span className="stat attention">{needsAttention} need attention</span>
          )}
          {working > 0 && (
            <span className="stat working">{working} working</span>
          )}
          <span className="stat total">{machine.sessions.length} sessions</span>
          <span className="machine-heartbeat">
            {timeAgo(machine.lastHeartbeat)}
          </span>
        </div>
      </div>
      <div className="sessions-grid">
        {sortedSessions.map((session) => (
          <SessionCard key={session.sessionId} session={session} machineId={machine.machineId} />
        ))}
        {sortedSessions.length === 0 && (
          <div className="no-sessions">No active sessions</div>
        )}
      </div>
    </div>
  );
}
