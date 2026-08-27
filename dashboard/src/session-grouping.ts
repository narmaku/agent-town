import type { SessionInfo, SessionStatus } from "@agent-town/shared";

import type { GroupMode, SortMode, TimeFilter } from "./App";

const TIME_FILTER_MS: Record<TimeFilter, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

/**
 * Rank used by the "status" sort and by the order of status groups. Lower sorts
 * first, so it reads top-down as "how much does this want a human right now".
 */
const STATUS_ORDER: Record<SessionStatus, number> = {
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

const STATUS_GROUP_ORDER: SessionStatus[] = (Object.keys(STATUS_ORDER) as SessionStatus[]).sort(
  (a, b) => STATUS_ORDER[a] - STATUS_ORDER[b],
);

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
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      default:
        return 0;
    }
  });
}

/**
 * Drops sessions older than the filter window. A session with a live multiplexer
 * always survives: it is attached to a terminal the user can still switch to, so
 * hiding it because it has been quiet would lose a session they can act on.
 */
export function filterSessionsByTime(sessions: SessionInfo[], timeFilter: TimeFilter): SessionInfo[] {
  const maxAge = TIME_FILTER_MS[timeFilter];
  const now = Date.now();
  return sessions.filter((s) => {
    if (s.multiplexerSession) return true;
    return now - new Date(s.lastActivity).getTime() < maxAge;
  });
}

/** Hides idle and finished sessions when the "Hide Idle" toggle is on. */
export function filterIdleSessions(sessions: SessionInfo[], hideIdle: boolean): SessionInfo[] {
  if (!hideIdle) return sessions;
  return sessions.filter((s) => s.status !== "idle" && s.status !== "done");
}

/** Returns `[groupLabel, sessions]` pairs; a blank label means "do not render a header". */
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

/**
 * The exact list a machine's rows are built from, in render order. Keyboard
 * navigation walks the same function so the j/k order always matches what is
 * on screen — the two drifting apart is the classic bug here.
 */
export function visibleSessions(
  sessions: SessionInfo[],
  options: { timeFilter: TimeFilter; groupMode: GroupMode; hideIdle: boolean; sortMode: SortMode },
): SessionInfo[] {
  const groups = buildGroups(filterSessionsByTime(sessions, options.timeFilter), options.groupMode);
  return groups.flatMap(([, group]) => sortSessions(filterIdleSessions(group, options.hideIdle), options.sortMode));
}
