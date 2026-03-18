# Fullscreen Session Pane v2 — Feature Specification

## Overview

The fullscreen session pane (`SessionFullscreen.tsx`) currently displays a static snapshot of a single Claude Code session. When a user clicks "Expand" on a session card, the pane renders the session metadata and the last assistant message captured at the time the heartbeat was received. It does not update until the user closes and re-opens the pane, and it provides no way to view earlier messages in the conversation.

This specification describes four categories of enhancements that transform the fullscreen pane into a live, interactive conversation viewer:

1. **Real-time updates** — keep the pane in sync with WebSocket heartbeats
2. **Load previous messages** — paginated access to the full JSONL conversation history
3. **Interaction improvements** — better message input, auto-scroll, and keyboard shortcuts
4. **New API endpoints** — a `GET /api/session-messages` endpoint for paginated message retrieval

---

## Architecture Context

Before diving into the changes, here is a summary of the relevant pieces of the current system.

### Components and data flow

```
[Agent Machine]
  ~/.claude/projects/<dir>/<sessionId>.jsonl   <-- conversation log
  agent/src/session-parser.ts                  <-- reads JSONL, produces SessionInfo
  agent/src/index.ts                           <-- heartbeat loop (every 5s)
  agent/src/terminal-server.ts                 <-- HTTP + WS server on port 4681

[Dashboard Server]  (server/src/index.ts)
  POST /api/heartbeat           <-- receives agent heartbeats, stores MachineInfo
  WS   /ws                      <-- broadcasts machines_update to dashboard clients
  POST /api/sessions/send       <-- proxies to agent /api/send
  POST /api/sessions/delete     <-- proxies to agent /api/delete-session

[Dashboard Frontend]  (dashboard/src/)
  useWebSocket.ts               <-- connects to /ws, exposes `machines` state
  App.tsx                        <-- holds fullscreen state as { machineId, session }
  SessionFullscreen.tsx          <-- the component being enhanced
  SendMessage.tsx                <-- textarea + send button for agent input
  MessageView.tsx                <-- markdown rendering with expand/collapse
```

### Key types (from `shared/src/index.ts`)

```ts
type SessionStatus = "working" | "awaiting_input" | "idle" | "done" | "error";
type TerminalMultiplexer = "zellij" | "tmux";

interface SessionInfo {
  sessionId: string;
  slug: string;
  customName?: string;
  projectPath: string;
  projectName: string;
  gitBranch: string;
  status: SessionStatus;
  lastActivity: string;        // ISO timestamp
  lastMessage: string;          // short summary (120 chars)
  lastAssistantMessage?: string; // full markdown of most recent assistant text
  cwd: string;
  model?: string;
  version?: string;
  multiplexerSession?: string;
  multiplexer?: TerminalMultiplexer;
}
```

### JSONL entry format (from `session-parser.ts`)

Each line of a `~/.claude/projects/<dir>/<sessionId>.jsonl` file is a JSON object:

```ts
interface JsonlEntry {
  type: "user" | "assistant";       // only these two are "real" entries
  sessionId: string;
  slug?: string;
  cwd: string;
  gitBranch?: string;
  version?: string;
  timestamp: string;                // ISO timestamp
  message: {
    role: string;
    model?: string;
    content?: unknown;              // string | Array<ContentBlock>
  };
  toolUseResult?: string;
}
```

Content blocks within `message.content` (when it is an array) follow this shape:

```ts
// Text block
{ type: "text", text: string }

// Tool use block
{ type: "tool_use", id: string, name: string, input: unknown }

// Tool result block (user entries)
{ type: "tool_result", tool_use_id: string, content: string | unknown[] }
```

Non-standard entry types such as `"last-prompt"` and `"summary"` also appear in the file and must be filtered out.

---

## 1. Real-time Updates

### Problem

When the fullscreen pane is open, the `session` prop passed to `SessionFullscreen` is a frozen reference captured at the moment the user clicked "Expand". The WebSocket continues pushing `machines_update` events to the dashboard, but `App.tsx` only stores the `FullscreenTarget` as `{ machineId, session }` — a snapshot, not a live reference.

The session cards in the grid *do* update in real-time because they receive fresh `SessionInfo` objects from the `machines` array on every render cycle.

