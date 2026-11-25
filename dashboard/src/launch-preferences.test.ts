import { describe, expect, test } from "bun:test";
import {
  LAST_PERMISSION_MODE_KEY,
  loadLastLaunchDirectory,
  loadLastPermissionMode,
  saveLastLaunchDirectory,
  saveLastPermissionMode,
} from "./launch-preferences";

function makeStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

describe("last successful launch preferences", () => {
  test("defaults missing/malformed modes and normalizes unsupported remembered modes", () => {
    const storage = makeStorage();
    expect(loadLastPermissionMode("codex", storage)).toBe("default");
    for (const value of ["invalid-json", '"unsafe"', "null", "{}", "42"]) {
      storage.setItem(LAST_PERMISSION_MODE_KEY, value);
      expect(loadLastPermissionMode("codex", storage)).toBe("default");
    }
    saveLastPermissionMode("auto", storage);
    expect(loadLastPermissionMode("codex", storage)).toBe("auto");
    expect(loadLastPermissionMode("opencode", storage)).toBe("default");
    expect(loadLastPermissionMode("pi", storage)).toBe("default");
    expect(loadLastPermissionMode("claude-code", storage)).toBe("auto");
    saveLastPermissionMode("yolo", storage);
    expect(loadLastPermissionMode("opencode", storage)).toBe("yolo");
    expect(loadLastPermissionMode("unknown", storage)).toBe("default");
  });

  test("retains independent trimmed directories for each machine", () => {
    const storage = makeStorage();
    expect(loadLastLaunchDirectory("local", storage)).toBeNull();
    saveLastLaunchDirectory("local", " /work/local project ", storage);
    saveLastLaunchDirectory("remote", "/srv/remote", storage);
    expect(loadLastLaunchDirectory("local", storage)).toBe("/work/local project");
    expect(loadLastLaunchDirectory("remote", storage)).toBe("/srv/remote");
    expect(loadLastLaunchDirectory("other", storage)).toBeNull();
    saveLastLaunchDirectory("local", "", storage);
    saveLastLaunchDirectory("local", "relative", storage);
    expect(loadLastLaunchDirectory("local", storage)).toBe("/work/local project");
  });

  test("blocked storage cannot prevent loading defaults or saving a successful launch", () => {
    const storage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("full");
      },
    };
    expect(loadLastPermissionMode("codex", storage)).toBe("default");
    expect(loadLastLaunchDirectory("local", storage)).toBeNull();
    expect(() => saveLastPermissionMode("auto", storage)).not.toThrow();
    expect(() => saveLastLaunchDirectory("local", "/work", storage)).not.toThrow();
  });
});
