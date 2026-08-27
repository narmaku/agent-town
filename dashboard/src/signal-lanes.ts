import type { SessionStatus } from "@agent-town/shared";

/**
 * Signal Board lanes. The board is organised by STATUS, not by machine: a
 * session's column is the meaning. Position carries the signal so colour can
 * stay muted. Every SessionStatus maps to exactly one lane (see LANE_FOR_STATUS
 * — the test guards that the mapping stays total).
 */
export type SignalLaneId = "attention" | "working" | "settled";

export interface SignalLane {
  id: SignalLaneId;
  label: string;
  /** One-line description of what belongs here, shown under the lane title. */
  blurb: string;
  statuses: SessionStatus[];
}

export const SIGNAL_LANES: readonly SignalLane[] = [
  {
    id: "attention",
    label: "Needs you",
    blurb: "Waiting on a human",
    statuses: ["action_required", "awaiting_input", "error", "exited"],
  },
  {
    id: "working",
    label: "Working",
    blurb: "Agent is running",
    statuses: ["working", "starting"],
  },
  {
    id: "settled",
    label: "Settled",
    blurb: "Nothing to do",
    statuses: ["idle", "done"],
  },
] as const;

/** status -> lane id, derived from SIGNAL_LANES so the two never drift. */
const LANE_FOR_STATUS: Record<SessionStatus, SignalLaneId> = SIGNAL_LANES.reduce(
  (acc, lane) => {
    for (const status of lane.statuses) acc[status] = lane.id;
    return acc;
  },
  {} as Record<SessionStatus, SignalLaneId>,
);

export function laneForStatus(status: SessionStatus): SignalLaneId {
  return LANE_FOR_STATUS[status];
}

/**
 * Split items into the three lanes, preserving input order within each lane.
 * Generic over the item so it stays trivially testable with plain sessions and
 * reusable for the board's `{ session, machine }` rows.
 */
export function partitionIntoLanes<T>(
  items: readonly T[],
  getStatus: (item: T) => SessionStatus,
): Record<SignalLaneId, T[]> {
  const lanes: Record<SignalLaneId, T[]> = {
    attention: [],
    working: [],
    settled: [],
  };
  for (const item of items) {
    lanes[laneForStatus(getStatus(item))].push(item);
  }
  return lanes;
}
