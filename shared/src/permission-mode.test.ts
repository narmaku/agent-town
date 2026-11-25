import { describe, expect, test } from "bun:test";
import { getPermissionModeSupport, normalizePermissionMode, resolvePermissionMode } from "./permission-mode";

describe("permission modes", () => {
  test("defaults to harness configuration and preserves explicit mode precedence", () => {
    expect(resolvePermissionMode({}, "codex")).toBe("default");
    expect(resolvePermissionMode({ autonomous: true }, "codex")).toBe("yolo");
    expect(resolvePermissionMode({ autonomous: true, permissionMode: "auto" }, "codex")).toBe("auto");
    expect(resolvePermissionMode({ autonomous: true, permissionMode: "default" }, "claude-code")).toBe("default");
  });

  test("preserves previously ignored legacy autonomy without activating new bypasses", () => {
    expect(resolvePermissionMode({ autonomous: true }, "pi")).toBe("default");
    expect(resolvePermissionMode({ autonomous: true }, "opencode")).toBe("default");
    expect(resolvePermissionMode({ permissionMode: "yolo" }, "opencode")).toBe("yolo");
  });

  test("rejects malformed or unsupported input instead of silently changing permission", () => {
    for (const permissionMode of ["YOLO", "unsafe", true, null, 1]) {
      expect(() => resolvePermissionMode({ permissionMode }, "codex")).toThrow("permissionMode");
    }
    expect(() => resolvePermissionMode({ autonomous: "true" }, "codex")).toThrow("autonomous");
    expect(() => resolvePermissionMode({ permissionMode: "auto" }, "opencode")).toThrow("Auto");
    expect(() => resolvePermissionMode({ permissionMode: "yolo" }, "pi")).toThrow("YOLO");
  });

  test("normalizes unavailable UI selections and treats unknown harnesses conservatively", () => {
    expect(normalizePermissionMode("pi", "yolo")).toBe("default");
    expect(normalizePermissionMode("opencode", "auto")).toBe("default");
    expect(normalizePermissionMode("codex", "auto")).toBe("auto");
    expect(getPermissionModeSupport("future-agent", "auto").supported).toBe(false);
    expect(getPermissionModeSupport("toString", "yolo").supported).toBe(false);
    expect(getPermissionModeSupport("future-agent", "default").supported).toBe(true);
  });
});
