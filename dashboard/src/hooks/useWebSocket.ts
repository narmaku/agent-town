import type { AgentType, MachineInfo, SessionInfo, SessionStatus, WebSocketMessage } from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { createBrowserLogger } from "../logger";

const logger = createBrowserLogger("WebSocket");

const MAX_ACTIVITY_EVENTS = 200;

export interface ActivityEvent {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionName: string;
  machineId: string;
  hostname: string;
  agentType: AgentType;
  fromStatus?: SessionStatus;
  toStatus: SessionStatus;
}

interface UseWebSocketResult {
  machines: MachineInfo[];
  connected: boolean;
  activityFeed: ActivityEvent[];
  unreadActivityCount: number;
  markActivityRead: () => void;
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendNotification(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag: "agent-town-attention",
      renotify: true,
    });
  }
}

function getAllSessions(machines: MachineInfo[]): SessionInfo[] {
  return machines.flatMap((m) => m.sessions);
}

/** Build ActivityEvent objects for sessions whose status changed. Pure function for testability. */
export function buildActivityEvents(
  newMachines: MachineInfo[],
  prevStatuses: Map<string, SessionStatus>,
  now: number,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const machine of newMachines) {
    for (const session of machine.sessions) {
      const prevStatus = prevStatuses.get(session.sessionId);
      if (prevStatus !== undefined && prevStatus !== session.status) {
        events.push({
          id: `${session.sessionId}-${now}-${events.length}`,
          timestamp: new Date(now).toISOString(),
          sessionId: session.sessionId,
          sessionName: session.customName || session.slug,
          machineId: machine.machineId,
          hostname: machine.hostname,
          agentType: session.agentType,
          fromStatus: prevStatus,
          toStatus: session.status,
        });
      }
    }
  }
  return events;
}

/** Append new events to existing feed, newest first, capped at MAX_ACTIVITY_EVENTS. */
export function appendActivityEvents(
  existingFeed: ActivityEvent[],
  newEvents: ActivityEvent[],
  maxEvents: number = MAX_ACTIVITY_EVENTS,
): ActivityEvent[] {
  return [...[...newEvents].reverse(), ...existingFeed].slice(0, maxEvents);
}

export function useWebSocket(): UseWebSocketResult {
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [activityFeed, setActivityFeed] = useState<ActivityEvent[]>([]);
  const [unreadActivityCount, setUnreadActivityCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const prevSessionStatusRef = useRef<Map<string, SessionStatus>>(new Map());
  const isInitialLoadRef = useRef(true);

  // Request notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  const handleUpdate = useCallback((newMachines: MachineInfo[]) => {
    const prevStatuses = prevSessionStatusRef.current;
    const newSessions = getAllSessions(newMachines);

    // Check for sessions that just changed to awaiting_input or action_required
    const newAttentionSessions: SessionInfo[] = [];

    for (const session of newSessions) {
      const prevStatus = prevStatuses.get(session.sessionId);
      if (
        (session.status === "awaiting_input" || session.status === "action_required") &&
        prevStatus !== session.status
      ) {
        newAttentionSessions.push(session);
      }
    }

    // Build activity events for status transitions (skip initial load)
    const newActivityEvents = isInitialLoadRef.current
      ? []
      : buildActivityEvents(newMachines, prevStatuses, Date.now());

    // Send browser notification
    if (newAttentionSessions.length > 0) {
      const actionSessions = newAttentionSessions.filter((s) => s.status === "action_required");
      const awaitingSessions = newAttentionSessions.filter((s) => s.status === "awaiting_input");

      if (actionSessions.length > 0) {
        const names = actionSessions.map((s) => s.customName || s.projectName).join(", ");
        sendNotification("Action required", `${names} — agent is asking a question`);
      }
      if (awaitingSessions.length > 0) {
        const names = awaitingSessions.map((s) => s.customName || s.projectName).join(", ");
        sendNotification("Agent awaiting input", `${names} — waiting for your input`);
      }
    }

    // Append activity events (newest first, capped)
    if (newActivityEvents.length > 0) {
      setActivityFeed((prev) => appendActivityEvents(prev, newActivityEvents));
      setUnreadActivityCount((prev) => prev + newActivityEvents.length);
    }

    // Update the status map
    const newMap = new Map<string, SessionStatus>();
    for (const session of newSessions) {
      newMap.set(session.sessionId, session.status);
    }
    prevSessionStatusRef.current = newMap;

    // Mark initial load as complete after first update
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
    }

    setMachines(newMachines);
  }, []);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        if (message.type === "machines_update") {
          handleUpdate(message.payload as MachineInfo[]);
        }
      } catch (err) {
        logger.warn("Failed to parse message", err);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [handleUpdate]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const markActivityRead = useCallback(() => {
    setUnreadActivityCount(0);
  }, []);

  return { machines, connected, activityFeed, unreadActivityCount, markActivityRead };
}
