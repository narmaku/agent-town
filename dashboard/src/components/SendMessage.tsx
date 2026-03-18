import { useEffect, useRef, useState } from "react";
import { API } from "../utils";

interface Props {
  machineId: string;
  multiplexer: string;
  session: string;
  onSent?: () => void;
}

export function SendMessage({ machineId, multiplexer, session, onSent }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, []);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError("");

    try {
      const resp = await fetch(API.SESSIONS_SEND, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          multiplexer,
          session,
          text: text.trim(),
        }),
      });

      if (resp.ok) {
        setText("");
        onSent?.();
      } else {
        const data = await resp.json().catch(() => ({ error: "Send failed" }));
        setError(data.error || `Send failed (${resp.status})`);
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    // Ctrl+Enter or Cmd+Enter to send
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation container, not interactive
    <div className="send-message" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <textarea
        ref={textareaRef}
        className="send-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Send a message to the agent..."
        rows={2}
        disabled={sending}
      />
      {error && (
        <div className="form-error" style={{ marginTop: 4 }}>
          {error}
        </div>
      )}
      <div className="send-footer">
        <span className="send-hint">Ctrl+Enter to send</span>
        <button
          type="button"
          className="send-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleSend();
          }}
          disabled={!text.trim() || sending}
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
