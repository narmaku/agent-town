import type { AgentType, SessionInfo, SessionMessage, TerminalMultiplexer } from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useResizable } from "../hooks/useResizable";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { API, STATUS_CONFIG, timeAgo } from "../utils";
import { DiffModal } from "./DiffModal";
import { InfoPane } from "./InfoPane";
import { SendMessage } from "./SendMessage";
import { TerminalPane } from "./TerminalPane";

type SessionTab = "chat" | "terminal";

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

interface Props {
  session: SessionInfo;
  machineId: string;
  machineName?: string;
  onOpenTerminalFullscreen?: (sessionName: string, multiplexer: TerminalMultiplexer) => void;
  onResume: (sessionId: string, projectDir: string, agentType: AgentType) => void;
  autoDeleteOnClose?: boolean;
  onClose?: () => void;
  extraActions?: React.ReactNode;
}

export function SessionDetail({
  session,
  machineId,
  machineName,
  onOpenTerminalFullscreen,
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
  const [activeTab, setActiveTab] = useState<SessionTab>("chat");
  const [showResumeConfirm, setShowResumeConfirm] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [pendingTerminalSwitch, setPendingTerminalSwitch] = useState(false);

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

  function handleTabSwitch(tab: SessionTab) {
    if (tab === "terminal" && !hasTerminal) {
      // Session is idle/exited — show resume confirmation
      setShowResumeConfirm(true);
      return;
    }
    setActiveTab(tab);
  }

  async function handleResumeForTerminal() {
    setResuming(true);
    try {
      const resp = await fetch(API.AGENTS_RESUME, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          sessionId: session.sessionId,
          projectDir: session.projectPath,
          autonomous: false,
          agentType: session.agentType,
        }),
      });

      if (resp.ok) {
        setShowResumeConfirm(false);
        setPendingTerminalSwitch(true);
      } else {
        const data = await resp.json().catch(() => ({ error: "Resume failed" }));
        window.alert(data.error || "Resume failed");
      }
    } catch {
      window.alert("Failed to connect to server");
    } finally {
      setResuming(false);
    }
  }

  // Auto-switch to terminal tab when a terminal becomes available after resume
  useEffect(() => {
    if (hasTerminal && showResumeConfirm) {
      setShowResumeConfirm(false);
      setActiveTab("terminal");
    }
    if (hasTerminal && pendingTerminalSwitch) {
      setPendingTerminalSwitch(false);
      setActiveTab("terminal");
    }
  }, [hasTerminal, showResumeConfirm, pendingTerminalSwitch]);

  // If terminal goes away while on terminal tab (and not waiting for one), switch back to chat
  useEffect(() => {
    if (!hasTerminal && activeTab === "terminal" && !pendingTerminalSwitch) {
      setActiveTab("chat");
    }
  }, [hasTerminal, activeTab, pendingTerminalSwitch]);

  const displayMachineName = machineName || machineId;
  const showInlineActions = isWide && !infoPaneVisible;

  const actionButtons = (
    <>
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
    <InfoPane
      session={session}
      displayMachineName={displayMachineName}
      showThinking={showThinking}
      onToggleThinking={() => setShowThinking((prev) => !prev)}
      showToolDetails={showToolDetails}
      onToggleToolDetails={() => setShowToolDetails((prev) => !prev)}
      actionButtons={actionButtons}
    />
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
          <div className="session-tabs">
            <button
              type="button"
              className={`session-tab${activeTab === "chat" ? " active" : ""}`}
              onClick={() => handleTabSwitch("chat")}
              aria-label="Show chat view"
            >
              Chat
            </button>
            <button
              type="button"
              className={`session-tab${activeTab === "terminal" ? " active" : ""}`}
              onClick={() => handleTabSwitch("terminal")}
              aria-label="Show terminal view"
            >
              Terminal
            </button>
          </div>
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
          {activeTab === "chat" ? (
            <>
              <div className={`fullscreen-messages ${flash ? "flash" : ""}`} ref={messageContainerRef}>
                {hasMore && (
                  <div className="chat-controls">
                    <button
                      type="button"
                      className="load-previous-btn"
                      onClick={loadPrevious}
                      disabled={loadingHistory}
                    >
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
            </>
          ) : (
            <div className="terminal-tab-content">
              <div className="terminal-tab-toolbar">
                {onOpenTerminalFullscreen && hasTerminal && (
                  <button
                    type="button"
                    className="action-btn terminal-btn"
                    onClick={() =>
                      onOpenTerminalFullscreen(session.multiplexerSession ?? "", session.multiplexer ?? "zellij")
                    }
                    aria-label="Open terminal in fullscreen"
                  >
                    Fullscreen
                  </button>
                )}
              </div>
              {hasTerminal && (
                <TerminalPane
                  machineId={machineId}
                  sessionName={session.multiplexerSession ?? ""}
                  multiplexer={session.multiplexer ?? "zellij"}
                />
              )}
            </div>
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
            style={{ "--panel-width": `${infoPaneResize.size}px` } as React.CSSProperties}
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

      {showResumeConfirm && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismissal
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowResumeConfirm(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowResumeConfirm(false);
          }}
          role="presentation"
        >
          <div className="modal-panel">
            <div className="modal-header">
              <h2 className="modal-title">Resume Session</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowResumeConfirm(false)}
                aria-label="Close resume dialog"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p>This session has no active terminal. Resuming will restart the agent session so you can connect.</p>
              <p style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 13 }}>
                Session: {session.customName || session.slug}
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="action-btn"
                onClick={() => setShowResumeConfirm(false)}
                aria-label="Cancel resume"
              >
                Cancel
              </button>
              <button
                type="button"
                className="send-btn"
                onClick={handleResumeForTerminal}
                disabled={resuming}
                aria-label={resuming ? "Resuming session" : "Resume session and connect terminal"}
              >
                {resuming ? "Resuming..." : "Resume & Connect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
