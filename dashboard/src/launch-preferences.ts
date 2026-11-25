import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from "@agent-town/shared";
import { createBrowserLogger } from "./logger";

const log = createBrowserLogger("launch-preferences");
export const LAST_PERMISSION_MODE_KEY = "agentTown:lastPermissionMode";
const DIRECTORY_KEY_PREFIX = "agentTown:lastLaunchDirectory:";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function loadLastPermissionMode(agentType: string, storage?: PreferenceStorage): PermissionMode {
  try {
    const stored: unknown = JSON.parse((storage ?? localStorage).getItem(LAST_PERMISSION_MODE_KEY) ?? "null");
    return PERMISSION_MODES.includes(stored as PermissionMode)
      ? normalizePermissionMode(agentType, stored as PermissionMode)
      : "default";
  } catch (error) {
    log.warn("Could not load last permission mode", error);
    return "default";
  }
}

export function saveLastPermissionMode(mode: PermissionMode, storage?: PreferenceStorage): void {
  try {
    (storage ?? localStorage).setItem(LAST_PERMISSION_MODE_KEY, JSON.stringify(mode));
  } catch (error) {
    log.warn("Could not save last permission mode", error);
  }
}

export function loadLastLaunchDirectory(machineId: string, storage?: PreferenceStorage): string | null {
  try {
    const stored: unknown = JSON.parse((storage ?? localStorage).getItem(DIRECTORY_KEY_PREFIX + machineId) ?? "null");
    return typeof stored === "string" && stored.startsWith("/") ? stored : null;
  } catch (error) {
    log.warn("Could not load last launch directory", error);
    return null;
  }
}

export function saveLastLaunchDirectory(machineId: string, path: string, storage?: PreferenceStorage): void {
  const directory = path.trim();
  if (!machineId || !directory.startsWith("/")) return;
  try {
    (storage ?? localStorage).setItem(DIRECTORY_KEY_PREFIX + machineId, JSON.stringify(directory));
  } catch (error) {
    log.warn("Could not save last launch directory", error);
  }
}
