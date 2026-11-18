import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildHookCommand, createLogger, shellEscape } from "@agent-town/shared";
import { resolveTokenFile } from "@agent-town/shared/token-store";

const log = createLogger("hook-setup");

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
] as const;

const DEFAULT_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface HookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

interface HooksConfig {
  [event: string]: HookEntry[];
}

/**
 * Build the hook configuration object for a given agent port.
 * Each event gets a single hook entry that POSTs stdin (the event JSON)
 * to the local agent's hook-event endpoint via curl, authenticating with
 * the token read from `tokenFile` at hook run time.
 */
export function buildHookConfig(port: number, tokenFile: string = resolveTokenFile()): HooksConfig {
  const hookEntry: HookEntry[] = [
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: buildHookCommand(port, shellEscape(tokenFile)),
        },
      ],
    },
  ];

  const config: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    config[event] = hookEntry;
  }
  return config;
}

/**
 * Configure local Claude Code hooks in settings.json.
 *
 * - Reads existing settings and preserves all non-hook keys
 * - Sets the `hooks` key with properly formatted hook entries
 * - Uses `"type": "command"` with curl (matching ssh-manager approach)
 * - Idempotent: skips write if hooks are already correct
 *
 * @param port - The agent's HTTP port (e.g. 4681)
 * @param settingsPath - Path to settings.json (defaults to ~/.claude/settings.json)
 * @param tokenFile - Path to the shared token file the hook reads at run time
 */
export function configureLocalHooks(port: number, settingsPath?: string, tokenFile?: string): void {
  const filePath = settingsPath ?? DEFAULT_SETTINGS_PATH;
  const hooksConfig = buildHookConfig(port, tokenFile);

  let settings: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      log.warn(`failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      settings = {};
    }
  }

  // Check if hooks are already correct (idempotent)
  const existingHooks = settings.hooks;
  if (existingHooks !== undefined) {
    const existingJson = JSON.stringify(existingHooks);
    const newJson = JSON.stringify(hooksConfig);
    if (existingJson === newJson) {
      log.debug("hooks already configured, skipping write");
      return;
    }
  }

  settings.hooks = hooksConfig;

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2));
  log.info(`hooks configured in ${filePath} → http://127.0.0.1:${port}/api/hook-event`);
}
