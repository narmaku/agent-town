import { useEffect, useRef, useState, useCallback } from "react";
import type { MachineInfo, SessionInfo, WebSocketMessage } from "@agent-town/shared";

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

export function useWebSocket() {
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

    // Check for sessions that just changed to "needs_attention"
    const newAttentionSessions: SessionInfo[] = [];
    for (const session of newSessions) {
      const prevStatus = prevStatuses.get(session.sessionId);
      if (
        session.status === "needs_attention" &&
        prevStatus !== "needs_attention"
      ) {
        newAttentionSessions.push(session);
      }
    }

    // Send browser notification if any sessions need attention
    if (newAttentionSessions.length > 0) {
      const names = newAttentionSessions
        .map((s) => s.customName || s.projectName)
        .join(", ");
      sendNotification(
        "Agent needs attention",
        `${names} — waiting for your input`
      );
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
      } catch {
        // ignore malformed messages
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
