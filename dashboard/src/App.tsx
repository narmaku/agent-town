import {
  type AgentType,
  DEFAULT_KEYBOARD_SHORTCUTS,
  type MachineInfo,
  type SessionInfo,
  type Settings,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActivityFeed } from "./components/ActivityFeed";
import { ExplorerLayout } from "./components/ExplorerLayout";
import { KeyboardHelp } from "./components/KeyboardHelp";
import { LaunchAgentModal } from "./components/LaunchAgentModal";
import { buildGroups, filterSessionsByTime, MachineGroup, sortSessions } from "./components/MachineGroup";
import { ResumeAgentModal } from "./components/ResumeAgentModal";
import { SessionFullscreen } from "./components/SessionFullscreen";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalOverlay } from "./components/TerminalOverlay";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useWebSocket } from "./hooks/useWebSocket";
import { createBrowserLogger } from "./logger";
import { API } from "./utils";

const logger = createBrowserLogger("App");

export type SortMode = "recent" | "alphabetical" | "status";
export type TimeFilter = "24h" | "3d" | "7d" | "all";
export type GroupMode = "directory" | "status" | "none";
export type LayoutMode = "cards" | "explorer";

const STORAGE_KEYS = {
  THEME: "agentTown:theme",
  FONT_SIZE: "agentTown:fontSize",
  HIDE_IDLE: "agentTown:hideIdle",
  SORT_MODE: "agentTown:sortMode",
  TIME_FILTER: "agentTown:timeFilter",
  GROUP_MODE: "agentTown:groupMode",
  LAYOUT_MODE: "agentTown:layoutMode",
} as const;

const FOCUS_DELAY_MS = 50;

interface TerminalTarget {
  machineId: string;
  sessionName: string;
  multiplexer: TerminalMultiplexer;
}

interface ResumeTarget {
  machineId: string;
  sessionId: string;
  projectDir: string;
  agentType: AgentType;
}

interface FullscreenTarget {
  machineId: string;
  sessionId: string;
}

function loadLocalStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function filterMachinesBySearch(machines: MachineInfo[], query: string): MachineInfo[] {
  if (!query.trim()) return machines;
  const q = query.toLowerCase();
  return machines
    .map((machine) => ({
      ...machine,
      sessions: machine.sessions.filter((s) => {
        const name = (s.customName || s.slug).toLowerCase();
        const project = s.projectName.toLowerCase();
        const path = s.projectPath.toLowerCase();
        const cwd = s.cwd.toLowerCase();
        const branch = (s.gitBranch || "").toLowerCase();
        const status = s.status.replace("_", " ").toLowerCase();
        return (
          name.includes(q) ||
          project.includes(q) ||
          path.includes(q) ||
          cwd.includes(q) ||
          branch.includes(q) ||
          status.includes(q)
        );
      }),
    }))
    .filter((m) => m.sessions.length > 0);
}