### Solution

#### 1a. Keep the fullscreen pane bound to live data

In `App.tsx`, change the `FullscreenTarget` to store only identifiers, not the full session object:

```ts
// Before
interface FullscreenTarget {
  machineId: string;
  session: SessionInfo;
}

// After
interface FullscreenTarget {
  machineId: string;
  sessionId: string;
}
```

Derive the live session by looking it up from the `machines` array on every render:

```tsx
const fullscreenSession = fullscreen
  ? machines
      .find((m) => m.machineId === fullscreen.machineId)
      ?.sessions.find((s) => s.sessionId === fullscreen.sessionId)
  : null;
```

If the session disappears (e.g., its JSONL file is deleted), auto-close the fullscreen pane:

```tsx
useEffect(() => {
  if (fullscreen && !fullscreenSession) {
    setFullscreen(null);
  }
}, [fullscreen, fullscreenSession]);
```

Pass the live session to the component:

```tsx
{fullscreen && fullscreenSession && (
  <SessionFullscreen
    session={fullscreenSession}
    machineId={fullscreen.machineId}
    onClose={() => setFullscreen(null)}
    ...
  />
)}
```

#### 1b. Visual freshness indicator

Add a live-updating "last updated" timestamp inside the fullscreen header that shows how recently the data was refreshed. This uses the `session.lastActivity` field, which is updated on every heartbeat.

The existing `timeAgo()` function in `SessionFullscreen.tsx` already handles this. To make it tick live (not just on re-render from WebSocket), add an interval:

```tsx
const [, setTick] = useState(0);
useEffect(() => {
  const interval = setInterval(() => setTick((t) => t + 1), 5000);
  return () => clearInterval(interval);
}, []);
```

Display in the header:

```tsx
<span className="session-time">
  Updated {timeAgo(session.lastActivity)}
</span>
```

#### 1c. Flash animation on update

When the session data changes (status, lastMessage, or lastAssistantMessage), briefly flash the updated section to draw attention. Use a CSS class applied for 1 second via a `useEffect` that watches the relevant fields:

```tsx
const [flash, setFlash] = useState(false);
const prevMessageRef = useRef(session.lastMessage);

useEffect(() => {
  if (session.lastMessage !== prevMessageRef.current) {
    setFlash(true);
    prevMessageRef.current = session.lastMessage;
    const timeout = setTimeout(() => setFlash(false), 1000);
    return () => clearTimeout(timeout);
  }
}, [session.lastMessage]);
```

```css
.fullscreen-message.flash {
  animation: flash-highlight 1s ease-out;
}

@keyframes flash-highlight {
  0% { background: rgba(59, 130, 246, 0.15); }
  100% { background: transparent; }
}
```

### Files to modify

| File | Change |
|------|--------|
| `dashboard/src/App.tsx` | Change `FullscreenTarget` to store `sessionId` instead of `session`; derive live session from `machines` |
| `dashboard/src/components/SessionFullscreen.tsx` | Add tick interval for freshness; add flash animation on data change |
| `dashboard/src/index.css` (or equivalent) | Add `flash-highlight` keyframe animation |

---

## 2. Load Previous Messages

### Problem

The fullscreen pane currently shows only `session.lastAssistantMessage` — a single markdown string extracted from the last assistant entry in the JSONL file. Users want to scroll through the full conversation history without opening a terminal.

### Solution

#### 2a. New API endpoint on the agent: `GET /api/session-messages`

Add a new HTTP handler in `agent/src/terminal-server.ts` that reads the JSONL file for a given session and returns paginated messages.

**Request:**

```
GET /api/session-messages?sessionId=<uuid>&offset=0&limit=10
```

| Parameter   | Type   | Default | Description |
|-------------|--------|---------|-------------|
| `sessionId` | string | required | The Claude session UUID |
| `offset`    | number | `0`     | Number of message entries to skip from the end (0 = most recent) |
| `limit`     | number | `10`    | Maximum number of entries to return |

**Response:**

