import { formatCompactTokens, type MachineInfo, type SessionInfo, type TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import type { SortMode, TimeFilter } from "../App";
import { filterIdleSessions, filterSessionsByTime, sortSessions } from "../session-grouping";
import { partitionIntoLanes, SIGNAL_LANES, type SignalLaneId } from "../signal-lanes";
import { AGENT_TYPE_CONFIG, STATUS_CONFIG, timeAgo } from "../utils";

interface BoardSession {
  session: SessionInfo;
  machineId: string;
  machineName: string;
}

interface SignalBoardProps {
  machines: MachineInfo[];
  hideIdle: boolean;
  sortMode: SortMode;
  timeFilter: TimeFilter;
  onOpenSession: (machineId: string, session: SessionInfo) => void;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
}

/**
 * Signal Board — sessions from every machine, sorted into three status lanes.
 * The board is organised by STATUS: a session's column is what it needs, so
 * colour stays muted and position carries the signal. Filters and sort apply
 * inside each lane; grouping is intentionally ignored (the lanes are the grouping).
 */
export function SignalBoard({
  machines,
  hideIdle,
  sortMode,
  timeFilter,
  onOpenSession,
  onOpenTerminal,
}: SignalBoardProps): React.JSX.Element {
  // Flatten every visible session across machines, keeping its machine context.
  const board: BoardSession[] = machines.flatMap((machine) =>
    filterIdleSessions(filterSessionsByTime(machine.sessions, timeFilter), hideIdle).map((session) => ({
      session,
      machineId: machine.machineId,
      machineName: machine.hostname,
    })),
  );

  const lanes = partitionIntoLanes(board, (b) => b.session.status);
  const total = board.length;

  return (
    <main className="app-main signal-board">
      {total === 0 && (
        <div className="empty-state">
          <h2>No sessions to show</h2>
          <p>Sessions from every machine land here as soon as an agent starts.</p>
        </div>
      )}
      {total > 0 && (
        <div className="signal-lanes">
          {SIGNAL_LANES.map((lane) => (
            <SignalLaneColumn
              key={lane.id}
              laneId={lane.id}
              label={lane.label}
              blurb={lane.blurb}
              items={sortBoard(lanes[lane.id], sortMode)}
              onOpenSession={onOpenSession}
              onOpenTerminal={onOpenTerminal}
            />
          ))}
        </div>
      )}
    </main>
  );
}

/** Sort a lane's rows by the active sort mode, reusing the shared session comparator. */
function sortBoard(items: BoardSession[], sortMode: SortMode): BoardSession[] {
  const backRef = new Map<SessionInfo, BoardSession>();
  for (const item of items) backRef.set(item.session, item);
  return sortSessions(
    items.map((i) => i.session),
    sortMode,
  ).map((session) => backRef.get(session) as BoardSession);
}

interface LaneColumnProps {
  laneId: SignalLaneId;
  label: string;
  blurb: string;
  items: BoardSession[];
  onOpenSession: (machineId: string, session: SessionInfo) => void;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
}

function SignalLaneColumn({
  laneId,
  label,
  blurb,
  items,
  onOpenSession,
  onOpenTerminal,
}: LaneColumnProps): React.JSX.Element {
  return (
    <section className="signal-lane" data-lane={laneId} aria-label={`${label} — ${items.length} sessions`}>
      <header className="signal-lane-header">
        <div className="signal-lane-title">
          <span className="signal-lane-label">{label}</span>
          <span className="signal-lane-count">{items.length}</span>
        </div>
        <span className="signal-lane-blurb">{blurb}</span>
      </header>
      <div className="signal-lane-body">
        {items.length === 0 ? (
          <div className="signal-lane-empty">Nothing here</div>
        ) : (
          items.map((item) => (
            <SignalCard
              key={`${item.machineId}:${item.session.sessionId}`}
              item={item}
              onOpenSession={onOpenSession}
              onOpenTerminal={onOpenTerminal}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface SignalCardProps {
  item: BoardSession;
  onOpenSession: (machineId: string, session: SessionInfo) => void;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
}

function SignalCard({ item, onOpenSession, onOpenTerminal }: SignalCardProps): React.JSX.Element {
  const { session, machineId, machineName } = item;
  const config = STATUS_CONFIG[session.status];
  const displayName = session.customName || session.slug;
  const hasTerminal = Boolean(session.multiplexer && session.multiplexerSession);
  const totalTokens = (session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0);

  return (
    // biome-ignore lint/a11y/useSemanticElements: card with a nested Terminal button, not a plain button
    <div
      className="signal-card"
      data-status={session.status}
      role="button"
      tabIndex={0}
      aria-label={`${displayName} on ${machineName} — ${config.label}`}
      onClick={() => onOpenSession(machineId, session)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenSession(machineId, session);
        }
      }}
    >
      <div className="signal-card-top">
        <span className="signal-card-status">
          <span className={`status-dot ${config.pulse ? "pulse" : ""}`} />
          <span className="status-label">{config.label}</span>
        </span>
        <span className="signal-card-age">{timeAgo(session.lastActivity)}</span>
      </div>

      <div className="signal-card-name">
        <span className="signal-card-title" title={displayName}>
          {displayName}
        </span>
        {session.agentType && session.agentType !== "claude-code" && (
          <span className={`agent-type-badge agent-${session.agentType}`} title={`Agent: ${session.agentType}`}>
            {AGENT_TYPE_CONFIG[session.agentType].shortLabel}
          </span>
        )}
        {session.currentTool && <span className="current-tool-badge">{session.currentTool}</span>}
        {session.status !== "starting" && (
          <span
            className={`tracking-badge ${session.hookEnabled ? "hook" : "heuristic"}`}
            title={session.hookEnabled ? "Real-time tracking via hooks" : "Estimated status (no hooks)"}
          >
            {session.hookEnabled ? "LIVE" : "EST"}
          </span>
        )}
      </div>

      <div className="signal-card-meta">
        <span className="signal-card-machine" title={`Machine: ${machineName}`}>
          {machineName}
        </span>
        {session.gitBranch && (
          <span className="git-branch" title={session.gitBranch}>
            {session.gitBranch}
          </span>
        )}
        {session.projectName && (
          <span className="signal-card-project" title={session.projectPath}>
            {session.projectName}
          </span>
        )}
      </div>

      {session.status === "action_required" ? (
        <p className="signal-card-message action-hint">Agent is asking a question — open terminal to respond</p>
      ) : (
        session.lastMessage && (
          <p className="signal-card-message" title={session.lastMessage}>
            {session.lastMessage}
          </p>
        )
      )}

      <div className="signal-card-footer">
        {totalTokens > 0 && (
          <span
            className="signal-card-tokens"
            title={`${(session.totalInputTokens ?? 0).toLocaleString()} in / ${(session.totalOutputTokens ?? 0).toLocaleString()} out`}
          >
            ~{formatCompactTokens(totalTokens)} tokens
          </span>
        )}
        {hasTerminal && (
          <button
            type="button"
            className="signal-card-terminal"
            onClick={(e) => {
              e.stopPropagation();
              onOpenTerminal(machineId, session.multiplexerSession ?? "", session.multiplexer ?? "zellij");
            }}
            title={`Open terminal for ${session.slug}`}
            aria-label={`Open terminal for ${session.slug}`}
          >
            Terminal
          </button>
        )}
      </div>
    </div>
  );
}
