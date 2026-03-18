import type React from "react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
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
            }}
          >
            {displayText}
          </Markdown>
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
