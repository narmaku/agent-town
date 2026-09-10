import {
  type AgentType,
  formatCompactTokens,
  type MachineInfo,
  type SessionInfo,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { GroupMode, SortMode, TimeFilter } from "../App";
import { createBrowserLogger } from "../logger";
import { buildGroups, filterIdleSessions, filterSessionsByTime, sortSessions } from "../session-grouping";
import { AGENT_TYPE_CONFIG, API, STATUS_CONFIG, shortenPath, timeAgo } from "../utils";
import { SessionExpanded } from "./SessionExpanded";

const logger = createBrowserLogger("ControlRoom");

interface ControlRoomProps {
  machines: MachineInfo[];
  hideIdle: boolean;
  sortMode: SortMode;
  timeFilter: TimeFilter;
  groupMode: GroupMode;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (machineId: string, sessionId: string, projectDir: string, agentType: AgentType) => void;
  onFullscreen: (machineId: string, session: SessionInfo) => void;
  autoDeleteOnClose?: boolean;
  selectedSessionId?: string | null;
  onLaunchAgent?: (machineId: string) => void;
}

/**
 * Control Room — a dense operations table. One machine per section, sessions
 * grouped and ordered exactly as the shared grouping helpers dictate, each on a
 * single line that expands in place to the shared session body.
 */
export function ControlRoom({
  machines,
  hideIdle,
  sortMode,
  timeFilter,
  groupMode,
  onOpenTerminal,
  onResume,
  onFullscreen,
  autoDeleteOnClose,
  selectedSessionId,
  onLaunchAgent,
}: ControlRoomProps): React.JSX.Element {
  return (
    <div className="control-room">
      {machines.map((machine) => (
        <ControlRoomMachine
          key={machine.machineId}
          machine={machine}
          hideIdle={hideIdle}
          sortMode={sortMode}
          timeFilter={timeFilter}
          groupMode={groupMode}
          onOpenTerminal={onOpenTerminal}
          onResume={onResume}
          onFullscreen={onFullscreen}
          autoDeleteOnClose={autoDeleteOnClose}
          selectedSessionId={selectedSessionId}
          onLaunchAgent={onLaunchAgent}
        />
      ))}
    </div>
  );
}

interface MachineProps extends Omit<ControlRoomProps, "machines"> {
  machine: MachineInfo;
}

function ControlRoomMachine({
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
  onLaunchAgent,
}: MachineProps): React.JSX.Element {
  const needsAttention = machine.sessions.filter((s) => s.status === "awaiting_input").length;
  const working = machine.sessions.filter((s) => s.status === "working").length;

  const groups = buildGroups(filterSessionsByTime(machine.sessions, timeFilter), groupMode);

  return (
    <section className="cr-machine">
      <header className="cr-machine-header">
        <div className="cr-machine-info">
          <span className="cr-machine-hostname">{machine.hostname}</span>
          <span className="cr-machine-platform">{machine.platform}</span>
          <span className="cr-machine-multiplexers">{machine.multiplexers.join(", ")}</span>
          {onLaunchAgent && (
            <button
              type="button"
              className="cr-machine-launch"
              onClick={() => onLaunchAgent(machine.machineId)}
              title={`Launch new agent on ${machine.hostname}`}
              aria-label={`Launch new agent on ${machine.hostname}`}
            >
              +
            </button>
          )}
        </div>
        <div className="cr-machine-stats">
          {needsAttention > 0 && <span className="cr-stat attention">{needsAttention} need attention</span>}
          {working > 0 && <span className="cr-stat working">{working} working</span>}
          <span className="cr-stat total">{machine.sessions.length} sessions</span>
          <span className="cr-machine-heartbeat">{timeAgo(machine.lastHeartbeat)}</span>
        </div>
      </header>

      {machine.sessions.length === 0 && <div className="cr-empty">No active sessions</div>}

      {groups.map(([groupLabel, sessions]) => {
        const rows = sortSessions(filterIdleSessions(sessions, hideIdle), sortMode);
        if (rows.length === 0) return null;

        return (
          <div key={groupLabel || "all"} className="cr-group">
            {groupLabel && (
              <div className="cr-group-header">
                <span className="cr-group-label">
                  {groupMode === "directory" ? shortenPath(groupLabel) : groupLabel}
                </span>
                <span className="cr-group-count">
                  {rows.length} session{rows.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            <div className="cr-table">
              {/* Visual column labels; the meaningful semantics live on each row's button. */}
              <div className="cr-head" aria-hidden="true">
                <span className="cr-col-status">Status</span>
                <span className="cr-col-name">Session</span>
                <span className="cr-col-branch">Branch</span>
                <span className="cr-col-message">Last message</span>
                <span className="cr-col-meta">Model / tokens</span>
                <span className="cr-col-age">Age</span>
                <span className="cr-col-actions" />
              </div>
              {rows.map((session) => (
                <ControlRoomRow
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
    </section>
  );
}

interface RowProps {
  session: SessionInfo;
  machineId: string;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (machineId: string, sessionId: string, projectDir: string, agentType: AgentType) => void;
  onFullscreen: (machineId: string, session: SessionInfo) => void;
  autoDeleteOnClose?: boolean;
  selected?: boolean;
}

function ControlRoomRow({
  session,
  machineId,
  onOpenTerminal,
  onResume,
  onFullscreen,
  autoDeleteOnClose,
  selected,
}: RowProps): React.JSX.Element {
  const config = STATUS_CONFIG[session.status];
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.customName || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setName(session.customName || "");
  }, [session.customName, editing]);

  const displayName = session.customName || session.slug;
  const hasTerminal = Boolean(session.multiplexer && session.multiplexerSession);
  const totalTokens = (session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0);

  async function handleRename() {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed === (session.customName || "")) return;

    try {
      await fetch(API.SESSIONS_RENAME, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId, sessionId: session.sessionId, name: trimmed }),
      });
    } catch (err) {
      logger.warn(`Failed to rename session ${session.sessionId}:`, err);
      setName(session.customName || "");
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") handleRename();
    if (e.key === "Escape") {
      setName(session.customName || "");
      setEditing(false);
    }
  }

  function toggle(e: React.MouseEvent | React.KeyboardEvent) {
    // Clicks inside the expanded body operate their own controls, never the row.
    if ((e.target as HTMLElement).closest(".cr-detail")) return;
    setExpanded((prev) => !prev);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: dense grid row with nested controls, not a plain button
    <div
      className={`cr-row${expanded ? " expanded" : ""}${selected ? " cr-row--selected" : ""}`}
      data-status={session.status}
      data-session-id={session.sessionId}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(e);
        }
      }}
    >
      <div className="cr-col-status">
        <span className={`status-dot ${config.pulse ? "pulse" : ""}`} />
        <span className="status-label">{config.label}</span>
        {session.agentType && session.agentType !== "claude-code" && (
          <span className={`agent-type-badge agent-${session.agentType}`} title={`Agent: ${session.agentType}`}>
            {AGENT_TYPE_CONFIG[session.agentType].shortLabel}
          </span>
        )}
      </div>

      <div className="cr-col-name">
        {editing ? (
          <input
            ref={inputRef}
            className="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleNameKeyDown}
            onClick={(e) => e.stopPropagation()}
            placeholder={session.slug}
            aria-label={`Rename ${session.slug}`}
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: double-click rename is a secondary interaction
          <span
            className="cr-name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            title={
              hasTerminal
                ? `${session.multiplexer}: ${session.multiplexerSession} — double-click to rename`
                : "Double-click to rename"
            }
          >
            {displayName}
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
        {!session.multiplexerSession && session.status !== "starting" && (
          <span
            className="tracking-badge standalone"
            title="No terminal multiplexer detected — session was started outside Agent Town or directly in a terminal"
          >
            standalone
          </span>
        )}
      </div>

      <div className="cr-col-branch">
        {session.gitBranch && (
          <span className="git-branch" title={session.gitBranch}>
            {session.gitBranch}
          </span>
        )}
      </div>

      <div className="cr-col-message">
        {session.status === "action_required" ? (
          <span className="cr-message action-hint">Agent is asking a question — open terminal to respond</span>
        ) : (
          <span className="cr-message" title={session.lastMessage || ""}>
            {session.lastMessage}
          </span>
        )}
      </div>

      <div className="cr-col-meta">
        {session.model && <span className="cr-model">{session.model}</span>}
        {totalTokens > 0 && (
          <span
            className="cr-tokens"
            title={`${(session.totalInputTokens ?? 0).toLocaleString()} in / ${(session.totalOutputTokens ?? 0).toLocaleString()} out`}
          >
            ~{formatCompactTokens(totalTokens)}
          </span>
        )}
      </div>

      <div className="cr-col-age">{timeAgo(session.lastActivity)}</div>

      <div className="cr-col-actions">
        {hasTerminal && (
          <button
            type="button"
            className="cr-quick-btn"
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
        <span className={`cr-chevron${expanded ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
      </div>

      {expanded && (
        <div className="cr-detail">
          <SessionExpanded
            session={session}
            machineId={machineId}
            onOpenTerminal={(sessionName, multiplexer) => onOpenTerminal(machineId, sessionName, multiplexer)}
            onResume={(sessionId, projectDir, agentType) => onResume(machineId, sessionId, projectDir, agentType)}
            onFullscreen={(s) => onFullscreen(machineId, s)}
            autoDeleteOnClose={autoDeleteOnClose}
          />
        </div>
      )}
    </div>
  );
}