```ts
interface SessionMessagesResponse {
  messages: SessionMessage[];
  total: number;       // total number of valid entries in the file
  hasMore: boolean;    // true if there are older messages beyond this batch
}

interface SessionMessage {
  role: "user" | "assistant";
  timestamp: string;          // ISO timestamp from the JSONL entry
  content: string;            // rendered text content (markdown for assistant, plain for user)
  toolUse?: {                 // present if the assistant used a tool
    name: string;
    id: string;
  }[];
  toolResult?: string;        // present if this is a tool_result entry
  model?: string;             // model used (assistant entries only)
}
```

**Implementation in `agent/src/terminal-server.ts`:**

```ts
if (url.pathname === "/api/session-messages" && req.method === "GET") {
  const sessionId = url.searchParams.get("sessionId");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const limit = parseInt(url.searchParams.get("limit") || "10");

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  try {
    const messages = await getSessionMessages(sessionId, offset, limit);
    return Response.json(messages);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
```

**JSONL file discovery:**

The function must locate the JSONL file by searching `~/.claude/projects/` directories. The same pattern used in `discoverSessions()` and `delete-session` applies:

```ts
import { readdir, stat as fsStat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

async function findJsonlFile(sessionId: string): Promise<string | null> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const dirs = await readdir(projectsDir);

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    const dirStat = await fsStat(dirPath);
    if (!dirStat.isDirectory()) continue;

    const jsonlPath = join(dirPath, `${sessionId}.jsonl`);
    try {
      await fsStat(jsonlPath);
      return jsonlPath;
    } catch {
      // not in this directory
    }
  }
  return null;
}
```

**Message extraction:**

```ts
async function getSessionMessages(
  sessionId: string,
  offset: number,
  limit: number
): Promise<SessionMessagesResponse> {
  const filePath = await findJsonlFile(sessionId);
  if (!filePath) {
    throw new Error("Session not found");
  }

  const text = await Bun.file(filePath).text();
  const lines = text.trim().split("\n");

  // Parse all valid entries (filter out "last-prompt", "summary", etc.)
  const entries: Array<{ raw: JsonlEntry; lineIndex: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry: JsonlEntry = JSON.parse(lines[i]);
      if (entry.type === "user" || entry.type === "assistant") {
        entries.push({ raw: entry, lineIndex: i });
      }
    } catch {
      continue;
    }
  }

  const total = entries.length;

  // Paginate from the end: offset=0 means the most recent `limit` entries
  const startFromEnd = offset + limit;
  const startIndex = Math.max(0, total - startFromEnd);
  const endIndex = Math.max(0, total - offset);
  const slice = entries.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;

  const messages: SessionMessage[] = slice.map(({ raw }) =>
    formatEntry(raw)
  );

  return { messages, total, hasMore };
}
```

**Entry formatting:**

```ts
function formatEntry(entry: JsonlEntry): SessionMessage {
  const content = entry.message?.content;
  let textContent = "";
  let toolUse: { name: string; id: string }[] | undefined;
  let toolResult: string | undefined;

  if (typeof content === "string") {
    textContent = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    const tools: { name: string; id: string }[] = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "tool_use") {
        tools.push({
          name: b.name as string,
          id: b.id as string,
        });
      } else if (b.type === "tool_result") {
        toolResult = typeof b.content === "string"
          ? b.content
          : JSON.stringify(b.content);
      }
    }

    textContent = textParts.join("\n\n");
    if (tools.length > 0) toolUse = tools;
  }

  return {
    role: entry.type,
    timestamp: entry.timestamp,
    content: textContent,
    toolUse,
    toolResult,
    model: entry.message?.model,
  };
}
```

#### 2b. Server proxy endpoint

Add a proxy route in `server/src/index.ts` that forwards requests to the agent:

