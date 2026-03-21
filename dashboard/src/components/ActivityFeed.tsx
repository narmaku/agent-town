import type { SessionStatus } from "@agent-town/shared";
import type React from "react";
import { useEffect, useRef } from "react";

import type { ActivityEvent } from "../hooks/useWebSocket";
import { STATUS_CONFIG, timeAgo } from "../utils";

interface ActivityFeedProps {
  events: ActivityEvent[];
  isOpen: boolean;
  onClose: () => void;
  onNavigateToSession: (machineId: string, sessionId: string) => void;
}

const STATUS_ICONS: Record<SessionStatus, string> = {
  starting: "+",
  working: "●",
  awaiting_input: "●",
  action_required: "!",
  idle: "○",
  done: "✓",
  error: "✗",
  exited: "○",
};

export function ActivityFeed({
  events,
  isOpen,
  onClose,
  onNavigateToSession,
}: ActivityFeedProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Check if the click was on the activity toggle button itself
        const target = e.target as HTMLElement;
        if (target.closest(".activity-toggle-btn")) return;
        onClose();
      }
    }

    // Defer adding the listener so the opening click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="activity-feed-dropdown" ref={panelRef}>
      <div className="activity-feed-header">
        <span className="activity-feed-title">Activity</span>
        <span className="activity-feed-count">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="activity-feed-list">
        {events.length === 0 ? (
          <div className="activity-feed-empty">No activity yet. Status changes will appear here.</div>
        ) : (
          events.map((event) => {
            const statusStyle = STATUS_CONFIG[event.toStatus];
            const icon = STATUS_ICONS[event.toStatus];
            return (
              <button
                key={event.id}
                type="button"
                className="activity-feed-item"
                onClick={() => {
                  onNavigateToSession(event.machineId, event.sessionId);
                  onClose();
                }}
                aria-label={`${event.sessionName} ${statusStyle.label} on ${event.hostname}`}
              >
                <span className="activity-feed-time">{timeAgo(event.timestamp)}</span>
                <span className="activity-feed-icon" style={{ color: statusStyle.color }}>
                  {icon}
                </span>
                <span className="activity-feed-details">
                  <span className="activity-feed-session-name">{event.sessionName}</span>
                  <span className="activity-feed-status" style={{ color: statusStyle.color }}>
                    {statusStyle.label.toLowerCase()}
                  </span>
                  <span className="activity-feed-meta">
                    on {event.hostname} · {event.agentType}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
