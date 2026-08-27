import { describe, expect, test } from "bun:test";
import type { SessionStatus } from "@agent-town/shared";

import { laneForStatus, partitionIntoLanes, SIGNAL_LANES, type SignalLaneId } from "./signal-lanes";

const ALL_STATUSES: SessionStatus[] = [
  "starting",
  "working",
  "awaiting_input",
  "action_required",
  "idle",
  "done",
  "error",
  "exited",
];

describe("signal lanes", () => {
  test("every status maps to exactly one lane", () => {
    for (const status of ALL_STATUSES) {
      const matches = SIGNAL_LANES.filter((lane) => lane.statuses.includes(status));
      expect(matches).toHaveLength(1);
    }
  });

  test("no lane lists a status that is not part of the union", () => {
    const known = new Set<string>(ALL_STATUSES);
    for (const lane of SIGNAL_LANES) {
      for (const status of lane.statuses) {
        expect(known.has(status)).toBe(true);
      }
    }
  });

  test("laneForStatus routes attention statuses to the Needs you lane", () => {
    expect(laneForStatus("action_required")).toBe("attention");
    expect(laneForStatus("awaiting_input")).toBe("attention");
    expect(laneForStatus("error")).toBe("attention");
    expect(laneForStatus("exited")).toBe("attention");
  });

  test("laneForStatus routes active statuses to the Working lane", () => {
    expect(laneForStatus("working")).toBe("working");
    expect(laneForStatus("starting")).toBe("working");
  });

  test("laneForStatus routes quiet statuses to the Settled lane", () => {
    expect(laneForStatus("idle")).toBe("settled");
    expect(laneForStatus("done")).toBe("settled");
  });
});

describe("partitionIntoLanes", () => {
  test("groups items by lane and preserves input order within a lane", () => {
    const items = [
      { id: "a", status: "working" as SessionStatus },
      { id: "b", status: "action_required" as SessionStatus },
      { id: "c", status: "idle" as SessionStatus },
      { id: "d", status: "starting" as SessionStatus },
      { id: "e", status: "awaiting_input" as SessionStatus },
    ];
    const lanes = partitionIntoLanes(items, (i) => i.status);
    expect(lanes.attention.map((i) => i.id)).toEqual(["b", "e"]);
    expect(lanes.working.map((i) => i.id)).toEqual(["a", "d"]);
    expect(lanes.settled.map((i) => i.id)).toEqual(["c"]);
  });

  test("returns all three lanes even when some are empty", () => {
    const lanes = partitionIntoLanes([{ status: "idle" as SessionStatus }], (i) => i.status);
    const ids: SignalLaneId[] = ["attention", "working", "settled"];
    for (const id of ids) expect(lanes[id]).toBeDefined();
    expect(lanes.attention).toHaveLength(0);
    expect(lanes.working).toHaveLength(0);
    expect(lanes.settled).toHaveLength(1);
  });
});
