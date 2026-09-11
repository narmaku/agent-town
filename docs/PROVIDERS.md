# Agent Town Provider Plugin Guide

Agent Town supports multiple AI coding agents through a provider abstraction. Each provider implements session discovery, process detection, CLI commands, and hook/event handling for a specific agent. This document describes the provider interface, the existing implementations, and how to add a new provider.

---

## The AgentProvider Interface

Defined in `agent/src/providers/types.ts`:

```typescript
interface AgentProvider {
  readonly type: AgentType;
  readonly displayName: string;
  readonly binaryName: string;
  readonly terminal: TerminalCapabilities;

  isAvailable(): Promise<boolean>;
  discoverSessions(): Promise<SessionInfo[]>;
  getSessionMessages(sessionId: string, offset: number, limit: number): Promise<SessionMessagesResponse>;
  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[];
  extractSessionIdFromArgs(args: string): string | undefined;
  buildLaunchCommand(opts: LaunchOptions): string[];
  buildResumeCommand(opts: ResumeOptions): string[];
  handleHookEvent(payload: unknown): HookEventResult | null;
  matchProcessToSessionId(cwd: string, processStartMs: number, claimedIds: Set<string>): Promise<string | undefined>;
  deleteSessionData(sessionId: string): Promise<boolean>;
}
```

### Properties

| Property      | Type        | Description                                              |
|---------------|-------------|----------------------------------------------------------|
| `type`        | `AgentType` | Unique identifier (`"claude-code"`, `"opencode"`, `"gemini-cli"`, `"codex"`, `"pi"`, or `"omp"`) |
| `displayName` | `string`    | Human-readable name (e.g., `"Claude Code"`)              |
| `binaryName`  | `string`    | CLI binary name (e.g., `"claude"` or `"opencode"`)       |
| `terminal`    | `TerminalCapabilities` | Provider-declared input and startup behavior       |

### Methods

#### `isAvailable(): Promise<boolean>`

Checks if the agent's CLI binary is installed on the machine. Typically uses `which` to find the binary in `$PATH`. Called during provider initialization -- if this returns `false`, the provider is not registered.

#### `discoverSessions(): Promise<SessionInfo[]>`

Discovers sessions from the agent's native storage. This is called every heartbeat interval (default: 5 seconds).

- **Claude Code:** Reads JSONL files from `~/.claude/projects/` directories.
- **OpenCode:** Queries the OpenCode SDK (`session.list()`) with SQLite fallback.
- **Gemini CLI:** Reads JSON sessions below `~/.gemini/tmp/`.
- **Codex CLI:** Reads compatible versioned state databases under `CODEX_HOME` and falls back to active rollout JSONL files.
- **Pi:** Reads direct and working-directory bucket JSONL sessions from `PI_CODING_AGENT_SESSION_DIR` and reconstructs the active tree branch.
- **OMP:** Reads primary bucket JSONLs under the active OMP agent root, accepting fixed-title-slot current files and legacy header-first files.

Returns an array of `SessionInfo` objects with fields populated from the agent's storage (session ID, project path, status, last message, etc.). At this stage, `multiplexerSession` and `multiplexer` fields are **not** set -- those are filled in later by the process mapper.

#### `getSessionMessages(sessionId, offset, limit): Promise<SessionMessagesResponse>`

Returns paginated messages for a session. Used by the `/api/session-messages` endpoint.

- **Claude Code:** Parses the session's JSONL file.
- **OpenCode:** Uses `session.messages()` from the SDK with SQLite fallback.
- **Gemini CLI:** Normalizes messages from the native JSON session document.
- **Codex CLI:** Normalizes visible rollout messages, reasoning summaries, tool records, and token usage. System/developer content is not exposed.
- **Pi:** Normalizes the active branch's text, thinking, tool calls/results, model, timestamps, and usage.
- **OMP:** Normalizes only the post-reset active ancestry, excluding credential, lifecycle, artifact, and abandoned-branch records.

