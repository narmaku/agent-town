import {
  type AgentType,
  formatCompactTokens,
  formatCost,
  type SessionInfo,
  type SessionMessage,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { API, STATUS_CONFIG, timeAgo } from "../utils";
import { SendMessage } from "./SendMessage";

const BATCH_SIZE = 10;

function isToolResultMessage(msg: SessionMessage): boolean {
  return msg.role === "user" && !msg.content.trim() && !!(msg.toolResult || msg.toolResults?.length);
}

function isToolOnlyMessage(msg: SessionMessage): boolean {
  return msg.role === "assistant" && !msg.content.trim() && !msg.thinking && !!msg.toolUse?.length;
}

function ToolCallBlock({
  tool,
  toolResults,
}: {
  tool: { name: string; id: string; input?: string };
  toolResults?: { toolUseId: string; content: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const result = toolResults?.find((r) => r.toolUseId === tool.id);

  return (
    <div className="tool-call-group">
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${tool.name} tool call`}
      >
        <span className="tool-badge">{tool.name}</span>
        <span className="tool-call-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>
      {expanded && (
        <div className="tool-call-detail">
          {tool.input && (
            <div className="tool-call-input">
              <div className="tool-call-label">Input</div>
              <pre>{tool.input}</pre>
            </div>
          )}
          {result && (
            <div className="tool-call-result">
              <div className="tool-call-label">Result</div>
              <pre>{result.content}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const markdownComponents: Record<
  string,
  React.ComponentType<{ className?: string; children?: React.ReactNode; [key: string]: unknown }>
> = {
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode; [key: string]: unknown }) {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <pre className="code-block">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
};

interface Props {
  session: SessionInfo;
  machineId: string;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  autoDeleteOnClose?: boolean;
  onClose?: () => void;
  extraActions?: React.ReactNode;
}

export function SessionDetail({
  session,
  machineId,
  onOpenTerminal,
  onResume,
  autoDeleteOnClose,
  onClose,
  extraActions,
}: Props) {
  const config = STATUS_CONFIG[session.status];
  const hasTerminal = session.multiplexer && session.multiplexerSession;

  const [history, setHistory] = useState<SessionMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [offset, setOffset] = useState(0);
  const [flash, setFlash] = useState(false);
  const [, setTick] = useState(0);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const prevMessageRef = useRef(session.lastMessage);

  // Tick for live timestamp updates
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  // Flash on message change
  useEffect(() => {
    if (session.lastMessage !== prevMessageRef.current) {
      setFlash(true);
      prevMessageRef.current = session.lastMessage;
      const timeout = setTimeout(() => setFlash(false), 1000);
      return () => clearTimeout(timeout);
    }
  }, [session.lastMessage]);

  const loadMessages = useCallback(
    async (currentOffset: number) => {
      setLoadingHistory(true);
      try {
        const resp = await fetch(
          `${API.SESSION_MESSAGES}?machineId=${machineId}` +
            `&sessionId=${session.sessionId}` +
            `&agentType=${session.agentType || "claude-code"}` +
            `&offset=${currentOffset}&limit=${BATCH_SIZE}`,
        );
        if (!resp.ok) return;

        const data: { messages: SessionMessage[]; total: number; hasMore: boolean } = await resp.json();

        if (currentOffset === 0) {
          setHistory(data.messages);
        } else {
          setHistory((prev) => [...data.messages, ...prev]);
        }
        setHasMore(data.hasMore);
        setOffset(currentOffset + BATCH_SIZE);
      } catch {
        // silently fail
      } finally {
        setLoadingHistory(false);
      }
    },
    [machineId, session.sessionId, session.agentType],
  );

  const refreshLatest = useCallback(async () => {
    try {
      const resp = await fetch(
        `${API.SESSION_MESSAGES}?machineId=${machineId}` +
          `&sessionId=${session.sessionId}` +
          `&agentType=${session.agentType || "claude-code"}` +
          `&offset=0&limit=${BATCH_SIZE}`,
      );
      if (!resp.ok) return;

      const data: { messages: SessionMessage[]; total: number; hasMore: boolean } = await resp.json();

      setHistory((prev) => {
        const oldCount = Math.max(0, prev.length - BATCH_SIZE);
        const olderMessages = prev.slice(0, oldCount);
        return [...olderMessages, ...data.messages];
      });

      setOffset((currentOffset) => {
        const totalLoaded = Math.max(currentOffset, BATCH_SIZE);
        setHasMore(data.total > totalLoaded);
        return currentOffset;
      });
    } catch {
      // silently fail
    }
  }, [machineId, session.sessionId, session.agentType]);

  // Load initial messages
  useEffect(() => {
    setHistory([]);
    setOffset(0);
    setHasMore(true);
    loadMessages(0);
  }, [loadMessages]);

  // Re-fetch latest messages when session data changes (heartbeat update).
  // session.lastMessage changes when the agent reports new JSONL content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastMessage is an intentional trigger
  useEffect(() => {
    refreshLatest();
  }, [refreshLatest, session.lastMessage]);

  // Auto-refresh messages every 5s while session is active
  useEffect(() => {
    const isActive = session.status === "working" || session.status === "awaiting_input";
    if (!isActive) return;
    const interval = setInterval(refreshLatest, 5000);
    return () => clearInterval(interval);
  }, [refreshLatest, session.status]);

  async function loadPrevious() {
    const container = messageContainerRef.current;
    if (!container) return;
    const prevScrollHeight = container.scrollHeight;
    await loadMessages(offset);
    requestAnimationFrame(() => {
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeight;
    });
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function handleSent() {
    await new Promise((r) => setTimeout(r, 1500));
    await refreshLatest();
    scrollToBottom();
  }

  async function handleKillSession() {
    if (!hasTerminal) return;
    if (!window.confirm(`Close session "${session.multiplexerSession}"? This will terminate the agent.`)) return;

    try {
      const resp = await fetch(API.SESSIONS_KILL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          multiplexer: session.multiplexer,
          session: session.multiplexerSession,
        }),
      });

      if (resp.ok && autoDeleteOnClose) {
        try {
          await fetch(API.SESSIONS_DELETE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              machineId,
              sessionId: session.sessionId,
              multiplexer: session.multiplexer,
              multiplexerSession: session.multiplexerSession,
            }),
          });
        } catch {
          // deletion is best-effort
        }
      }
    } catch {
      // will disappear on next heartbeat
    }
  }

  return (
    <>
      <div className="fullscreen-header">
        <div className="fullscreen-title-row">
          <div className="session-status">
            <span className={`status-dot ${config.pulse ? "pulse" : ""}`} style={{ background: config.color }} />
            <span className="status-label" style={{ color: config.color }}>
              {config.label}
            </span>
            {session.currentTool && <span className="current-tool-badge">{session.currentTool}</span>}
            <span
              className={`tracking-badge ${session.hookEnabled ? "hook" : "heuristic"}`}
              title={session.hookEnabled ? "Real-time tracking via hooks" : "Estimated status (no hooks)"}
            >
              {session.hookEnabled ? "LIVE" : "EST"}
            </span>
          </div>
          <span className="fullscreen-name">{session.customName || session.slug}</span>
          <span className="session-time">Updated {timeAgo(session.lastActivity)}</span>
        </div>
        <div className="detail-toggles">
          <label className="detail-switch" aria-label="Show thinking blocks">
            <input type="checkbox" checked={showThinking} onChange={() => setShowThinking((prev) => !prev)} />
            <span className="switch-slider" />
            <span className="switch-label">Thinking</span>
          </label>
          <label className="detail-switch" aria-label="Show tool details">
            <input type="checkbox" checked={showToolDetails} onChange={() => setShowToolDetails((prev) => !prev)} />
            <span className="switch-slider" />
            <span className="switch-label">Tools</span>
          </label>
          {onClose && (
            <button type="button" className="modal-close" onClick={onClose}>
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="fullscreen-meta">
        <div className="detail-row">
          <span className="detail-label">Project</span>
          <span className="detail-value mono">{session.projectPath}</span>
        </div>
        {session.gitBranch && (
          <div className="detail-row">
            <span className="detail-label">Branch</span>
            <span className="detail-value mono">{session.gitBranch}</span>
          </div>
        )}
        {session.model && (
          <div className="detail-row">
            <span className="detail-label">Model</span>
            <span className="detail-value mono">{session.model}</span>
          </div>
        )}
        {session.totalInputTokens != null && session.totalInputTokens > 0 && (
          <div className="detail-row">
            <span className="detail-label">Tokens</span>
            <span className="detail-value mono">
              {session.totalInputTokens.toLocaleString()} in / {(session.totalOutputTokens ?? 0).toLocaleString()} out (
              {formatCompactTokens((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} total)
            </span>
          </div>
        )}
        {session.estimatedCost != null && session.estimatedCost > 0 && (
          <div className="detail-row">
            <span className="detail-label">Est. Cost</span>
            <span className="detail-value mono">~{formatCost(session.estimatedCost)}</span>
          </div>
        )}
      </div>

      <div className={`fullscreen-messages ${flash ? "flash" : ""}`} ref={messageContainerRef}>
        {hasMore && (
          <div className="chat-controls">
            <button type="button" className="load-previous-btn" onClick={loadPrevious} disabled={loadingHistory}>
              {loadingHistory ? "Loading..." : "Load previous messages"}
            </button>
          </div>
        )}

        {history
          .filter((msg) => showToolDetails || !isToolResultMessage(msg))
          .map((msg) => (
            <div
              key={`${msg.timestamp}-${msg.role}-${msg.content?.slice(0, 20) ?? ""}`}
              className={`chat-message chat-${msg.role}`}
            >
              <div className="chat-message-header">
                <span className="chat-role">{msg.role === "user" ? "You" : "Assistant"}</span>
                <span className="chat-timestamp">{new Date(msg.timestamp).toLocaleString()}</span>
                {msg.model && <span className="chat-model">{msg.model}</span>}
              </div>
              <div className="chat-message-body">
                {msg.thinking && showThinking && (
                  <details className="thinking-block" open>
                    <summary>Thinking...</summary>
                    <div className="thinking-content">{msg.thinking}</div>
                  </details>
                )}
                {msg.role === "assistant" ? (
                  <>
                    {msg.content.trim() ? (
                      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {msg.content}
                      </Markdown>
                    ) : isToolOnlyMessage(msg) && !showToolDetails ? (
                      <div className="chat-tools-summary">
                        Used{" "}
                        {msg.toolUse!.map((t) => (
                          <span key={t.id} className="tool-badge">
                            {t.name}
                          </span>
                        ))}
                      </div>
                    ) : msg.toolUse?.length && showToolDetails ? null : !msg.thinking ? (
                      <span className="chat-empty-hint">[No text content]</span>
                    ) : null}
                    {msg.toolUse && msg.toolUse.length > 0 && showToolDetails && (
                      <div className="chat-tool-calls">
                        {msg.toolUse.map((t) => (
                          <ToolCallBlock key={t.id} tool={t} toolResults={msg.toolResults} />
                        ))}
                      </div>
                    )}
                    {msg.toolUse && msg.toolUse.length > 0 && !showToolDetails && msg.content.trim() && (
                      <div className="chat-tools">
                        {msg.toolUse.map((t) => (
                          <span key={t.id} className="tool-badge">
                            {t.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="chat-user-text">
                    {msg.content.trim()
                      ? msg.content
                      : showToolDetails && msg.toolResults?.length
                        ? msg.toolResults.map((tr) => (
                            <div key={tr.toolUseId} className="tool-call-result">
                              <div className="tool-call-label">Result ({tr.toolUseId})</div>
                              <pre>{tr.content}</pre>
                            </div>
                          ))
                        : msg.content || "[tool result]"}
                  </div>
                )}
              </div>
            </div>
          ))}

        {history.length === 0 && !loadingHistory && (
          <div className="no-sessions" style={{ padding: "40px 0" }}>
            No messages yet
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="fullscreen-actions">
        {hasTerminal && (
          <button
            type="button"
            className="action-btn terminal-btn"
            onClick={() => onOpenTerminal(session.multiplexerSession!, session.multiplexer!)}
          >
            Open Terminal
          </button>
        )}
        {(session.status === "exited" || session.status === "done" || !hasTerminal) && (
          <button
            type="button"
            className="action-btn resume-btn"
            onClick={() => onResume(session.sessionId, session.projectPath, session.agentType)}
          >
            Resume
          </button>
        )}
        {hasTerminal && (
          <button type="button" className="action-btn kill-btn" onClick={handleKillSession}>
            Close Agent
          </button>
        )}
        {extraActions}
      </div>

      {hasTerminal && (
        <div className="fullscreen-input">
          <SendMessage
            machineId={machineId}
            multiplexer={session.multiplexer!}
            session={session.multiplexerSession!}
            agentType={session.agentType}
            onSent={handleSent}
          />
        </div>
      )}
    </>
  );
}
