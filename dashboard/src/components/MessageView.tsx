import type React from "react";
import { useState } from "react";

import { Markdown } from "./Markdown";

interface Props {
  lastMessage: string;
  fullMessage?: string;
}

export function MessageView({ lastMessage, fullMessage }: Props): React.JSX.Element | null {
  const [showFull, setShowFull] = useState(false);
  const hasFullMessage = fullMessage && fullMessage.length > 0;
  const displayText = showFull && hasFullMessage ? fullMessage : lastMessage;

  if (!lastMessage && !fullMessage) return null;

  return (
    <div className="message-view">
      {showFull && hasFullMessage ? (
        <div className="message-full">
          <Markdown text={displayText ?? ""} />
        </div>
      ) : (
        <div className="message-summary">{lastMessage}</div>
      )}

      {hasFullMessage && (
        <button
          type="button"
          className="message-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setShowFull((prev) => !prev);
          }}
        >
          {showFull ? "Collapse" : "Show full message"}
        </button>
      )}
    </div>
  );
}