```ts
// API: get paginated session messages
if (url.pathname === "/api/session-messages" && req.method === "GET") {
  const machineId = url.searchParams.get("machineId");
  const sessionId = url.searchParams.get("sessionId");
  const offset = url.searchParams.get("offset") || "0";
  const limit = url.searchParams.get("limit") || "10";

  if (!machineId || !sessionId) {
    return Response.json(
      { error: "Missing machineId or sessionId" },
      { status: 400 }
    );
  }

  const machine = getMachine(machineId);
  if (!machine || !machine.terminalPort) {
    return Response.json({ error: "Machine not found" }, { status: 404 });
  }

  const agentHost = machine.agentAddress || machine.hostname;
  const agentUrl =
    `http://${agentHost}:${machine.terminalPort}/api/session-messages` +
    `?sessionId=${encodeURIComponent(sessionId)}` +
    `&offset=${offset}&limit=${limit}`;

  try {
    const agentResp = await fetch(agentUrl);
    const data = await agentResp.json();
    return Response.json(data, { status: agentResp.status });
  } catch {
    return Response.json(
      { error: "Failed to fetch messages from agent" },
      { status: 502 }
    );
  }
}
```

**Dashboard request URL format:**

```
GET /api/session-messages?machineId=<id>&sessionId=<uuid>&offset=0&limit=10
```

#### 2c. Frontend: message history in the fullscreen pane

**State management in `SessionFullscreen.tsx`:**

```tsx
interface HistoryMessage {
  role: "user" | "assistant";
  timestamp: string;
  content: string;
  toolUse?: { name: string; id: string }[];
  toolResult?: string;
  model?: string;
}

const [history, setHistory] = useState<HistoryMessage[]>([]);
const [hasMore, setHasMore] = useState(true);
const [loadingHistory, setLoadingHistory] = useState(false);
const [offset, setOffset] = useState(0);
const messagesEndRef = useRef<HTMLDivElement>(null);
const messageContainerRef = useRef<HTMLDivElement>(null);

const BATCH_SIZE = 10; // 5 user + assistant pairs = 10 entries
```

**Initial load:**

On mount, fetch the most recent batch of messages:

```tsx
useEffect(() => {
  loadMessages(0);
}, [session.sessionId]);