export function App(): React.JSX.Element {
  const { machines, connected, activityFeed, unreadActivityCount, markActivityRead } = useWebSocket();
  const [activityOpen, setActivityOpen] = useState(false);
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [hideIdle, setHideIdle] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(null);
  const [fullscreen, setFullscreen] = useState<FullscreenTarget | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("24h");
  const [autoDeleteOnClose, setAutoDeleteOnClose] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => loadLocalStorage(STORAGE_KEYS.THEME, "dark"));
  const [fontSize, setFontSize] = useState<"small" | "medium" | "large">(() =>
    loadLocalStorage(STORAGE_KEYS.FONT_SIZE, "small"),
  );
  const [groupMode, setGroupMode] = useState<GroupMode>(() => loadLocalStorage(STORAGE_KEYS.GROUP_MODE, "directory"));
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadLocalStorage(STORAGE_KEYS.LAYOUT_MODE, "cards"));
  const [searchQuery, setSearchQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [enableKeyboardNav, setEnableKeyboardNav] = useState(true);
  const [keyboardShortcuts, setKeyboardShortcuts] = useState<Record<string, string>>({
    ...DEFAULT_KEYBOARD_SHORTCUTS,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  // Persist layout and group preferences
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.GROUP_MODE, JSON.stringify(groupMode));
  }, [groupMode]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LAYOUT_MODE, JSON.stringify(layoutMode));
  }, [layoutMode]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.THEME, JSON.stringify(theme));
  }, [theme]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.FONT_SIZE, JSON.stringify(fontSize));
  }, [fontSize]);

  const fetchSettings = useCallback(() => {
    fetch(API.SETTINGS)
      .then((r) => r.json())
      .then((s: Settings) => {
        setAutoDeleteOnClose(s.autoDeleteOnClose);
        setTheme(s.theme);
        setFontSize(s.fontSize);
        setEnableKeyboardNav(s.enableKeyboardNavigation);
        if (s.keyboardShortcuts) {
          setKeyboardShortcuts(s.keyboardShortcuts);
        }
      })
      .catch((err) => logger.warn("Failed to load settings:", err));
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Filter machines by search query
  const filteredMachines = useMemo(() => filterMachinesBySearch(machines, searchQuery), [machines, searchQuery]);

  // Flatten visible sessions for keyboard navigation, applying the same
  // filtering/sorting as MachineGroup so navigation order matches the UI.
  const allSessions = useMemo(() => {
    return filteredMachines.flatMap((machine) => {
      const timeSessions = filterSessionsByTime(machine.sessions, timeFilter);
      const groups = buildGroups(timeSessions, groupMode);
      return groups.flatMap(([, sessions]) => {
        const filtered = hideIdle ? sessions.filter((s) => s.status !== "idle" && s.status !== "done") : sessions;
        return sortSessions(filtered, sortMode);
      });
    });
  }, [filteredMachines, timeFilter, groupMode, hideIdle, sortMode]);

  // Build a lookup: sessionId -> { machineId, session }
  const sessionLookup = useMemo(() => {
    const map = new Map<string, { machineId: string; session: SessionInfo }>();
    for (const machine of filteredMachines) {
      for (const session of machine.sessions) {
        map.set(session.sessionId, { machineId: machine.machineId, session });
      }
    }
    return map;
  }, [filteredMachines]);

  const toggleExpanded = useCallback((sessionId: string) => {
    const card = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    if (card) {
      card.click();
    }
  }, []);

  const handleKeyboardFullscreen = useCallback(
    (sessionId: string) => {
      const entry = sessionLookup.get(sessionId);
      if (entry) {
        setFullscreen({ machineId: entry.machineId, sessionId });
      }
    },
    [sessionLookup],
  );

  const handleKeyboardTerminal = useCallback(
    (sessionId: string) => {
      const entry = sessionLookup.get(sessionId);
      if (entry?.session.multiplexer && entry.session.multiplexerSession) {
        setTerminal({
          machineId: entry.machineId,
          sessionName: entry.session.multiplexerSession,
          multiplexer: entry.session.multiplexer,
        });
      }
    },
    [sessionLookup],
  );

  const handleKeyboardSendMessage = useCallback((sessionId: string) => {
    const card = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    if (!card) return;

    // Expand the card first so the send message textarea is visible
    const isExpanded = card.classList.contains("expanded");
    if (!isExpanded) {
      card.click();
    }

    // Focus the textarea after a short delay to allow DOM to update
    setTimeout(() => {
      const textarea = card.querySelector<HTMLTextAreaElement>(".send-textarea");
      textarea?.focus();
    }, FOCUS_DELAY_MS);
  }, []);

  const handleKeyboardClose = useCallback(() => {
    if (fullscreen) {
      setFullscreen(null);
    } else if (terminal) {
      setTerminal(null);
    } else if (helpOpen) {
      setHelpOpen(false);
    }
  }, [fullscreen, terminal, helpOpen]);

  const { selectedSessionId } = useKeyboardNavigation({
    sessions: allSessions,
    enabled: enableKeyboardNav && layoutMode === "cards",
    shortcuts: keyboardShortcuts,
    onExpand: toggleExpanded,
    onFullscreen: handleKeyboardFullscreen,
    onOpenTerminal: handleKeyboardTerminal,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onFocusSendMessage: handleKeyboardSendMessage,
    onClose: handleKeyboardClose,
    onShowHelp: () => setHelpOpen((prev) => !prev),
  });

  // Derive live session for fullscreen from machines array (real-time updates)
  const fullscreenSession = fullscreen
    ? machines
        .find((m) => m.machineId === fullscreen.machineId)
        ?.sessions.find((s) => s.sessionId === fullscreen.sessionId)
    : null;

  const totalSessions = machines.reduce((sum, m) => sum + m.sessions.length, 0);
  const totalAttention = machines.reduce(
    (sum, m) => sum + m.sessions.filter((s) => s.status === "awaiting_input").length,
    0,
  );
  function handleOpenTerminal(machineId: string, sessionName: string, multiplexer: TerminalMultiplexer) {
    setTerminal({ machineId, sessionName, multiplexer });
  }

  return (
    <div className={`app theme-${theme} font-${fontSize} ${layoutMode === "explorer" ? "app-explorer" : ""}`}>
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
            {totalAttention > 0 && <span className="header-stat attention">{totalAttention} need attention</span>}
          </div>
          <button
            type="button"
            className="filter-toggle"
            onClick={() => setShowMobileFilters((v) => !v)}
            aria-label={showMobileFilters ? "Hide filters" : "Show filters"}
            title="Toggle filters"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className={`header-actions ${showMobileFilters ? "show" : ""}`}>
            <input
              ref={searchInputRef}
              className="search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              aria-label="Search sessions"
            />
            <select
              className="header-sort-select"
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value as GroupMode)}
              title="Group sessions"
            >
              <option value="directory">By directory</option>
              <option value="status">By status</option>
              <option value="none">No grouping</option>
            </select>
            <select
              className="header-sort-select"
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
              title="Filter by age"
            >
              <option value="24h">Last 24h</option>
              <option value="3d">Last 3 days</option>
              <option value="7d">Last 7 days</option>
              <option value="all">All sessions</option>
            </select>
            <select
              className="header-sort-select"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              title="Sort sessions"
            >
              <option value="recent">Recent first</option>
              <option value="alphabetical">A-Z</option>
              <option value="status">By status</option>
            </select>
            <button
              type="button"
              className={`header-btn ${hideIdle ? "active" : ""}`}
              onClick={() => setHideIdle((h) => !h)}
            >
              Hide Idle
            </button>
            <div className="layout-toggle">
              <button
                type="button"
                className={`layout-toggle-btn ${layoutMode === "cards" ? "active" : ""}`}
                onClick={() => setLayoutMode("cards")}
                title="Cards layout"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3zm8 0A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3zm-8 8A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3zm8 0A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5v-3z" />
                </svg>
              </button>
              <button
                type="button"
                className={`layout-toggle-btn ${layoutMode === "explorer" ? "active" : ""}`}
                onClick={() => setLayoutMode("explorer")}
                title="Explorer layout"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5H.5a.5.5 0 0 1-.5-.5v-13zM4 3h12v2H4V3zm0 4h12v2H4V7zm0 4h12v2H4v-2z" />
                </svg>
              </button>
            </div>
            <div className="activity-feed-wrapper">
              <button
                type="button"
                className={`header-btn header-btn-icon activity-toggle-btn ${activityOpen ? "active" : ""}`}
                onClick={() => {
                  setActivityOpen((prev) => {
                    if (!prev) markActivityRead();
                    return !prev;
                  });
                }}
                title="Activity feed"
                aria-label="Activity feed"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                {unreadActivityCount > 0 && (
                  <span className="activity-badge">{unreadActivityCount > 99 ? "99+" : unreadActivityCount}</span>
                )}
              </button>
              <ActivityFeed
                events={activityFeed}
                isOpen={activityOpen}
                onClose={() => setActivityOpen(false)}
                onNavigateToSession={(machineId, sessionId) => {
                  if (layoutMode === "cards") {
                    setFullscreen({ machineId, sessionId });
                  } else {
                    // In explorer mode, we cannot programmatically select — open fullscreen
                    setFullscreen({ machineId, sessionId });
                  }
                }}
              />
            </div>
            <button type="button" className="header-btn" onClick={() => setLaunchOpen(true)} title="Launch new agent">
              + New Agent
            </button>
            <button
              type="button"
              className="header-btn header-btn-icon"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {layoutMode === "cards" ? (
        <main className="app-main">
          {filteredMachines.length === 0 && machines.length === 0 && (
            <div className="empty-state">
              <h2>No machines connected</h2>
              <p>Start an agent on a machine to see its sessions here.</p>
              <pre>
                <code>AGENT_TOWN_SERVER=http://&lt;this-server&gt;:4680 bun run agent/src/index.ts</code>
              </pre>
            </div>
          )}
          {filteredMachines.length === 0 && machines.length > 0 && searchQuery && (
            <div className="empty-state">
              <h2>No matching sessions</h2>
              <p>No sessions match "{searchQuery}"</p>
            </div>
          )}
          {filteredMachines.map((machine) => (
            <MachineGroup
              key={machine.machineId}
              machine={machine}
              hideIdle={hideIdle}
              sortMode={sortMode}
              timeFilter={timeFilter}
              groupMode={groupMode}
              onOpenTerminal={(sessionName, multiplexer) =>
                handleOpenTerminal(machine.machineId, sessionName, multiplexer)
              }
              onResume={(sessionId, projectDir, agentType) =>
                setResumeTarget({ machineId: machine.machineId, sessionId, projectDir, agentType })
              }
              onFullscreen={(session) => setFullscreen({ machineId: machine.machineId, sessionId: session.sessionId })}
              autoDeleteOnClose={autoDeleteOnClose}
              selectedSessionId={selectedSessionId}
            />
          ))}
        </main>
      ) : (
        <ExplorerLayout
          machines={filteredMachines}
          allMachines={machines}
          groupMode={groupMode}
          sortMode={sortMode}
          hideIdle={hideIdle}
          timeFilter={timeFilter}
          autoDeleteOnClose={autoDeleteOnClose}
          onOpenTerminal={handleOpenTerminal}
          onResume={(machineId, sessionId, projectDir, agentType) =>
            setResumeTarget({ machineId, sessionId, projectDir, agentType })
          }
        />
      )}

      {terminal && (
        <TerminalOverlay
          machineId={terminal.machineId}
          sessionName={terminal.sessionName}
          multiplexer={terminal.multiplexer}
          onClose={() => setTerminal(null)}
        />
      )}

      {fullscreen && fullscreenSession && (
        <SessionFullscreen
          session={fullscreenSession}
          machineId={fullscreen.machineId}
          onClose={() => setFullscreen(null)}
          onOpenTerminal={(sessionName, multiplexer) => {
            setFullscreen(null);
            handleOpenTerminal(fullscreen.machineId, sessionName, multiplexer);
          }}
          onResume={(sessionId, projectDir, agentType) => {
            setFullscreen(null);
            setResumeTarget({ machineId: fullscreen.machineId, sessionId, projectDir, agentType });
          }}
          autoDeleteOnClose={autoDeleteOnClose}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          fetchSettings();
        }}
      />
      <LaunchAgentModal
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        machines={machines}
        onLaunched={(machineId, sessionName, multiplexer) => handleOpenTerminal(machineId, sessionName, multiplexer)}
      />
      <ResumeAgentModal
        open={!!resumeTarget}
        onClose={() => setResumeTarget(null)}
        machineId={resumeTarget?.machineId || ""}
        sessionId={resumeTarget?.sessionId || ""}
        projectDir={resumeTarget?.projectDir || ""}
        agentType={resumeTarget?.agentType || "claude-code"}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
