import { describe, expect, test } from "bun:test";
import { resolveSelectedMachineId } from "./LaunchAgentModal";

describe("resolveSelectedMachineId", () => {
  test("returns user-selected machineId when set", () => {
    const result = resolveSelectedMachineId("user-selected", undefined, "first-machine");
    expect(result).toBe("user-selected");
  });

  test("returns initialMachineId when no user selection and initialMachineId is provided", () => {
    const result = resolveSelectedMachineId("", "initial-machine", "first-machine");
    expect(result).toBe("initial-machine");
  });

  test("falls back to first machine when no user selection and no initialMachineId", () => {
    const result = resolveSelectedMachineId("", undefined, "first-machine");
    expect(result).toBe("first-machine");
  });

  test("returns empty string when nothing is available", () => {
    const result = resolveSelectedMachineId("", undefined, "");
    expect(result).toBe("");
  });

  test("user selection takes priority over initialMachineId", () => {
    const result = resolveSelectedMachineId("user-selected", "initial-machine", "first-machine");
    expect(result).toBe("user-selected");
  });

  test("initialMachineId takes priority over first machine", () => {
    const result = resolveSelectedMachineId("", "initial-machine", "first-machine");
    expect(result).toBe("initial-machine");
  });

  test("treats empty-string initialMachineId same as undefined and falls back to first machine", () => {
    const result = resolveSelectedMachineId("", "", "first-machine");
    expect(result).toBe("first-machine");
  });

  test("returns empty string when all inputs are empty strings", () => {
    const result = resolveSelectedMachineId("", "", "");
    expect(result).toBe("");
  });
});
