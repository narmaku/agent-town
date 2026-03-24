import {
  type AgentType,
  formatCompactTokens,
  type SessionInfo,
  type SessionMessage,
  type TerminalMultiplexer,
} from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useResizable } from "../hooks/useResizable";
import { AGENT_TYPE_LABELS, API, STATUS_CONFIG, timeAgo } from "../utils";
import { DiffModal } from "./DiffModal";
import { SendMessage } from "./SendMessage";

const BATCH_SIZE = 10;
const LOAD_ALL_MESSAGES_LIMIT = 10_000;
const DEFAULT_AGENT_TYPE: AgentType = "claude-code";
const INFO_PANE_BREAKPOINT = 1200;
const INFO_PANE_DEFAULT_WIDTH = 300;
const INFO_PANE_MIN_WIDTH = 220;
const INFO_PANE_MAX_WIDTH = 500;
const INFO_PANE_STORAGE_KEY = "agentTown:infoPaneVisible";

function loadInfoPaneVisible(): boolean {
  try {
    const stored = localStorage.getItem(INFO_PANE_STORAGE_KEY);
    if (stored !== null) return stored === "true";
  } catch (_err) {
    // localStorage unavailable
  }
  return true;
}

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

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    function handleResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return width;
}

interface Props {
  session: SessionInfo;
  machineId: string;
  machineName?: string;
  onOpenTerminal: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  autoDeleteOnClose?: boolean;
  onClose?: () => void;
  extraActions?: React.ReactNode;
}

