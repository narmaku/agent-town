import type { AgentType, MachineInfo, SessionInfo, SessionStatus, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { GroupMode, SortMode, TimeFilter } from "../App";
import { useResizable } from "../hooks/useResizable";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { AGENT_TYPE_LABELS, API, STATUS_CONFIG, shortenPath, timeAgo } from "../utils";
import { DashboardIcon } from "./icons";
import { buildGroups, filterSessionsByTime, sortSessions } from "./MachineGroup";
import { SessionDetail } from "./SessionDetail";

const SIDEBAR_DEFAULT_WIDTH = 300;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_STORAGE_KEY = "agentTown:explorerSidebarVisible";
const MOBILE_BREAKPOINT = 768;

interface Props {
  machines: MachineInfo[];
  allMachines: MachineInfo[];
  groupMode: GroupMode;
  sortMode: SortMode;
  hideIdle: boolean;
  timeFilter: TimeFilter;
  autoDeleteOnClose?: boolean;
  sidebarOpen: boolean;
  onSidebarClose: () => void;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (machineId: string, sessionId: string, projectDir: string, agentType: AgentType) => void;
  onLaunchAgent?: (machineId: string) => void;
  initialSelection?: { machineId: string; sessionId: string } | null;
  onInitialSelectionConsumed?: () => void;
}

interface SelectedSession {
  machineId: string;
  sessionId: string;
}

function SessionEntry({
  session,
  machineId,
  onSelect,
  showMessage,
}: {
  session: SessionInfo;
  machineId: string;
  onSelect: (machineId: string, sessionId: string) => void;
  showMessage?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: complex list entry, not a simple button
    <div
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
      <span className="status-dot" style={{ background: STATUS_CONFIG[session.status].color, width: 6, height: 6 }} />
      <span className="dashboard-session-name">{session.customName || session.slug}</span>
      {showMessage ? (
        <span className="dashboard-session-message">
          {session.lastMessage
            ? session.lastMessage.length > 80
              ? `${session.lastMessage.slice(0, 80)}...`
              : session.lastMessage
            : ""}
        </span>
      ) : (
        <span className="dashboard-session-project">{session.projectName}</span>
      )}
      <span className="dashboard-session-time">{timeAgo(session.lastActivity)}</span>
    </div>
  );
}

function MachineCard({
  machine,
  onLaunchAgent,
}: {
  machine: MachineInfo;
  onLaunchAgent?: (machineId: string) => void;
}) {
  const agentTypes = machine.availableAgents?.length
    ? machine.availableAgents
    : [...new Set(machine.sessions.map((s) => s.agentType))];
  const activeSessions = machine.sessions.filter(
    (s) => s.status === "working" || s.status === "awaiting_input" || s.status === "starting",
  );
  const totalTokensIn = machine.sessions.reduce((sum, s) => sum + (s.totalInputTokens ?? 0), 0);
  const totalTokensOut = machine.sessions.reduce((sum, s) => sum + (s.totalOutputTokens ?? 0), 0);

  return (
    <div className="dashboard-machine-card">
      <div className="dashboard-machine-card-header">
        <span className="dashboard-machine-hostname-row">
          <span className="dashboard-machine-hostname">{machine.hostname}</span>
          {onLaunchAgent && (
            <button
              type="button"
              className="machine-launch-btn"
              onClick={(e) => {
                e.stopPropagation();
                onLaunchAgent(machine.machineId);
              }}
              title={`Launch new agent on ${machine.hostname}`}
              aria-label={`Launch new agent on ${machine.hostname}`}
            >
              +
            </button>
          )}
        </span>
        <span
          className="dashboard-machine-heartbeat"
          title={`Last heartbeat: ${new Date(machine.lastHeartbeat).toLocaleString()}`}
        >
          {timeAgo(machine.lastHeartbeat)}
        </span>
      </div>

      <div className="dashboard-machine-details">
        <div className="dashboard-machine-detail-row">
          <span className="dashboard-machine-detail-label">Platform</span>
          <span className="dashboard-machine-detail-value">{machine.platform}</span>
        </div>
        <div className="dashboard-machine-detail-row">
          <span className="dashboard-machine-detail-label">Sessions</span>
          <span className="dashboard-machine-detail-value">
            {machine.sessions.length} total
            {activeSessions.length > 0 && (
              <span style={{ color: "var(--green)" }}> ({activeSessions.length} active)</span>
            )}
          </span>
        </div>
        {machine.multiplexers.length > 0 && (
          <div className="dashboard-machine-detail-row">
            <span className="dashboard-machine-detail-label">Multiplexer</span>
            <span className="dashboard-machine-detail-value">{machine.multiplexers.join(", ")}</span>
          </div>
        )}
        {(totalTokensIn > 0 || totalTokensOut > 0) && (
          <div className="dashboard-machine-detail-row">
            <span className="dashboard-machine-detail-label">Tokens</span>
            <span className="dashboard-machine-detail-value mono">
              {totalTokensIn.toLocaleString()} in / {totalTokensOut.toLocaleString()} out
            </span>
          </div>
        )}
      </div>

      {agentTypes.length > 0 && (
        <div className="dashboard-machine-agents">
          {agentTypes.map((t) => (
            <span key={t} className={`dashboard-machine-agent-badge agent-${t}`}>
              {AGENT_TYPE_LABELS[t] || t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ExplorerDashboard({
  allMachines,
  onSelect,
  onLaunchAgent,
}: {
  allMachines: MachineInfo[];
  onSelect: (machineId: string, sessionId: string) => void;
  onLaunchAgent?: (machineId: string) => void;
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
      <div className="dashboard-columns">
        {/* Left column: sessions overview */}
        <div className="dashboard-col-left">
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
                <SessionEntry key={session.sessionId} session={session} machineId={machineId} onSelect={onSelect} />
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
                <SessionEntry
                  key={session.sessionId}
                  session={session}
                  machineId={machineId}
                  onSelect={onSelect}
                  showMessage
                />
              ))
            )}
          </div>
        </div>

        {/* Right column: machines */}
        <div className="dashboard-col-right">
          <h2>Machines</h2>
          <div className="dashboard-machines">
            {allMachines.map((machine) => (
              <MachineCard key={machine.machineId} machine={machine} onLaunchAgent={onLaunchAgent} />
            ))}
          </div>
        </div>
      </div>
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
  sidebarOpen,
  onSidebarClose,
  onOpenTerminal,
  onResume,
  onLaunchAgent,
  initialSelection,
  onInitialSelectionConsumed,
}: Props): React.JSX.Element {
  const [selected, setSelected] = useState<SelectedSession | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ machineId: string; sessionId: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored !== null) return stored === "true";
    } catch (_err) {
      // localStorage unavailable
    }
    return true;
  });
  const windowWidth = useWindowWidth();
  const isMobile = windowWidth < MOBILE_BREAKPOINT;
  const sidebarResize = useResizable({
    storageKey: "explorerSidebarWidth",
    defaultSize: SIDEBAR_DEFAULT_WIDTH,
    minSize: SIDEBAR_MIN_WIDTH,
    maxSize: SIDEBAR_MAX_WIDTH,
    side: "left",
  });

  // Close sidebar on Escape key (for mobile overlay)
  useEffect(() => {
    if (!sidebarOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onSidebarClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen, onSidebarClose]);

  function selectSession(machineId: string, sessionId: string) {
    setSelected({ machineId, sessionId });
    onSidebarClose();
  }

  function selectDashboard() {
    setSelected(null);
    onSidebarClose();
  }

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
    } catch (_err) {
      // best-effort
    }
  }

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setRenaming(null);
  }

  const selectedMachine = selected ? machines.find((m) => m.machineId === selected.machineId) : null;
  const activeSession = selectedMachine?.sessions.find((s) => s.sessionId === selected?.sessionId) ?? null;

  // Clear selection when the selected session disappears, but follow
  // pending-* → real session transitions instead of clearing
  useEffect(() => {
    if (!selected) return;
    const found = machines.some(
      (m) => m.machineId === selected.machineId && m.sessions.some((s) => s.sessionId === selected.sessionId),
    );
    if (found) return;

    // If the selected session was a pending-* placeholder, look for the
    // real session that replaced it (matched by multiplexerSession name)
    if (selected.sessionId.startsWith("pending-")) {
      const muxName = selected.sessionId.slice(8); // "pending-<muxName>" → "<muxName>"
      const machine = machines.find((m) => m.machineId === selected.machineId);
      const replacement = machine?.sessions.find(
        (s) => s.multiplexerSession === muxName && !s.sessionId.startsWith("pending-"),
      );
      if (replacement) {
        setSelected({ machineId: selected.machineId, sessionId: replacement.sessionId });
        return;
      }
    }

    setSelected(null);
  }, [selected, machines]);

  // Sync initialSelection from parent (e.g. activity feed navigation)
  useEffect(() => {
    if (initialSelection) {
      setSelected({ machineId: initialSelection.machineId, sessionId: initialSelection.sessionId });
      onInitialSelectionConsumed?.();
    }
  }, [initialSelection, onInitialSelectionConsumed]);

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
    <div className={`explorer-layout${sidebarResize.isDragging ? " resizing" : ""}`}>
      {/* Backdrop for mobile sidebar overlay */}
      <div className={`sidebar-backdrop${sidebarOpen ? " open" : ""}`} onClick={onSidebarClose} aria-hidden="true" />
      <div
        className={`explorer-sidebar${sidebarOpen ? " open" : ""}${!sidebarVisible && !isMobile ? " collapsed" : ""}`}
        style={{ "--panel-width": `${sidebarResize.size}px` } as React.CSSProperties}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: sidebar navigation entry */}
        <div
          className={`explorer-dashboard-btn${selected === null ? " active" : ""}`}
          onClick={selectDashboard}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectDashboard();
            }
          }}
          role="button"
          tabIndex={0}
        >
          <DashboardIcon />
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
                  {onLaunchAgent && (
                    <button
                      type="button"
                      className="machine-launch-btn machine-launch-btn-sidebar"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLaunchAgent(machine.machineId);
                      }}
                      title={`Launch new agent on ${machine.hostname}`}
                      aria-label={`Launch new agent on ${machine.hostname}`}
                    >
                      +
                    </button>
                  )}
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
                              onClick={() => selectSession(machine.machineId, session.sessionId)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  selectSession(machine.machineId, session.sessionId);
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

      {sidebarVisible && !isMobile && (
        /* biome-ignore lint/a11y/noStaticElementInteractions: resize handle requires mouse interaction */
        <div
          className={`resize-handle resize-handle-left${sidebarResize.isDragging ? " active" : ""}`}
          onMouseDown={sidebarResize.handleMouseDown}
          onDoubleClick={sidebarResize.resetSize}
          title="Drag to resize, double-click to reset"
        />
      )}

      {!isMobile && (
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={() => {
            const next = !sidebarVisible;
            setSidebarVisible(next);
            try {
              localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
            } catch (_err) {
              // localStorage unavailable
            }
          }}
          aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarVisible ? "\u25C0" : "\u25B6"}
        </button>
      )}

      <div className="explorer-detail">
        {activeSession && selected ? (
          <div className="explorer-detail-inner">
            <SessionDetail
              key={selected.sessionId}
              session={activeSession}
              machineId={selected.machineId}
              machineName={selectedMachine?.hostname}
              onOpenTerminalFullscreen={(sessionName, multiplexer) =>
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
                    } catch (_err) {
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
            onSelect={(machineId, sessionId) => selectSession(machineId, sessionId)}
            onLaunchAgent={onLaunchAgent}
          />
        )}
      </div>
    </div>
  );
}
