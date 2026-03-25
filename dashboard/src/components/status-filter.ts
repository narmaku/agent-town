import type { SessionInfo, SessionStatus } from "@agent-town/shared";

const STATUS_FILTER_STORAGE_KEY = "agentTown:explorerStatusFilters";

const VALID_STATUSES: ReadonlySet<string> = new Set<string>([
  "starting",
  "working",
  "awaiting_input",
  "action_required",
  "idle",
  "done",
  "error",
  "exited",
]);

/**
 * Toggle a status in the filter set. Returns a new set.
 * If the status is already in the set, remove it; otherwise add it.
 */
export function toggleStatusFilter(current: Set<SessionStatus>, status: SessionStatus): Set<SessionStatus> {
  const next = new Set(current);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next;
}

/**
 * Filter sessions by active status filters.
 * If no filters are active (empty set), all sessions pass through.
 */
export function filterSessionsByStatus<T extends { session: SessionInfo }>(
  sessions: T[],
  activeFilters: Set<SessionStatus>,
): T[] {
  if (activeFilters.size === 0) return sessions;
  return sessions.filter(({ session }) => activeFilters.has(session.status));
}

/**
 * Filter raw SessionInfo[] by active status filters.
 * If no filters are active (empty set), all sessions pass through.
 */
export function filterRawSessionsByStatus(sessions: SessionInfo[], activeFilters: Set<SessionStatus>): SessionInfo[] {
  if (activeFilters.size === 0) return sessions;
  return sessions.filter((s) => activeFilters.has(s.status));
}

/**
 * Load status filters from localStorage.
 * Returns an empty set if nothing is stored or on error.
 */
export function loadStatusFilters(): Set<SessionStatus> {
  try {
    const stored = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((v): v is SessionStatus => typeof v === "string" && VALID_STATUSES.has(v));
        return new Set(valid);
      }
    }
  } catch (_err) {
    // localStorage unavailable or invalid JSON
  }
  return new Set();
}

/**
 * Save status filters to localStorage.
 */
export function saveStatusFilters(filters: Set<SessionStatus>): void {
  try {
    localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify([...filters]));
  } catch (_err) {
    // localStorage unavailable
  }
}