export function SessionDetail({
  session,
  machineId,
  machineName,
  onOpenTerminal,
  onResume,
  autoDeleteOnClose,
  onClose,
  extraActions,
}: Props) {
  const config = STATUS_CONFIG[session.status];
  const hasTerminal = session.multiplexer && session.multiplexerSession;
  const windowWidth = useWindowWidth();
  const isWide = windowWidth >= INFO_PANE_BREAKPOINT;
  const infoPaneResize = useResizable({
    storageKey: "infoPaneWidth",
    defaultSize: INFO_PANE_DEFAULT_WIDTH,
    minSize: INFO_PANE_MIN_WIDTH,
    maxSize: INFO_PANE_MAX_WIDTH,
    side: "right",
  });
  const inputResize = useResizable({
    storageKey: "inputPaneHeight",
    defaultSize: 120,
    minSize: 60,
    maxSize: 400,
    side: "bottom",
  });

  const [history, setHistory] = useState<SessionMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [offset, setOffset] = useState(0);
  const [flash, setFlash] = useState(false);
  const [, setTick] = useState(0);
  const [showToolDetails, setShowToolDetails] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [infoPaneVisible, setInfoPaneVisible] = useState(loadInfoPaneVisible);
  const [infoPaneOverlay, setInfoPaneOverlay] = useState(false);

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
            `&agentType=${session.agentType || DEFAULT_AGENT_TYPE}` +
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
      } catch (err) {
        console.warn("Failed to load messages:", err instanceof Error ? err.message : String(err));
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
          `&agentType=${session.agentType || DEFAULT_AGENT_TYPE}` +
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
    } catch (err) {
      console.warn("Failed to refresh latest messages:", err instanceof Error ? err.message : String(err));
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

  async function loadAll() {
    setLoadingHistory(true);
    try {
      const resp = await fetch(
        `${API.SESSION_MESSAGES}?machineId=${machineId}` +
          `&sessionId=${session.sessionId}` +
          `&agentType=${session.agentType || DEFAULT_AGENT_TYPE}` +
          `&offset=0&limit=${LOAD_ALL_MESSAGES_LIMIT}`,
      );
      if (!resp.ok) return;
      const data: { messages: SessionMessage[]; total: number; hasMore: boolean } = await resp.json();
      setHistory(data.messages);
      setHasMore(false);
      setOffset(data.total);
    } catch (err) {
      console.warn("Failed to load all messages:", err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingHistory(false);
    }
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
        } catch (_err) {
          // deletion is best-effort
        }
      }
    } catch (_err) {
      // will disappear on next heartbeat
    }
  }

  const agentLabel = AGENT_TYPE_LABELS[session.agentType] || session.agentType;
  const displayMachineName = machineName || machineId;
  const showInlineActions = isWide && !infoPaneVisible;

  const actionButtons = (
    <>
      {hasTerminal && (
        <button
          type="button"
          className="action-btn terminal-btn"
          onClick={() => onOpenTerminal(session.multiplexerSession ?? "", session.multiplexer ?? "zellij")}
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
      {(session.cwd || session.projectPath) && (
        <button
          type="button"
          className="action-btn diff-btn"
          onClick={() => setShowDiff(true)}
          aria-label="View git changes"
        >
          View Changes
        </button>
      )}
      {hasTerminal && (
        <button type="button" className="action-btn kill-btn" onClick={handleKillSession}>
          Close Agent
        </button>
      )}
      {extraActions}
    </>
  );

  const infoPaneContent = (
    <div className="info-pane-content">
      <div className="info-pane-agent-header">
        <span className={`info-pane-agent-badge agent-${session.agentType}`}>{agentLabel}</span>
        <span className="info-pane-machine-name" title={displayMachineName}>
          @ {displayMachineName}
        </span>
      </div>

      <div className="info-pane-status-row">
        <span className={`status-dot ${config.pulse ? "pulse" : ""}`} style={{ background: config.color }} />
        <span style={{ color: config.color }}>{config.label}</span>
        <span
          className={`tracking-badge ${session.hookEnabled ? "hook" : "heuristic"}`}
          title={session.hookEnabled ? "Real-time tracking via hooks" : "Estimated status (no hooks)"}
        >
          {session.hookEnabled ? "LIVE" : "EST"}
        </span>
        {session.currentTool && <span className="current-tool-badge">{session.currentTool}</span>}
      </div>

      <div className="info-pane-section">
        <div className="info-pane-detail-row" title={session.projectPath}>
          <span className="info-pane-detail-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Project">
              <path d="M1.5 1h5l1 1H14.5a1 1 0 011 1v10a1 1 0 01-1 1h-13a1 1 0 01-1-1V2a1 1 0 011-1z" />
            </svg>
          </span>
          <span className="detail-value mono">{session.projectPath}</span>
        </div>
        {session.gitBranch && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Branch">
                <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6.5a2.5 2.5 0 01-2.5 2.5H7.5a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V4.872a2.25 2.25 0 111.5 0V6.5a2.5 2.5 0 002.5-2.5v-1.128A2.251 2.251 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM4.25 2.5a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
            </span>
            <span className="detail-value mono">{session.gitBranch}</span>
          </div>
        )}
        {session.model && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Model">
                <path d="M8 1a2 2 0 012 2v.5h2A1.5 1.5 0 0113.5 5v2H14a2 2 0 110 4h-.5v2a1.5 1.5 0 01-1.5 1.5h-2V14a2 2 0 11-4 0v-.5H4A1.5 1.5 0 012.5 12v-2H2a2 2 0 110-4h.5V4A1.5 1.5 0 014 2.5h2V2a2 2 0 012-2z" />
              </svg>
            </span>
            <span className="detail-value mono">{session.model}</span>
          </div>
        )}
        {session.totalInputTokens != null && session.totalInputTokens > 0 && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Tokens">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.4.8l2 1.5a1 1 0 101.2-1.6L9 7.5V5z" />
              </svg>
            </span>
            <span className="detail-value mono">
              {session.totalInputTokens.toLocaleString()} in / {(session.totalOutputTokens ?? 0).toLocaleString()} out (
              {formatCompactTokens((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} total)
            </span>
          </div>
        )}
        {session.contextTokens != null && session.contextTokens > 0 && (
          <div className="info-pane-detail-row">
            <span className="info-pane-detail-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="Context">
                <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 016.5 9h6V1.5z" />
              </svg>
            </span>
            <span className="detail-value mono">{formatCompactTokens(session.contextTokens)} context</span>
          </div>
        )}
      </div>

      <div className="info-pane-section">
        <div className="info-pane-section-title">Display</div>
        <div className="info-pane-toggles">
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
        </div>
      </div>

      <div className="info-pane-section info-pane-section-actions">
        <div className="info-pane-actions">{actionButtons}</div>
      </div>
    </div>
  );

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
        <div className="fullscreen-header-right">
          <button
            type="button"
            className={`info-pane-toggle${isWide && infoPaneVisible ? " active" : ""}`}
            onClick={() => {
              if (isWide) {
                const next = !infoPaneVisible;
                setInfoPaneVisible(next);
                try {
                  localStorage.setItem(INFO_PANE_STORAGE_KEY, String(next));
                } catch (_err) {
                  // localStorage unavailable
                }
              } else {
                setInfoPaneOverlay((prev) => !prev);
              }
            }}
            aria-label={infoPaneVisible ? "Hide session info" : "Show session info"}
            title={infoPaneVisible ? "Hide info" : "Show info"}
          >
            &#9432;
          </button>
          {onClose && (
            <button type="button" className="modal-close" onClick={onClose}>
              &times;
            </button>
          )}
        </div>
      </div>

      <div className={`fullscreen-body${infoPaneResize.isDragging || inputResize.isDragging ? " resizing" : ""}`}>
        <div className="fullscreen-main">
          <div className={`fullscreen-messages ${flash ? "flash" : ""}`} ref={messageContainerRef}>
            {hasMore && (
              <div className="chat-controls">
                <button type="button" className="load-previous-btn" onClick={loadPrevious} disabled={loadingHistory}>
                  {loadingHistory ? "Loading..." : "Load previous messages"}
                </button>
                <button
                  type="button"
                  className="load-previous-btn load-all-btn"
                  onClick={loadAll}
                  disabled={loadingHistory}
                >
                  Load all
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
                            {msg.toolUse?.map((t) => (
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

          {showInlineActions && <div className="fullscreen-actions">{actionButtons}</div>}

          {hasTerminal && (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle requires mouse interaction */}
              <div
                className={`resize-handle resize-handle-vertical${inputResize.isDragging ? " active" : ""}`}
                onMouseDown={inputResize.handleMouseDown}
                onDoubleClick={inputResize.resetSize}
                title="Drag to resize, double-click to reset"
              />
              <div className="fullscreen-input" style={{ height: inputResize.size }}>
                <SendMessage
                  machineId={machineId}
                  multiplexer={session.multiplexer ?? "zellij"}
                  session={session.multiplexerSession ?? ""}
                  agentType={session.agentType}
                  onSent={handleSent}
                />
              </div>
            </>
          )}
        </div>

        {isWide && infoPaneVisible && (
          /* biome-ignore lint/a11y/noStaticElementInteractions: resize handle requires mouse interaction */
          <div
            className={`resize-handle resize-handle-right${infoPaneResize.isDragging ? " active" : ""}`}
            onMouseDown={infoPaneResize.handleMouseDown}
            onDoubleClick={infoPaneResize.resetSize}
            title="Drag to resize, double-click to reset"
          />
        )}
        {isWide && (
          <div
            className={`info-pane${!infoPaneVisible ? " collapsed" : ""}`}
            style={infoPaneVisible ? { width: infoPaneResize.size } : undefined}
          >
            {infoPaneContent}
          </div>
        )}

        {!isWide && infoPaneOverlay && (
          <>
            <button
              type="button"
              className="info-pane-backdrop"
              onClick={() => setInfoPaneOverlay(false)}
              aria-label="Close info panel"
            />
            <div className="info-pane info-pane-overlay">{infoPaneContent}</div>
          </>
        )}
      </div>

      {showDiff && (session.cwd || session.projectPath) && (
        <DiffModal machineId={machineId} dir={session.cwd || session.projectPath} onClose={() => setShowDiff(false)} />
      )}
    </>
  );
}
