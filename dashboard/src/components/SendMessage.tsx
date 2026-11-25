import type { AgentType } from "@agent-town/shared";
import type React from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { apiFetch } from "../auth";
import { useSessionDraft } from "../hooks/useSessionViewState";
import { makeDraftKey, sessionViewStore } from "../session-view-state";
import { API } from "../utils";

export interface SendMessageHandle {
  focus: () => void;
}

interface Props {
  machineId: string;
  sessionId: string;
  multiplexer: string;
  session: string;
  agentType?: AgentType;
  onSent?: () => void;
}

export const SendMessage = forwardRef<SendMessageHandle, Props>(function SendMessage(
  { machineId, sessionId, multiplexer, session, agentType, onSent },
  ref,
): React.JSX.Element {
  const draftKey = makeDraftKey(machineId, agentType ?? "claude-code", sessionId);
  const { text, sending, error } = useSessionDraft(draftKey);
  const currentDraftKeyRef = useRef<string | null>(draftKey);
  currentDraftKeyRef.current = draftKey;
  useEffect(() => {
    currentDraftKeyRef.current = draftKey;
    return () => {
      currentDraftKeyRef.current = null;
    };
  }, [draftKey]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea when content changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is an intentional trigger for resize
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  async function handleSend() {
    const submission = sessionViewStore.beginSend(draftKey);
    if (!submission) return;

    try {
      const resp = await apiFetch(API.SESSIONS_SEND, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machineId,
          multiplexer,
          session,
          text: submission.text,
          agentType,
        }),
      });

      if (resp.ok) {
        sessionViewStore.finishSend(submission);
        if (currentDraftKeyRef.current === draftKey) onSent?.();
      } else {
        const data = await resp.json().catch(() => ({ error: "Send failed" }));
        sessionViewStore.finishSend(submission, data.error || `Send failed (${resp.status})`);
      }
    } catch (_err) {
      sessionViewStore.finishSend(submission, "Failed to connect to server");
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
        onChange={(e) => sessionViewStore.setDraftText(draftKey, e.target.value)}
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
});
