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
import {
  ActivityIcon,
  CardsLayoutIcon,
  ExplorerLayoutIcon,
  MenuIcon,
  SettingsIcon,
  SidebarIcon,
} from "./components/Icons";
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

const DEEP_SEARCH_MIN_CHARS = 3;
const DEEP_SEARCH_DEBOUNCE_MS = 500;

interface DeepSearchResult {
  sessionId: string;
  agentType: AgentType;
  snippet: string;
  matchCount: number;
}

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
  } catch (_err) {
    return fallback;
  }
}

function filterMachinesBySearch(
  machines: MachineInfo[],
  query: string,
  deepSearchSessionIds?: Set<string>,
): MachineInfo[] {
  if (!query.trim()) return machines;
  const q = query.toLowerCase();
  return machines
    .map((machine) => ({
      ...machine,
      sessions: machine.sessions.filter((s) => {
        // Check deep search results first
        if (deepSearchSessionIds?.has(s.sessionId)) return true;

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
  const [deepSearch, setDeepSearch] = useState(false);
  const [deepSearchLoading, setDeepSearchLoading] = useState(false);
  const [deepSearchSessionIds, setDeepSearchSessionIds] = useState<Set<string>>(new Set());
  const deepSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [enableKeyboardNav, setEnableKeyboardNav] = useState(true);
  const [keyboardShortcuts, setKeyboardShortcuts] = useState<Record<string, string>>({
    ...DEFAULT_KEYBOARD_SHORTCUTS,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  // Deep search: debounced API call when deepSearch is enabled and query has 3+ chars
  useEffect(() => {
    if (deepSearchTimerRef.current) {
      clearTimeout(deepSearchTimerRef.current);
      deepSearchTimerRef.current = null;
    }

    if (!deepSearch || searchQuery.length < DEEP_SEARCH_MIN_CHARS) {
      setDeepSearchSessionIds(new Set());
      setDeepSearchLoading(false);
      return;
    }

    setDeepSearchLoading(true);

    deepSearchTimerRef.current = setTimeout(() => {
      const fetchDeepSearch = async (): Promise<void> => {
        const allIds = new Set<string>();
        const promises = machines.map(async (machine) => {
          try {
            const params = new URLSearchParams({
              machineId: machine.machineId,
              query: searchQuery,
              limit: "50",
            });
            const resp = await fetch(`${API.SEARCH_MESSAGES}?${params.toString()}`);
            if (!resp.ok) return;
            const data = (await resp.json()) as { results?: DeepSearchResult[] };
            if (data.results) {
              for (const r of data.results) {
                allIds.add(r.sessionId);
              }
            }
          } catch (err) {
            logger.warn(
              `Deep search failed for machine ${machine.machineId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });

        await Promise.all(promises);
        setDeepSearchSessionIds(allIds);
        setDeepSearchLoading(false);
      };

      fetchDeepSearch().catch((err) => {
        logger.warn(`Deep search failed: ${err instanceof Error ? err.message : String(err)}`);
        setDeepSearchLoading(false);
      });
    }, DEEP_SEARCH_DEBOUNCE_MS);

    return () => {
      if (deepSearchTimerRef.current) {
        clearTimeout(deepSearchTimerRef.current);
        deepSearchTimerRef.current = null;
      }
    };
  }, [deepSearch, searchQuery, machines]);

  // Filter machines by search query (including deep search results)
  const filteredMachines = useMemo(
    () =>
      filterMachinesBySearch(
        machines,
        searchQuery,
        deepSearch && deepSearchSessionIds.size > 0 ? deepSearchSessionIds : undefined,
      ),
    [machines, searchQuery, deepSearch, deepSearchSessionIds],
  );

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
  const fullscreenMachine = fullscreen ? machines.find((m) => m.machineId === fullscreen.machineId) : null;
  const fullscreenSession = fullscreenMachine?.sessions.find((s) => s.sessionId === fullscreen?.sessionId) ?? null;

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
          {layoutMode === "explorer" && (
            <button
              type="button"
              className="sidebar-toggle-header"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Close session navigator" : "Open session navigator"}
            >
              <SidebarIcon />
            </button>
          )}
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
            <MenuIcon />
          </button>
          <div className={`header-actions ${showMobileFilters ? "show" : ""}`}>
            <div className="search-group">
              <input
                ref={searchInputRef}
                className={`search-input ${deepSearch ? "deep-search-active" : ""}`}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sessions..."
                aria-label="Search sessions"
              />
              <label className="deep-search-toggle" title="Search in session message history">
                <input
                  type="checkbox"
                  checked={deepSearch}
                  onChange={(e) => setDeepSearch(e.target.checked)}
                  aria-label="Search in message history"
                />
                <span className="deep-search-label">{deepSearchLoading ? "Searching..." : "Search history"}</span>
              </label>
            </div>
            <div className="filter-group">
              <label className="filter-label" htmlFor="filter-group-select">
                Group
              </label>
              <select
                id="filter-group-select"
                className="header-sort-select"
                value={groupMode}
                onChange={(e) => setGroupMode(e.target.value as GroupMode)}
                title="Group sessions"
                aria-label="Group sessions"
              >
                <option value="directory">By directory</option>
                <option value="status">By status</option>
                <option value="none">No grouping</option>
              </select>
            </div>
            <div className="filter-group">
              <label className="filter-label" htmlFor="filter-time-select">
                Time
              </label>
              <select
                id="filter-time-select"
                className="header-sort-select"
                value={timeFilter}
                onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
                title="Filter by age"
                aria-label="Filter by age"
              >
                <option value="24h">Last 24h</option>
                <option value="3d">Last 3 days</option>
                <option value="7d">Last 7 days</option>
                <option value="all">All sessions</option>
              </select>
            </div>
            <div className="filter-group">
              <label className="filter-label" htmlFor="filter-sort-select">
                Sort
              </label>
              <select
                id="filter-sort-select"
                className="header-sort-select"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                title="Sort sessions"
                aria-label="Sort sessions"
              >
                <option value="recent">Recent first</option>
                <option value="alphabetical">A-Z</option>
                <option value="status">By status</option>
              </select>
            </div>
            <div className="header-toolbar">
              <button
                type="button"
                className={`header-btn ${hideIdle ? "active" : ""}`}
                onClick={() => setHideIdle((h) => !h)}
                aria-label={hideIdle ? "Show idle sessions" : "Hide idle sessions"}
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
                  <CardsLayoutIcon />
                </button>
                <button
                  type="button"
                  className={`layout-toggle-btn ${layoutMode === "explorer" ? "active" : ""}`}
                  onClick={() => setLayoutMode("explorer")}
                  title="Explorer layout"
                >
                  <ExplorerLayoutIcon />
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
                  <ActivityIcon />
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
                <SettingsIcon />
              </button>
            </div>
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
          sidebarOpen={sidebarOpen}
          onSidebarClose={() => setSidebarOpen(false)}
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
          machineName={fullscreenMachine?.hostname}
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