#### `filterAgentProcesses(processes: AgentProcess[]): AgentProcess[]`

Filters a list of all system processes (from `ps`) to return only those belonging to this agent.

The `AgentProcess` type:
```typescript
interface AgentProcess {
  pid: number;
  ppid: number;
  etimes: number;  // elapsed time in seconds
  args: string;    // full command-line arguments
}
```

- **Claude Code:** Matches processes with `claude` in the command line (excluding agent-town's own processes).
- **OpenCode:** Matches processes with `opencode` in the command line.
- **Gemini CLI:** Matches Gemini CLI executable shapes.
- **Codex CLI:** Matches exact `codex` executable shapes, including the Node/Bun launcher form, without substring matching.
- **Pi:** Matches exact direct/compiled and known Node/Bun package launcher shapes; substring matches such as `pip` and `pico` are rejected.
- **OMP:** Matches exact `omp` and known Oh My Pi package launchers without substring matching.

#### `extractSessionIdFromArgs(args: string): string | undefined`

Extracts a session ID from a process's command-line arguments. This is the fast path for mapping a running process to a session.

- **Claude Code:** Looks for `--resume <uuid>` in the args.
- **OpenCode:** Looks for `--session <ses_id>` in the args.
- **Gemini CLI:** Looks for the session ID in supported resume arguments.
- **Codex CLI:** Looks for the positional UUID in `codex resume <uuid>`.
- **Pi:** Looks for a safe value following `--session` or `--session-id`.
- **OMP:** Looks for a safe opaque ID in `--resume`, `-r`, or legacy `--session` forms, including `--flag=value`.

Returns `undefined` if the session ID cannot be determined from the command line (e.g., a freshly launched session with no `--resume` flag).

#### `buildLaunchCommand(opts: LaunchOptions): string[]`

Builds the CLI command string to launch a new session. This command is sent to the multiplexer session.

```typescript
interface LaunchOptions {
  model?: string;
  autonomous?: boolean;
}
```

- **Claude Code:** Returns `claude [--model X] [--dangerously-skip-permissions]`
- **OpenCode:** Returns `opencode [--model X]`
- **Gemini CLI:** Returns `gemini [--model X] [--yolo]`
- **Codex CLI:** Returns `codex [--model X] [--dangerously-bypass-approvals-and-sandbox]`
- **Pi:** Returns `pi [--model X]`; `autonomous` is ignored because Pi has no tool-approval or built-in sandbox layer.
- **OMP:** Returns `omp [--model X] [--yolo]`.

#### `buildResumeCommand(opts: ResumeOptions): string[]`

Builds the CLI command string to resume an existing session.

```typescript
interface ResumeOptions {
  sessionId: string;
  model?: string;
  autonomous?: boolean;
}
```

- **Claude Code:** Returns `claude --resume <sessionId> [--model X] [--dangerously-skip-permissions]`
- **OpenCode:** Returns `opencode --session <sessionId> [--model X]`
- **Gemini CLI:** Returns its native resume command with the exact session ID.
- **Codex CLI:** Returns `codex resume <sessionId> [--model X] [--dangerously-bypass-approvals-and-sandbox]`
- **Pi:** Returns `pi --session <sessionId> [--model X]` (not the interactive `--resume` picker).
- **OMP:** Returns `omp --resume <sessionId> [--model X] [--yolo]`.

#### `handleHookEvent(payload: unknown): HookEventResult | null`

Parses an incoming hook/event payload and returns a normalized status update. Each provider has its own event format.

```typescript
interface HookEventResult {
  sessionId: string;
  status: SessionStatus;
  currentTool?: string;
}
```

Returns `null` if the payload is not recognized by this provider. The agent iterates through all providers until one returns a non-null result.

**Claude Code hook events** (received via shell hooks configured in `~/.claude/settings.json`):
```json
{
  "session_id": "uuid",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit"
}
```

Recognized `hook_event_name` values: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `SessionStart`, `SessionEnd`.

**OpenCode events** (received via webhooks or SSE):
```json
{
  "session_id": "ses_xxx",
  "event_type": "tool.execute.before",
  "tool_name": "file_write",
  "agent_type": "opencode"
}
```

Recognized `event_type` values: `session.created`, `session.idle`, `session.deleted`, `session.error`, `tool.execute.before`, `tool.execute.after`, `message.updated`, `permission.asked`, `permission.replied`.

#### `matchProcessToSessionId(cwd, processStartMs, claimedIds): Promise<string | undefined>`

Fallback method for matching a running process to a session ID when `extractSessionIdFromArgs` returns nothing (e.g., a freshly launched session without `--resume`).

- `cwd`: Working directory of the process
- `processStartMs`: Approximate start time of the process (epoch milliseconds)
- `claimedIds`: Set of session IDs already claimed by other processes (to avoid double-mapping)

**Claude Code:** Finds JSONL files in the project's `.claude/` directory and matches by file birth time proximity.

**OpenCode:** Finds the OpenCode session whose working directory matches `cwd`.

**Gemini CLI:** Uses provider-native path and process metadata to resolve the session.

**Codex CLI:** Selects the nearest retained, unclaimed, top-level session in the same working directory near the process start time.

**Pi:** Selects the nearest retained, unclaimed session in the same working directory near the process start time.

**OMP:** Selects the nearest retained, unclaimed primary session with the exact same working directory near process start.

#### `deleteSessionData(sessionId: string): Promise<boolean>`

Deletes the session's data files from local storage. Returns `true` if the session was found and deleted.

- **Claude Code:** Deletes the JSONL file from `~/.claude/projects/`.
- **OpenCode:** Deletes the session via SDK or SQLite.
- **Gemini CLI:** Deletes the exact native session file.
- **Codex CLI:** Runs `codex delete --force <uuid>` using an argument-array spawn. It never unlinks a guessed transcript path.
- **Pi:** Parses headers under the configured session root and unlinks only the file whose ID exactly matches.
- **OMP:** Parses authoritative header IDs and removes only the exact JSONL plus its same-stem artifact directory.

---

## Provider Registration

Providers are managed through a registry in `agent/src/providers/registry.ts`.

### Registry Functions

```typescript
function registerProvider(provider: AgentProvider): void;
function getProvider(type: AgentType): AgentProvider | undefined;
function getAllProviders(): AgentProvider[];
```

### Initialization

At agent startup, `initializeProviders()` is called. It:

1. Creates an instance of each known provider (`ClaudeCodeProvider`, `OpenCodeProvider`, `GeminiCliProvider`, `CodexProvider`, `PiProvider`, `OmpProvider`).
2. Calls `isAvailable()` on each.
3. Registers only the providers whose binary is found in `$PATH`.

```typescript
async function initializeProviders(): Promise<void> {
  const candidates: AgentProvider[] = [
    new ClaudeCodeProvider(),
    new OpenCodeProvider(),
    new GeminiCliProvider(),
    new CodexProvider(),
    new PiProvider(),
    new OmpProvider(),
  ];

  for (const provider of candidates) {
    const available = await provider.isAvailable();
    if (available) {
      registerProvider(provider);
    }
  }
}
```

---

## Existing Implementations

### Claude Code Provider

**Location:** `agent/src/providers/claude-code/`

| File                  | Purpose                                           |
|-----------------------|---------------------------------------------------|
| `index.ts`            | Provider class, delegates to specialized modules   |
| `session-discovery.ts`| Reads JSONL files from `~/.claude/projects/`       |
| `message-parser.ts`   | Parses JSONL into `SessionMessage[]`               |
| `process-mapper.ts`   | Filters `claude` processes, matches by JSONL birth time |
| `hook-handler.ts`     | Parses Claude Code hook event payloads             |

Key characteristics:
- Sessions are stored as JSONL files in `~/.claude/projects/<hash>/` directories.
- Session IDs are UUIDs (e.g., `550e8400-e29b-41d4-a716-446655440000`).
- Real-time status comes from Claude Code hooks configured in `~/.claude/settings.json`.
- Post-launch automation: auto-accepts workspace trust prompt, sends initial message.

### OpenCode Provider

**Location:** `agent/src/providers/opencode/`

| File                  | Purpose                                            |
|-----------------------|----------------------------------------------------|
| `index.ts`            | Provider class with additional `startEventStream` and `sendViaTUI` methods |
| `session-discovery.ts`| Queries OpenCode SDK or reads SQLite database       |
| `message-parser.ts`   | Retrieves messages via SDK or SQLite                |
| `process-mapper.ts`   | Filters `opencode` processes                        |
| `event-handler.ts`    | Handles webhooks and SSE events                     |
| `sdk-client.ts`       | Lazy-init SDK client with retry logic               |

Key characteristics:
- Sessions are stored in SQLite (managed by OpenCode server).
- Session IDs use the format `ses_<alphanumeric>` (e.g., `ses_30163a6c1ffeYDGuDOrp0nH9vG`).
- Real-time status comes from SSE event subscription via the OpenCode SDK.
- Text sending uses the SDK's TUI methods (`tui.appendPrompt`, `tui.submitPrompt`).
- Requires OpenCode server running (`opencode serve --port 4096`).

The OpenCode provider extends the base interface with two additional methods:

```typescript
startEventStream(onEvent: (result: HookEventResult) => void): Promise<void>;
sendViaTUI(text: string): Promise<boolean>;
```

### Gemini CLI Provider

**Location:** `agent/src/providers/gemini-cli/`

| File                  | Purpose                                            |
|-----------------------|----------------------------------------------------|
| `index.ts`            | Provider class, delegates to specialized modules   |
| `session-discovery.ts`| Reads JSON session files from `~/.gemini/tmp/`     |
| `message-parser.ts`   | Parses Gemini JSON messages into `SessionMessage[]` |
| `process-mapper.ts`   | Extracts session ID from `--resume` args           |

Key characteristics:
- Sessions are stored as JSON files in `~/.gemini/tmp/<project_hash>/chats/` directories.
- Session IDs are UUIDs (e.g., `4460d17e-a2b3-4c5d-8e9f-0123456789ab`).
- Project-to-directory mapping is resolved via `~/.gemini/projects.json` or `.project_root` files in each project hash directory.
- Status detection is based on file modification time heuristics (no hook or SSE support).
- Launch command: `gemini [--model X] [--yolo]`
- Resume command: `gemini --resume <sessionId> [--model X] [--yolo]`
- Session ID extraction from args: matches `--resume <uuid>` or `-r <uuid>` patterns.
- Message format includes thoughts (reasoning), tool calls with structured results, and token usage stats (input, output, cached, thoughts, tool, total).

Limitations compared to other providers:
- **No hook/event support:** Gemini CLI does not currently support hooks or webhooks for real-time status tracking. Status detection relies entirely on file modification time heuristics, which is less accurate than Claude Code hooks or OpenCode SSE events.
- **No SDK integration:** Session discovery and message parsing read JSON files directly from disk rather than communicating with a running server process.

### Codex CLI Provider

**Location:** `agent/src/providers/codex/`

| File                   | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `index.ts`             | Provider contract and safe launch/resume command arrays        |
| `session-discovery.ts` | Read-only SQLite discovery, rollout fallback, and native delete |
| `message-parser.ts`    | Visible message, reasoning, tool, usage, pagination, and search |
| `process-mapper.ts`    | Exact process detection and UUID/start-time mapping             |

Codex session storage is private and versioned. Agent Town detects compatible schemas at runtime and falls back safely when they change. `CODEX_HOME` defaults to `~/.codex`; archived sessions and subagent rollouts are excluded. There is no hook integration, so status remains activity/process based. Resume requires a UUID, and autonomous mode deliberately bypasses both approvals and sandboxing.

### Pi Provider

**Location:** `agent/src/providers/pi/`

Pi stores sessions below `~/.pi/agent/sessions/` by default. `PI_CODING_AGENT_DIR` changes the agent root and `PI_CODING_AGENT_SESSION_DIR` directly overrides the session root. Agent Town scans direct JSONL files and one level of working-directory buckets, but excludes deeper artifact/subagent files.

Current v2/v3 transcripts are trees: Agent Town follows guarded `id`/`parentId` links from the last leaf and displays only that active ancestry. Legacy v1/missing-ID transcripts use linear order. Malformed lines, dangling parents, and cycles are isolated safely. Pi provides no hook, tool-approval layer, or built-in sandbox, so status is an estimate and the Autonomous dashboard option does not apply. Pi's separate project-trust prompt still controls whether project-local resources are loaded.

### OMP Provider

**Location:** `agent/src/providers/omp/`

OMP stores sessions below `~/.omp/agent/sessions/` by default. `OMP_PROFILE=<name>` selects `~/.omp/profiles/<name>/agent`; the legacy `PI_PROFILE` alias is also accepted. `PI_CODING_AGENT_DIR` overrides the active agent root and must be visible to the Agent Town service. Agent Town scans only `sessions/*/*.jsonl`, so nested artifact/subagent transcripts and root-level unrelated JSONLs are excluded. Sessions created with an ad hoc `omp --session-dir` outside that root are not discoverable.

Current files begin with an exact 256-byte UTF-8 `type: "title"` slot before the v3 header; legacy header-first files remain supported. Header IDs and working directories are authoritative. Agent Town follows the active tree, starts display after the latest active `reset_boundary`, ignores credential/lifecycle/custom state as chat, and uses terminal message/session-exit records to preserve completion, interruption, pending, and error status. Resume uses `omp --resume <id>`, Autonomous adds `--yolo`, and text is delivered through bracketed paste without synthetic startup keystrokes.

Deletion does not rewrite or migrate OMP data. It locates an exact header ID and removes that JSONL and only its same-stem artifact directory.

---

## How Session Discovery Works

The session discovery lifecycle runs every heartbeat interval (default: 5 seconds):

1. **Discover sessions** -- Each registered provider's `discoverSessions()` is called in parallel. Returns raw session data from native storage.

2. **Discover processes** -- `ps` output is parsed and filtered through each provider's `filterAgentProcesses()`.

3. **Map processes to sessions** -- For each agent process:
   - Determine which multiplexer session it runs in (via `ZELLIJ_SESSION_NAME` or `TMUX` environment variables in `/proc/<ppid>/environ`).
   - Extract the session ID from command-line args (`extractSessionIdFromArgs`).
   - If no session ID in args, use `matchProcessToSessionId` to match by working directory and timing.

4. **Merge** -- The session list is enriched with `multiplexer` and `multiplexerSession` fields from the process mappings.

5. **Adjust statuses** -- Status priority:
   - Hook/SSE events (highest accuracy)
   - Process mapper (child process detection)
   - Storage heuristics (JSONL modification time)

6. **Detect exited sessions** -- If a session was previously mapped to a multiplexer session but no longer has a running process, it is marked as `"exited"`. This enables the Resume/Reconnect feature.

---

## Adding a New Provider

### Step 1: Create the provider directory

```
agent/src/providers/my-agent/
  index.ts              # Provider class
  session-discovery.ts  # Session discovery logic
  message-parser.ts     # Message parsing
  process-mapper.ts     # Process filtering + matching
  event-handler.ts      # Hook/event handling (optional)
```

### Step 2: Add the agent type

In `shared/src/index.ts`, add the new type to the `AgentType` union:

```typescript
export type AgentType = "claude-code" | "opencode" | "gemini-cli" | "my-agent";
```

### Step 3: Implement the AgentProvider interface

Create a class that implements all methods of the `AgentProvider` interface:

```typescript
import type { SessionInfo, SessionMessagesResponse } from "@agent-town/shared";
import type {
  AgentProcess,
  AgentProvider,
  HookEventResult,
  LaunchOptions,
  ResumeOptions,
} from "../types";

export class MyAgentProvider implements AgentProvider {
  readonly type = "my-agent" as const;
  readonly displayName = "My Agent";
  readonly binaryName = "myagent";
  readonly terminal = {
    inputMode: "bracketed-paste",
    startupMode: "tui",
    autonomousDisclaimer: false,
  } as const;

  async isAvailable(): Promise<boolean> {
    // Check if the binary exists in PATH
    const proc = Bun.spawn(["which", this.binaryName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  }

  async discoverSessions(): Promise<SessionInfo[]> {
    // Read sessions from your agent's storage
    // Return SessionInfo[] with at minimum:
    //   sessionId, slug, projectPath, projectName,
    //   gitBranch, status, lastActivity, lastMessage, cwd
    return [];
  }

  async getSessionMessages(
    sessionId: string,
    offset: number,
    limit: number,
  ): Promise<SessionMessagesResponse> {
    // Return paginated messages
    return { messages: [], total: 0, hasMore: false };
  }

  filterAgentProcesses(processes: AgentProcess[]): AgentProcess[] {
    // Filter ps output to find your agent's processes
    return processes.filter((p) =>
      p.args.includes("myagent") && !p.args.includes("agent-town")
    );
  }

  extractSessionIdFromArgs(args: string): string | undefined {
    // Extract session ID from command-line arguments
    const match = args.match(/--session\s+(\S+)/);
    return match?.[1];
  }

  buildLaunchCommand(opts: LaunchOptions): string[] {
    const parts = ["myagent"];
    if (opts.model) parts.push("--model", opts.model);
    return parts;
  }

  buildResumeCommand(opts: ResumeOptions): string[] {
    const parts = ["myagent", "--session", opts.sessionId];
    if (opts.model) parts.push("--model", opts.model);
    return parts;
  }

  handleHookEvent(payload: unknown): HookEventResult | null {
    // Parse webhook/hook payloads from your agent
    // Return null if the payload doesn't belong to this provider
    return null;
  }

  async matchProcessToSessionId(
    cwd: string,
    processStartMs: number,
    claimedIds: Set<string>,
  ): Promise<string | undefined> {
    // Fallback: match a process to a session by working directory
    return undefined;
  }

  async deleteSessionData(sessionId: string): Promise<boolean> {
    // Delete session storage files
    return false;
  }
}
```

### Step 4: Register the provider

In `agent/src/providers/registry.ts`, add the import and candidate:

```typescript
export async function initializeProviders(): Promise<void> {
  const { ClaudeCodeProvider } = await import("./claude-code/index");
  const { OpenCodeProvider } = await import("./opencode/index");
  const { GeminiCliProvider } = await import("./gemini-cli/index");
  const { MyAgentProvider } = await import("./my-agent/index");

  const candidates: AgentProvider[] = [
    new ClaudeCodeProvider(),
    new OpenCodeProvider(),
    new GeminiCliProvider(),
    new MyAgentProvider(),
  ];

  for (const provider of candidates) {
    const available = await provider.isAvailable();
    if (available) {
      registerProvider(provider);
    }
  }
}
```

### Step 5: Write tests

Co-locate tests with source files:

```
agent/src/providers/my-agent/
  index.test.ts
  session-discovery.test.ts
  process-mapper.test.ts
```

Use the existing test patterns from `agent/src/providers/claude-code/`, `agent/src/providers/opencode/`, and `agent/src/providers/gemini-cli/` as reference. Run tests with:

```bash
bun test --filter agent
```

### Step 6: Declare terminal behavior

Set `terminal.inputMode` to `"direct"` or `"bracketed-paste"`, and set `terminal.startupMode` to `"cli-prompt"` when Agent Town should handle the provider's startup prompts. `autonomousDisclaimer` controls whether autonomous launches require a second confirmation keystroke. The terminal server uses these capabilities without provider-specific branches.
