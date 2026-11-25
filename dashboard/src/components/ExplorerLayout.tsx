import type { AgentType, MachineInfo, TerminalMultiplexer } from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { GroupMode, SortMode, TimeFilter } from "../App";
import { type ExplorerSelection, resolveExplorerSelection } from "../explorer-selection";
import { useResizable } from "../hooks/useResizable";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { buildGroups, filterIdleSessions, filterSessionsByTime, sortSessions } from "../session-grouping";
import { getAgentTypeDisplay, STATUS_CONFIG, shortenPath, timeAgo } from "../utils";
import { SessionDetail } from "./SessionDetail";

const MOBILE_BREAKPOINT = 768;

interface Props {
  machines: MachineInfo[];
  allMachines: MachineInfo[];
  groupMode: GroupMode;
  sortMode: SortMode;
  timeFilter: TimeFilter;
  hideIdle: boolean;
  selection: ExplorerSelection | null;
  onSelectionChange: (selection: ExplorerSelection | null) => void;
  onOpenTerminal: (machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (machineId: string, sessionId: string, projectDir: string, agentType: AgentType) => void;
  onLaunchAgent: (machineId: string) => void;
  autoDeleteOnClose: boolean;
}

/** Persistent session navigation alongside the current chat or terminal. */
export function ExplorerLayout({
  machines,
  allMachines,
  groupMode,
  sortMode,
  timeFilter,
  hideIdle,
  selection,
  onSelectionChange,
  onOpenTerminal,
  onResume,
  onLaunchAgent,
  autoDeleteOnClose,
}: Props): React.JSX.Element {
  const isMobile = useWindowWidth() < MOBILE_BREAKPOINT;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResize = useResizable({
    storageKey: "explorerSidebarWidth",
    defaultSize: 300,
    minSize: 220,
    maxSize: 480,
    side: "left",
  });
  const resolved = resolveExplorerSelection(allMachines, selection);
  const selectedMachine = resolved.machine;
  const selectedSession = resolved.session;

  useEffect(() => {
    if (resolved.selection !== selection) onSelectionChange(resolved.selection);
  }, [selection, resolved.selection, onSelectionChange]);

  useEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSidebarOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isMobile, sidebarOpen]);

  function closeSidebar(): void {
    setSidebarOpen(false);
    if (isMobile) toggleRef.current?.focus();
  }

  return (
    <main className={`explorer-layout${sidebarResize.isDragging ? " resizing" : ""}`}>
      <div className="explorer-mobile-toolbar">
        <button
          ref={toggleRef}
          type="button"
          className="header-btn"
          aria-label={sidebarOpen ? "Hide session list" : "Show session list"}
          aria-expanded={sidebarOpen}
          aria-controls="explorer-sidebar"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          Sessions
        </button>
        <span>{resolved.session?.customName || resolved.session?.slug || "Explorer"}</span>
      </div>
      {isMobile && sidebarOpen && (
        <button type="button" className="explorer-backdrop" aria-label="Close session list" onClick={closeSidebar} />
      )}
      <aside
        id="explorer-sidebar"
        ref={sidebarRef}
        className="explorer-sidebar"
        aria-label="Session explorer"
        hidden={isMobile && !sidebarOpen}
        style={{ "--sidebar-width": `${sidebarResize.size}px` } as React.CSSProperties}
      >
        <div className="explorer-sidebar-heading">
          <h2>Sessions</h2>
          {isMobile && (
            <button type="button" className="header-btn" aria-label="Close session list" onClick={closeSidebar}>
              Close
            </button>
          )}
        </div>
        <nav aria-label="Agent sessions" className="explorer-session-list">
          {machines.length === 0 && (
            <p className="explorer-list-empty">
              {allMachines.length === 0 ? "No machines connected" : "No matching sessions"}
            </p>
          )}
          {machines.map((machine) => {
            const groups = buildGroups(
              filterIdleSessions(filterSessionsByTime(machine.sessions, timeFilter), hideIdle),
              groupMode,
            );
            const count = groups.reduce((total, [, sessions]) => total + sessions.length, 0);
            return (
              <section
                key={machine.machineId}
                className="explorer-machine"
                aria-label={`Sessions on ${machine.hostname}`}
              >
                <header className="explorer-machine-heading">
                  <h3 title={machine.hostname}>{machine.hostname}</h3>
                  <span>{count}</span>
                  <button
                    type="button"
                    className="machine-launch-btn"
                    aria-label={`Launch new agent on ${machine.hostname}`}
                    title={`Launch new agent on ${machine.hostname}`}
                    onClick={() => {
                      onLaunchAgent(machine.machineId);
                      closeSidebar();
                    }}
                  >
                    +
                  </button>
                </header>
                {count === 0 && <p className="explorer-list-empty">No sessions match the current filters</p>}
                {groups.map(([label, sessions]) => {
                  const rows = sortSessions(sessions, sortMode).map((session) => {
                    const name = session.customName || session.slug;
                    const selected =
                      resolved.selection?.machineId === machine.machineId &&
                      resolved.selection.sessionId === session.sessionId;
                    const status = STATUS_CONFIG[session.status];
                    return (
                      <button
                        key={session.sessionId}
                        type="button"
                        className="explorer-session"
                        data-status={session.status}
                        aria-label={`${name} on ${machine.hostname}, ${status.label}`}
                        aria-current={selected ? "true" : undefined}
                        onClick={() => {
                          onSelectionChange({ machineId: machine.machineId, sessionId: session.sessionId });
                          closeSidebar();
                        }}
                        title={`${name}\n${session.projectPath}\n${session.lastMessage}`}
                      >
                        <span className="explorer-session-top">
                          <span className="status-dot" aria-hidden="true" />
                          <span className="explorer-session-name">{name}</span>
                          <span className={`agent-type-badge agent-${session.agentType}`}>
                            {getAgentTypeDisplay(session.agentType).shortLabel}
                          </span>
                        </span>
                        <span className="explorer-session-meta">
                          <span>{status.label}</span>
                          <span>{timeAgo(session.lastActivity)}</span>
                        </span>
                        {session.lastMessage && <span className="explorer-session-preview">{session.lastMessage}</span>}
                      </button>
                    );
                  });
                  return label ? (
                    <details key={label} className="explorer-group" open>
                      <summary title={label}>{groupMode === "directory" ? shortenPath(label) : label}</summary>
                      {rows}
                    </details>
                  ) : (
                    <div key="ungrouped">{rows}</div>
                  );
                })}
              </section>
            );
          })}
        </nav>
      </aside>
      {!isMobile && (
        // biome-ignore lint/a11y/noStaticElementInteractions: resize handle requires mouse interaction
        <div
          className={`resize-handle resize-handle-right${sidebarResize.isDragging ? " active" : ""}`}
          onMouseDown={sidebarResize.handleMouseDown}
          onDoubleClick={sidebarResize.resetSize}
          title="Drag to resize session list, double-click to reset"
        />
      )}
      <section className="explorer-detail" aria-label="Selected session">
        {selectedSession && selectedMachine ? (
          <SessionDetail
            key={JSON.stringify([selectedMachine.machineId, selectedSession.sessionId])}
            session={selectedSession}
            machineId={selectedMachine.machineId}
            machineName={selectedMachine.hostname}
            autoDeleteOnClose={autoDeleteOnClose}
            onOpenTerminalFullscreen={(name, multiplexer) =>
              onOpenTerminal(selectedMachine.machineId, name, multiplexer)
            }
            onResume={(sessionId, projectDir, agentType) =>
              onResume(selectedMachine.machineId, sessionId, projectDir, agentType)
            }
          />
        ) : (
          <div className="empty-state">
            <h2>{resolved.selection ? "Starting session..." : "Select a session"}</h2>
            <p>
              {resolved.selection
                ? "Waiting for the agent to report its session."
                : "Choose a session from the list to open its chat or terminal here."}
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