async function loadMessages(currentOffset: number) {
  setLoadingHistory(true);
  try {
    const resp = await fetch(
      `/api/session-messages?machineId=${machineId}` +
      `&sessionId=${session.sessionId}` +
      `&offset=${currentOffset}&limit=${BATCH_SIZE}`
    );
    if (!resp.ok) return;

    const data: { messages: HistoryMessage[]; total: number; hasMore: boolean } =
      await resp.json();

    if (currentOffset === 0) {
      setHistory(data.messages);
    } else {
      // Prepend older messages, maintaining scroll position
      setHistory((prev) => [...data.messages, ...prev]);
    }
    setHasMore(data.hasMore);
    setOffset(currentOffset + BATCH_SIZE);
  } catch {
    // silently fail
  } finally {
    setLoadingHistory(false);
  }
}
```

**Load previous messages button:**

```tsx
{hasMore && (
  <button
    className="load-previous-btn"
    onClick={() => loadMessages(offset)}
    disabled={loadingHistory}
  >
    {loadingHistory ? "Loading..." : "Load previous messages"}
  </button>
)}
```

**Scroll position preservation:**

When prepending older messages, the scroll position must be maintained so the user's viewport does not jump:

```tsx
async function loadPrevious() {
  const container = messageContainerRef.current;
  if (!container) return;

  const prevScrollHeight = container.scrollHeight;
  await loadMessages(offset);

  // After React re-renders with prepended messages, restore relative scroll
  requestAnimationFrame(() => {
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = newScrollHeight - prevScrollHeight;
  });
}
```

**Message rendering:**

Messages are displayed chronologically (oldest at top, newest at bottom). User and assistant messages are styled differently to create a chat-like interface:

```tsx
<div className="fullscreen-messages" ref={messageContainerRef}>
  {hasMore && (
    <button
      className="load-previous-btn"
      onClick={loadPrevious}
      disabled={loadingHistory}
    >
      {loadingHistory ? "Loading..." : "Load previous messages"}
    </button>
  )}

  {history.map((msg, i) => (
    <div key={`${msg.timestamp}-${i}`} className={`chat-message chat-${msg.role}`}>
      <div className="chat-message-header">
        <span className="chat-role">
          {msg.role === "user" ? "You" : "Assistant"}
        </span>
        <span className="chat-timestamp">
          {new Date(msg.timestamp).toLocaleString()}
        </span>
        {msg.model && (
          <span className="chat-model">{msg.model}</span>
        )}
      </div>

      <div className="chat-message-body">
        {msg.role === "assistant" ? (
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {msg.content}
          </Markdown>
        ) : (
          <div className="chat-user-text">{msg.content}</div>
        )}

        {msg.toolUse && msg.toolUse.length > 0 && (
          <div className="chat-tools">
            {msg.toolUse.map((t) => (
              <span key={t.id} className="tool-badge">
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  ))}

  <div ref={messagesEndRef} />
</div>
```

**Styling guidelines:**

```css
.chat-message {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 8px;
}

.chat-user {
  background: #1e293b;            /* dark slate */
  border-left: 3px solid #3b82f6; /* blue accent */
  margin-left: 32px;              /* indent user messages */
}

.chat-assistant {
  background: #0f172a;            /* darker background */
  border-left: 3px solid #22c55e; /* green accent */
  margin-right: 32px;             /* indent assistant messages */
}

.chat-message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 0.75rem;
  color: #94a3b8;
}

.chat-role {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.chat-user .chat-role { color: #3b82f6; }
.chat-assistant .chat-role { color: #22c55e; }

.tool-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1e1b4b;
  color: #a78bfa;
  font-size: 0.75rem;
  font-family: monospace;
}

.load-previous-btn {
  display: block;
  margin: 8px auto 16px;
  padding: 6px 16px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #94a3b8;
  cursor: pointer;
  font-size: 0.8rem;
}

.load-previous-btn:hover {
  background: #334155;
  color: #e2e8f0;
}

.load-previous-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

### Files to modify

| File | Change |
|------|--------|
| `agent/src/terminal-server.ts` | Add `GET /api/session-messages` handler |
| `agent/src/session-parser.ts` | Extract `findJsonlFile()`, `formatEntry()`, and `getSessionMessages()` (or add a new `session-messages.ts` module) |
| `server/src/index.ts` | Add proxy route `GET /api/session-messages` |
| `dashboard/src/components/SessionFullscreen.tsx` | Add message history state, load/render logic |
| `shared/src/index.ts` | Add `SessionMessage` and `SessionMessagesResponse` types |
| CSS file | Add chat message styles |

---

## 3. Interaction Improvements

### 3a. Prominent SendMessage in fullscreen

The current `SendMessage` component is the same compact version used inside session cards. In the fullscreen view it should be more prominent:

- The textarea should span the full width of the panel.
- The send button should be larger and more visually distinct.
- The component should be pinned to the bottom of the fullscreen panel (sticky positioning) so it remains visible while scrolling through message history.

**Layout change in `SessionFullscreen.tsx`:**

```tsx
<div className="fullscreen-panel">
  <div className="fullscreen-header">...</div>
  <div className="fullscreen-meta">...</div>

  {/* Scrollable message area */}
  <div className="fullscreen-messages" ref={messageContainerRef}>
    ...
  </div>

  {/* Pinned to bottom */}
  {hasTerminal && (
    <div className="fullscreen-input">
      <SendMessage
        machineId={machineId}
        multiplexer={session.multiplexer!}
        session={session.multiplexerSession!}
        onSent={scrollToBottom}
        variant="fullscreen"
      />
    </div>
  )}
</div>
```

Add a `variant` prop to `SendMessage` to control sizing:

```tsx
interface Props {
  machineId: string;
  multiplexer: string;
  session: string;
  onSent?: () => void;
  variant?: "compact" | "fullscreen";
}
```

When `variant === "fullscreen"`:
- The textarea gets a minimum height of 60px
- The send button is larger (e.g., `padding: 8px 24px`)
- The hint text shows the keyboard shortcut more prominently

### 3b. Auto-scroll after sending

When the user sends a message, scroll the message container to the bottom so they see incoming responses:

```tsx
function scrollToBottom() {
  messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
}
```

Pass `scrollToBottom` as the `onSent` callback to `SendMessage`.

### 3c. Escape key to close

Add a global keyboard listener in `SessionFullscreen.tsx` to close the pane on Escape:

```tsx
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    }
  }
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}, [onClose]);
```

Note: The `SendMessage` textarea already calls `e.stopPropagation()` on keydown events, so pressing Escape while typing in the textarea will not accidentally close the pane. However, you should also check `e.target` to avoid closing if the user is interacting with other inputs (e.g., the rename field is not present in fullscreen, but defensive coding is prudent):

```tsx
function handleKeyDown(e: KeyboardEvent) {
  // Don't close if user is typing in an input or textarea
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "Escape") {
    onClose();
  }
}
```

### Files to modify

| File | Change |
|------|--------|
| `dashboard/src/components/SessionFullscreen.tsx` | Add Escape listener, auto-scroll, layout restructuring |
| `dashboard/src/components/SendMessage.tsx` | Add `variant` prop for fullscreen styling |
| CSS file | Add `.fullscreen-input` sticky positioning, fullscreen variant styles |

---

## 4. API Design

### 4a. `GET /api/session-messages` (Agent — `terminal-server.ts`)

This endpoint is served directly by the agent process and reads the JSONL file from the local filesystem.

**URL:** `GET /api/session-messages?sessionId=<uuid>&offset=<n>&limit=<n>`

| Parameter   | Type   | Required | Default | Description |
|-------------|--------|----------|---------|-------------|
| `sessionId` | string | Yes      | —       | Claude session UUID (matches the JSONL filename) |
| `offset`    | number | No       | `0`     | Number of entries to skip from the end (pagination cursor) |
| `limit`     | number | No       | `10`    | Max entries to return per request |

**Response (200):**

```json
{
  "messages": [
    {
      "role": "user",
      "timestamp": "2026-03-12T10:05:32.000Z",
      "content": "Refactor the auth module to use JWT tokens",
      "toolUse": null,
      "toolResult": null,
      "model": null
    },
    {
      "role": "assistant",
      "timestamp": "2026-03-12T10:05:45.000Z",
      "content": "I'll refactor the auth module to use JWT tokens. Let me start by examining the current implementation...",
      "toolUse": [
        { "name": "Read", "id": "tool_01abc" }
      ],
      "toolResult": null,
      "model": "claude-sonnet-4-20250514"
    }
  ],
  "total": 48,
  "hasMore": true
}
```

**Error responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Missing sessionId" }` | `sessionId` query parameter not provided |
| 404 | `{ "error": "Session not found" }` | No JSONL file found for the given session ID |
| 500 | `{ "error": "<message>" }` | File read or parse error |

**Pagination semantics:**

Messages are returned in chronological order (oldest first within the returned batch). The `offset` counts backward from the most recent entry:

- `offset=0, limit=10` returns the 10 most recent entries
- `offset=10, limit=10` returns entries 11-20 from the end
- `hasMore=true` indicates there are entries older than the returned batch

This design allows the "Load previous messages" button to simply increment the offset.

### 4b. `GET /api/session-messages` (Server proxy — `server/src/index.ts`)

The dashboard frontend calls this endpoint on the dashboard server. The server looks up the machine's agent address and forwards the request.

**URL:** `GET /api/session-messages?machineId=<id>&sessionId=<uuid>&offset=<n>&limit=<n>`

| Parameter   | Type   | Required | Default | Description |
|-------------|--------|----------|---------|-------------|
| `machineId` | string | Yes      | —       | Machine identifier (used to look up agent address) |
| `sessionId` | string | Yes      | —       | Forwarded to the agent |
| `offset`    | number | No       | `0`     | Forwarded to the agent |
| `limit`     | number | No       | `10`    | Forwarded to the agent |

The server simply proxies the request:

```
Dashboard → GET /api/session-messages?machineId=abc&sessionId=xyz&offset=0&limit=10
Server    → GET http://<agentHost>:<agentPort>/api/session-messages?sessionId=xyz&offset=0&limit=10
Agent     → reads JSONL file, returns response
Server    → forwards response to dashboard
```

**Error responses:**

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "error": "Missing machineId or sessionId" }` | Required params not provided |
| 404 | `{ "error": "Machine not found" }` | `machineId` not in the store or machine has no terminal port |
| 502 | `{ "error": "Failed to fetch messages from agent" }` | Agent unreachable or returned error |

### 4c. Shared types (add to `shared/src/index.ts`)

```ts
export interface SessionMessage {
  role: "user" | "assistant";
  timestamp: string;
  content: string;
  toolUse?: { name: string; id: string }[];
  toolResult?: string;
  model?: string;
}

export interface SessionMessagesResponse {
  messages: SessionMessage[];
  total: number;
  hasMore: boolean;
}
```

---

## 5. Data Flow

The complete data flow for the enhanced fullscreen pane involves three independent streams of information that converge in the component:

### Flow diagram

```
                    +-----------------+
                    |  JSONL File     |
                    |  (filesystem)   |
                    +--------+--------+
                             |
               +-------------+-------------+
               |                           |
    Heartbeat (every 5s)          On-demand API call
               |                           |
               v                           v
    +----------+----------+    +-----------+-----------+
    | session-parser.ts   |    | GET /api/session-     |
    | discoverSessions()  |    | messages              |
    +----------+----------+    +-----------+-----------+
               |                           |
               v                           v
    +----------+----------+    +-----------+-----------+
    | Agent heartbeat     |    | Agent HTTP response   |
    | POST /api/heartbeat |    | { messages, total,    |
    +----------+----------+    |   hasMore }           |
               |               +-----------+-----------+
               v                           |
    +----------+----------+                |
    | Server store +      |                |
    | WS broadcast        |                |
    +----------+----------+    +-----------+-----------+
               |               | Server proxy          |
               v               | GET /api/session-     |
    +----------+----------+    | messages              |
    | useWebSocket hook   |    +-----------+-----------+
    | machines[] state    |                |
    +----------+----------+                |
               |                           |
               +-------------+-------------+
                             |
                             v
                  +----------+----------+
                  | SessionFullscreen   |
                  | - live session data |
                  | - message history   |
                  +---------------------+
```

### Step-by-step walkthrough

#### Step 1: User opens fullscreen

1. User clicks "Expand" on a `SessionCard`.
2. `SessionCard` calls `onFullscreen(session)`.
3. `App.tsx` stores `{ machineId, sessionId }` in the `fullscreen` state.
4. On the next render, `App.tsx` derives the live `SessionInfo` from the `machines` array and passes it to `SessionFullscreen`.
5. `SessionFullscreen` mounts and fires an initial `loadMessages(0)` call to fetch the most recent 10 entries via `GET /api/session-messages`.

#### Step 2: WebSocket updates refresh session metadata

1. The agent sends a heartbeat every 5 seconds.
2. The server broadcasts `machines_update` via WebSocket.
3. `useWebSocket` updates the `machines` state.
4. `App.tsx` re-derives the live session from the updated `machines` array.
5. `SessionFullscreen` receives a new `session` prop with updated `status`, `lastMessage`, `lastAssistantMessage`, and `lastActivity`.
6. The status indicator, freshness timestamp, and (if the most recent message changed) the flash animation all update automatically.

Note: The message *history* (loaded via API) is not refreshed on every heartbeat. Only the "live" fields from `SessionInfo` update. This avoids unnecessary API calls. However, when the `lastMessage` field changes (indicating the agent produced new output), the component could optionally trigger a refresh of the most recent message batch to pick up new entries. This is a design tradeoff:

- **Option A (recommended):** Do not auto-refresh history. The `lastAssistantMessage` field (already in `SessionInfo`) shows the latest response. The history is loaded on demand.
- **Option B:** When `session.lastActivity` changes, silently re-fetch `offset=0, limit=10` and merge any new entries into the bottom of the history. This requires deduplication by timestamp.

#### Step 3: User loads previous messages

1. User clicks "Load previous messages" at the top of the message area.
2. Frontend calls `GET /api/session-messages?machineId=...&sessionId=...&offset=10&limit=10`.
3. The server proxies to the agent.
4. The agent reads the JSONL file, parses entries, paginates from the end, and returns the batch.
5. The frontend prepends the returned messages to the `history` array.
6. Scroll position is preserved so the user's viewport does not jump (see section 2c).
7. If `hasMore === false`, the "Load previous messages" button is hidden.

#### Step 4: User sends a message

1. User types in the `SendMessage` textarea and presses Ctrl+Enter (or clicks Send).
2. `SendMessage` calls `POST /api/sessions/send` with `{ machineId, multiplexer, session, text }`.
3. The server proxies to the agent's `POST /api/send`, which attaches to the multiplexer session via a PTY helper and sends the keystrokes.
4. The Claude CLI inside the multiplexer session receives the input and begins processing.
5. The `onSent` callback fires, triggering `scrollToBottom()` in the fullscreen pane.
6. On the next heartbeat (within ~5 seconds), the agent reads the updated JSONL file and reports new `lastMessage` / `lastAssistantMessage` / `status` fields.
7. The WebSocket pushes the update to the dashboard, and the fullscreen pane re-renders with the new data.

#### Step 5: User closes fullscreen

1. User clicks the close button, clicks the overlay backdrop, or presses Escape.
2. `App.tsx` sets `fullscreen` to `null`.
3. `SessionFullscreen` unmounts; its message history state is discarded.
4. Re-opening the same session will trigger a fresh `loadMessages(0)` call.

---

## Implementation Checklist

Below is a suggested order of implementation, following a test-driven approach:

### Phase 1: API layer

- [ ] Add `SessionMessage` and `SessionMessagesResponse` types to `shared/src/index.ts`
- [ ] Implement `findJsonlFile()` and `getSessionMessages()` in a new `agent/src/session-messages.ts` module (or extend `session-parser.ts`)
- [ ] Write unit tests for `getSessionMessages()` with mock JSONL data covering:
  - Basic pagination (offset/limit)
  - Filtering of non-standard entry types (`last-prompt`, `summary`)
  - Edge cases: empty file, single entry, offset beyond total
  - Content extraction from string content and array content blocks
  - Tool use and tool result extraction
- [ ] Add the `GET /api/session-messages` handler to `agent/src/terminal-server.ts`
- [ ] Add the proxy route to `server/src/index.ts`

### Phase 2: Real-time updates

- [ ] Refactor `FullscreenTarget` in `App.tsx` to store `sessionId` instead of `session`
- [ ] Add live session derivation from `machines` array
- [ ] Add auto-close when session disappears
- [ ] Add tick interval for freshness timestamp
- [ ] Add flash animation CSS and effect hook
- [ ] Write tests verifying the component re-renders on prop changes

### Phase 3: Message history UI

- [ ] Add message history state and loading logic to `SessionFullscreen.tsx`
- [ ] Implement "Load previous messages" button with scroll preservation
- [ ] Implement chat-style message rendering (user vs. assistant styling)
- [ ] Add markdown rendering for assistant messages (reuse existing `Markdown` setup)
- [ ] Add tool use badges for entries with tool calls
- [ ] Add CSS styles for the chat interface

### Phase 4: Interaction improvements

- [ ] Add Escape key handler to `SessionFullscreen.tsx`
- [ ] Add `variant` prop to `SendMessage.tsx` for fullscreen styling
- [ ] Restructure fullscreen layout: sticky input at bottom, scrollable messages
- [ ] Implement auto-scroll on send
- [ ] Test keyboard interactions (Escape closes pane, Ctrl+Enter sends, Escape in textarea does not close)

### Phase 5: Polish

- [ ] Run full test suite; fix regressions
- [ ] Run linters and formatters
- [ ] Test with real JSONL files of various sizes
- [ ] Verify behavior with multiple machines and sessions
- [ ] Test edge cases: session deleted while fullscreen is open, agent goes offline, empty conversation history

---

## Performance Considerations

- **JSONL file reading:** The `getSessionMessages()` function reads the entire file into memory and splits by newlines. For very long sessions (thousands of entries), this could be slow. A future optimization would be to read the file in reverse using a seek-based approach (read the last N bytes, find newline boundaries). For the initial implementation, full-file read is acceptable since most sessions are under 10,000 lines.

- **Heartbeat frequency:** The agent sends heartbeats every 5 seconds. This means the fullscreen pane's live data has a maximum staleness of 5 seconds. This is acceptable for a monitoring dashboard. The freshness indicator ("Updated 3s ago") communicates this to the user.

- **Message deduplication:** If the frontend ever re-fetches the most recent batch (e.g., after detecting a `lastMessage` change), it must deduplicate against messages already in the `history` array. Using the `timestamp` field as a key is sufficient since entries have unique timestamps.

- **Memory:** The frontend stores all loaded messages in component state. Loading 100+ messages is fine for React. If users load very deep history (500+ messages), consider virtualizing the list with a library like `react-window`.
