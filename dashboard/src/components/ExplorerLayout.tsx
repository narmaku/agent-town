import type { AgentType, MachineInfo, SessionInfo, SessionStatus, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { GroupMode, SortMode, TimeFilter } from "../App";
import { API, STATUS_CONFIG, shortenPath, timeAgo } from "../utils";
import { buildGroups, filterSessionsByTime, sortSessions } from "./MachineGroup";
import { SessionDetail } from "./SessionDetail";

interface Props {
  machines: MachineInfo[];
  allMachines: MachineInfo[];
  groupMode: GroupMode;
  sortMode: SortMode;
  hideIdle: boolean;
  timeFilter: TimeFilter;
  autoDeleteOnClose?: boolean;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (machineId: string, sessionId: string, projectDir: string, agentType: AgentType) => void;
}

interface SelectedSession {
  machineId: string;
  sessionId: string;
}

function ExplorerDashboard({
  allMachines,
  onSelect,
}: {
  allMachines: MachineInfo[];
  onSelect: (machineId: string, sessionId: string) => void;
}) {
  const allSessions: { machineId: string; session: SessionInfo }[] = [];
  for (const m of allMachines) {
    for (const s of m.sessions) {
      allSessions.push({ machineId: m.machineId, session: s });
    }
  }

  // Status summary counts
  const statusCounts: Partial<Record<SessionStatus, number>> = {};
  for (const { session } of allSessions) {
    statusCounts[session.status] = (statusCounts[session.status] || 0) + 1;
  }

  const statusOrder: SessionStatus[] = [
    "starting",
    "working",
    "awaiting_input",
    "action_required",
    "exited",
    "idle",
    "done",
    "error",
  ];

  // Sessions needing attention
  const attentionSessions = allSessions
    .filter(
      ({ session }) =>
        session.status === "awaiting_input" || session.status === "action_required" || session.status === "exited",
    )
    .sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime());

  // Recent activity - last 5
  const recentSessions = [...allSessions]
    .sort((a, b) => new Date(b.session.lastActivity).getTime() - new Date(a.session.lastActivity).getTime())
    .slice(0, 5);

  return (
    <div className="explorer-dashboard">
      <h2>Dashboard</h2>

      {/* Status summary cards */}
      <div className="dashboard-status-cards">
        {statusOrder
          .filter((status) => (statusCounts[status] || 0) > 0)
          .map((status) => (
            <div
              key={status}
              className="dashboard-status-card"
              style={{ borderLeftColor: STATUS_CONFIG[status].color }}
            >
              <div className="dashboard-status-count" style={{ color: STATUS_CONFIG[status].color }}>
                {statusCounts[status]}
              </div>
              <div className="dashboard-status-label">{STATUS_CONFIG[status].label}</div>
            </div>
          ))}
      </div>

      {/* Sessions needing attention */}
      <h3>Needs Attention</h3>
      <div className="dashboard-session-list">
        {attentionSessions.length === 0 ? (
          <div className="dashboard-all-clear">All clear — no sessions need attention</div>
        ) : (
          attentionSessions.map(({ machineId, session }) => (
            // biome-ignore lint/a11y/useSemanticElements: complex list entry, not a simple button
            <div
              key={session.sessionId}
              className="dashboard-session-entry"
              onClick={() => onSelect(machineId, session.sessionId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(machineId, session.sessionId);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span
                className="status-dot"
                style={{
                  background: STATUS_CONFIG[session.status].color,
                  width: 6,
                  height: 6,
                }}
              />
              <span className="dashboard-session-name">{session.customName || session.slug}</span>
              <span className="dashboard-session-project">{session.projectName}</span>
              <span className="dashboard-session-time">{timeAgo(session.lastActivity)}</span>
            </div>
          ))
        )}
      </div>

      {/* Recent activity */}
      <h3>Recent Activity</h3>
      <div className="dashboard-session-list">
        {recentSessions.length === 0 ? (
          <div className="dashboard-all-clear">No sessions</div>
        ) : (
          recentSessions.map(({ machineId, session }) => (
            // biome-ignore lint/a11y/useSemanticElements: complex list entry
            <div
              key={session.sessionId}
              className="dashboard-session-entry"
              onClick={() => onSelect(machineId, session.sessionId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(machineId, session.sessionId);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span
                className="status-dot"
                style={{
                  background: STATUS_CONFIG[session.status].color,
                  width: 6,
                  height: 6,
                }}
              />
              <span className="dashboard-session-name">{session.customName || session.slug}</span>
              <span className="dashboard-session-message">
                {session.lastMessage
                  ? session.lastMessage.length > 80
                    ? `${session.lastMessage.slice(0, 80)}...`
                    : session.lastMessage
                  : ""}
              </span>
              <span className="dashboard-session-time">{timeAgo(session.lastActivity)}</span>
            </div>
          ))
        )}
      </div>

      {/* Machines overview (only if > 1 machine) */}
      {allMachines.length > 1 && (
        <>
          <h3>Machines</h3>
          <div className="dashboard-machines">
            {allMachines.map((machine) => (
              <div key={machine.machineId} className="dashboard-machine-row">
                <span className="dashboard-machine-hostname">{machine.hostname}</span>
                <span className="dashboard-machine-info">{machine.platform}</span>
                <span className="dashboard-machine-info">
                  {machine.sessions.length} session
                  {machine.sessions.length !== 1 ? "s" : ""}
                </span>
                {machine.multiplexers.length > 0 && (
                  <span className="dashboard-machine-info">{machine.multiplexers.join(", ")}</span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ExplorerLayout({
  machines,
  allMachines,
  groupMode,
  sortMode,
  hideIdle,
  timeFilter,
  autoDeleteOnClose,
  onOpenTerminal,
  onResume,
}: Props): React.JSX.Element {
  const [selected, setSelected] = useState<SelectedSession | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ machineId: string; sessionId: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  function startRename(machineId: string, session: SessionInfo) {
    setRenaming({ machineId, sessionId: session.sessionId });
    setRenameValue(session.customName || "");
  }

  async function commitRename() {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    setRenaming(null);

    try {
      await fetch(API.SESSIONS_RENAME, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId: renaming.machineId,
          sessionId: renaming.sessionId,
          name: trimmed,
        }),
      });
    } catch {
      // best-effort
    }
  }

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setRenaming(null);
  }

  const activeSession = selected
    ? machines.find((m) => m.machineId === selected.machineId)?.sessions.find((s) => s.sessionId === selected.sessionId)
    : null;

  // Clear selection when the selected session disappears
  useEffect(() => {
    if (!selected) return;
    const found = machines.some(
      (m) => m.machineId === selected.machineId && m.sessions.some((s) => s.sessionId === selected.sessionId),
    );
    if (!found) setSelected(null);
  }, [selected, machines]);

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleMachine(machineId: string) {
    setCollapsedMachines((prev) => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }

  const showMachineHeaders = machines.length > 1;

  return (
    <div className="explorer-layout">
      <div className="explorer-sidebar">
        {/* biome-ignore lint/a11y/useSemanticElements: sidebar navigation entry */}
        <div
          className={`explorer-dashboard-btn${selected === null ? " active" : ""}`}
          onClick={() => setSelected(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSelected(null);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
          Dashboard
        </div>
        {machines.map((machine) => {
          const timeSessions = filterSessionsByTime(machine.sessions, timeFilter);
          const groups = buildGroups(timeSessions, groupMode);
          const machineCollapsed = collapsedMachines.has(machine.machineId);

          return (
            <div key={machine.machineId} className="explorer-machine">
              {showMachineHeaders && (
                // biome-ignore lint/a11y/useSemanticElements: tree toggle header
                <div
                  className="explorer-machine-header"
                  onClick={() => toggleMachine(machine.machineId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleMachine(machine.machineId);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="explorer-chevron">{machineCollapsed ? "\u25b6" : "\u25bc"}</span>
                  <span>{machine.hostname}</span>
                  <span className="explorer-machine-count">{machine.sessions.length}</span>
                </div>
              )}

              {!machineCollapsed &&
                groups.map(([groupLabel, sessions]) => {
                  const filtered = hideIdle
                    ? sessions.filter((s) => s.status !== "idle" && s.status !== "done")
                    : sessions;
                  const sorted = sortSessions(filtered, sortMode);
                  if (sorted.length === 0) return null;

                  const groupKey = `${machine.machineId}:${groupLabel}`;
                  const groupCollapsed = collapsedGroups.has(groupKey);

                  return (
                    <div key={groupKey} className="explorer-group">
                      {groupLabel && (
                        // biome-ignore lint/a11y/useSemanticElements: tree toggle header
                        <div
                          className="explorer-group-header"
                          onClick={() => toggleGroup(groupKey)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleGroup(groupKey);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <span className="explorer-chevron">{groupCollapsed ? "\u25b6" : "\u25bc"}</span>
                          <span className="explorer-group-label">
                            {groupMode === "directory" ? shortenPath(groupLabel) : groupLabel}
                          </span>
                          <span className="explorer-group-count">{sorted.length}</span>
                        </div>
                      )}

                      {!groupCollapsed &&
                        sorted.map((session) => {
                          const isRenaming =
                            renaming?.machineId === machine.machineId && renaming?.sessionId === session.sessionId;

                          return (
                            // biome-ignore lint/a11y/useSemanticElements: tree session entry
                            <div
                              key={session.sessionId}
                              className={`explorer-session ${
                                selected?.sessionId === session.sessionId ? "selected" : ""
                              }`}
                              onClick={() =>
                                setSelected({
                                  machineId: machine.machineId,
                                  sessionId: session.sessionId,
                                })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelected({
                                    machineId: machine.machineId,
                                    sessionId: session.sessionId,
                                  });
                                }
                              }}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startRename(machine.machineId, session);
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <span
                                className="status-dot"
                                style={{
                                  background: STATUS_CONFIG[session.status].color,
                                  width: 6,
                                  height: 6,
                                }}
                              />
                              {isRenaming ? (
                                <input
                                  ref={renameInputRef}
                                  className="explorer-rename-input"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={commitRename}
                                  onKeyDown={handleRenameKeyDown}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder={session.slug}
                                />
                              ) : (
                                <>
                                  <span className="explorer-session-name">{session.customName || session.slug}</span>
                                  <span className="explorer-session-time">{timeAgo(session.lastActivity)}</span>
                                </>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  );
                })}

              {!machineCollapsed && timeSessions.length === 0 && (
                <div className="explorer-no-sessions">No sessions</div>
              )}
            </div>
          );
        })}

        {machines.length === 0 && <div className="explorer-no-sessions">No machines connected</div>}
      </div>

      <div className="explorer-detail">
        {activeSession && selected ? (
          <div className="explorer-detail-inner">
            <SessionDetail
              key={selected.sessionId}
              session={activeSession}
              machineId={selected.machineId}
              onOpenTerminal={(sessionName, multiplexer) =>
                onOpenTerminal(selected.machineId, sessionName, multiplexer)
              }
              onResume={(sessionId, projectDir, agentType) =>
                onResume(selected.machineId, sessionId, projectDir, agentType)
              }
              autoDeleteOnClose={autoDeleteOnClose}
              extraActions={
                <button
                  type="button"
                  className="action-btn kill-btn"
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Permanently delete session "${activeSession.customName || activeSession.slug}"?\n\nThis removes the conversation history and cannot be undone.`,
                      )
                    )
                      return;
                    try {
                      await fetch(API.SESSIONS_DELETE, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          machineId: selected.machineId,
                          sessionId: activeSession.sessionId,
                          multiplexer: activeSession.multiplexer,
                          multiplexerSession: activeSession.multiplexerSession,
                        }),
                      });
                    } catch {
                      // best-effort
                    }
                  }}
                >
                  Delete
                </button>
              }
            />
          </div>
        ) : (
          <ExplorerDashboard
            allMachines={allMachines}
            onSelect={(machineId, sessionId) => setSelected({ machineId, sessionId })}
          />
        )}
      </div>
    </div>
  );
}
