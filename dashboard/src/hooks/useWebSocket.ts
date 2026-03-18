import type { MachineInfo, SessionInfo, WebSocketMessage } from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { createBrowserLogger } from "../logger";

const logger = createBrowserLogger("WebSocket");

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

export function useWebSocket(): { machines: MachineInfo[]; connected: boolean } {
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const prevSessionStatusRef = useRef<Map<string, string>>(new Map());

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

    // Update the status map
    const newMap = new Map<string, string>();
    for (const session of newSessions) {
      newMap.set(session.sessionId, session.status);
    }
    prevSessionStatusRef.current = newMap;

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

  return { machines, connected };
}
