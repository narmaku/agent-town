import { useState, useRef, useEffect } from "react";

interface Props {
  machineId: string;
  multiplexer: string;
  session: string;
  onSent?: () => void;
}

export function SendMessage({ machineId, multiplexer, session, onSent }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [text]);

  async function handleSend() {
    if (!text.trim() || sending) return;
    setSending(true);

    try {
      const resp = await fetch("/api/sessions/send", {
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
      }
    } catch {
      // silently fail
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
    <div className="send-message" onClick={(e) => e.stopPropagation()}>
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
      <div className="send-footer">
        <span className="send-hint">Ctrl+Enter to send</span>
        <button
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
