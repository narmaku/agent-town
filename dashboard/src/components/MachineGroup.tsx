import type { AgentType, MachineInfo, SessionInfo, SessionStatus, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import type { GroupMode, SortMode, TimeFilter } from "../App";
import { shortenPath, timeAgo } from "../utils";

const TIME_FILTER_MS: Record<TimeFilter, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

import { SessionCard } from "./SessionCard";

const statusOrder: Record<SessionStatus, number> = {
  action_required: 0,
  exited: 1,
  awaiting_input: 2,
  error: 3,
  starting: 4,
  working: 5,
  idle: 6,
  done: 7,
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  action_required: "Action Required",
  exited: "Exited",
  awaiting_input: "Awaiting Input",
  error: "Error",
  starting: "Starting",
  working: "Working",
  idle: "Idle",
  done: "Done",
};

const STATUS_GROUP_ORDER: SessionStatus[] = [
  "action_required",
  "exited",
  "awaiting_input",
  "error",
  "starting",
  "working",
  "idle",
  "done",
];

export function sortSessions(sessions: SessionInfo[], mode: SortMode): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    switch (mode) {
      case "recent":
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      case "alphabetical": {
        const nameA = a.customName || a.slug;
        const nameB = b.customName || b.slug;
        return nameA.localeCompare(nameB);
      }
      case "status":
        return statusOrder[a.status] - statusOrder[b.status];
      default:
        return 0;
    }
  });
}

export function filterSessionsByTime(sessions: SessionInfo[], timeFilter: TimeFilter): SessionInfo[] {
  const maxAge = TIME_FILTER_MS[timeFilter];
  const now = Date.now();
  return sessions.filter((s) => {
    if (s.multiplexerSession) return true;
    return now - new Date(s.lastActivity).getTime() < maxAge;
  });
}

export function buildGroups(sessions: SessionInfo[], groupMode: GroupMode): [string, SessionInfo[]][] {
  if (groupMode === "status") {
    const statusGroups = new Map<SessionStatus, SessionInfo[]>();
    for (const session of sessions) {
      if (!statusGroups.has(session.status)) statusGroups.set(session.status, []);
      statusGroups.get(session.status)?.push(session);
    }
    return STATUS_GROUP_ORDER.filter((s) => statusGroups.has(s)).map((s) => [
      STATUS_LABELS[s],
      statusGroups.get(s) ?? [],
    ]);
  }

  if (groupMode === "none") {
    return [["", sessions]];
  }

  // "directory" grouping (default)
  const districts = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = session.projectPath;
    if (!districts.has(key)) districts.set(key, []);
    districts.get(key)?.push(session);
  }
  return [...districts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

interface Props {
  machine: MachineInfo;
  hideIdle: boolean;
  sortMode: SortMode;
  timeFilter: TimeFilter;
  groupMode: GroupMode;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  onFullscreen: (session: SessionInfo) => void;
  autoDeleteOnClose?: boolean;
  selectedSessionId?: string | null;
}

export function MachineGroup({
  machine,
  hideIdle,
  sortMode,
  timeFilter,
  groupMode,
  onOpenTerminal,
  onResume,
  onFullscreen,
  autoDeleteOnClose,
  selectedSessionId,
}: Props): React.JSX.Element {
  const needsAttention = machine.sessions.filter((s) => s.status === "awaiting_input").length;
  const working = machine.sessions.filter((s) => s.status === "working").length;

  const timeSessions = filterSessionsByTime(machine.sessions, timeFilter);
  const groups = buildGroups(timeSessions, groupMode);

  return (
    <div className="machine-group">
      <div className="machine-header">
        <div className="machine-info">
          <span className="machine-hostname">{machine.hostname}</span>
          <span className="machine-platform">{machine.platform}</span>
          <span className="machine-multiplexers">{machine.multiplexers.join(", ")}</span>
        </div>
        <div className="machine-stats">
          {needsAttention > 0 && <span className="stat attention">{needsAttention} need attention</span>}
          {working > 0 && <span className="stat working">{working} working</span>}
          <span className="stat total">{machine.sessions.length} sessions</span>
          <span className="machine-heartbeat">{timeAgo(machine.lastHeartbeat)}</span>
        </div>
      </div>

      {groups.map(([groupLabel, sessions]) => {
        const filtered = hideIdle ? sessions.filter((s) => s.status !== "idle" && s.status !== "done") : sessions;
        const sorted = sortSessions(filtered, sortMode);

        if (sorted.length === 0) return null;

        return (
          <div key={groupLabel || "all"} className="district">
            {groupLabel && (
              <div className="district-header">
                <span className="district-path">
                  {groupMode === "directory" ? shortenPath(groupLabel) : groupLabel}
                </span>
                <span className="district-count">
                  {sessions.length} session{sessions.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            <div className="sessions-grid">
              {sorted.map((session) => (
                <SessionCard
                  key={session.sessionId}
                  session={session}
                  machineId={machine.machineId}
                  onOpenTerminal={onOpenTerminal}
                  onResume={onResume}
                  onFullscreen={onFullscreen}
                  autoDeleteOnClose={autoDeleteOnClose}
                  selected={selectedSessionId === session.sessionId}
                />
              ))}
            </div>
          </div>
        );
      })}

      {machine.sessions.length === 0 && <div className="no-sessions">No active sessions</div>}
    </div>
  );
}
