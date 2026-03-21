import type { MachineInfo, SessionInfo, SessionStatus, WebSocketMessage } from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { createBrowserLogger } from "../logger";
import { loadNotificationSettings } from "../notification-settings";
import { getNotificationBody, playNotificationSound } from "../notification-sound";

const logger = createBrowserLogger("WebSocket");

interface UseWebSocketResult {
  machines: MachineInfo[];
  connected: boolean;
}

const NOTIFICATION_TITLES: Partial<Record<SessionStatus, string>> = {
  awaiting_input: "Agent awaiting input",
  action_required: "Action required",
  done: "Session finished",
  error: "Session error",
  exited: "Session exited",
};

function requestNotificationPermission(): void {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendNotification(title: string, body: string): void {
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

export function useWebSocket(): UseWebSocketResult {
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

    // Load notification settings from localStorage (fast, synchronous)
    const notifSettings = loadNotificationSettings();

    // Detect sessions whose status just changed to a notifiable status
    if (notifSettings.enableNotifications) {
      const notifiableSessions: SessionInfo[] = [];

      for (const session of newSessions) {
        const prevStatus = prevStatuses.get(session.sessionId);
        if (prevStatus !== session.status && notifSettings.notifyOnStatuses.includes(session.status)) {
          notifiableSessions.push(session);
        }
      }

      // Send browser notifications grouped by status
      if (notifiableSessions.length > 0) {
        // Group by status for consolidated notifications
        const byStatus = new Map<SessionStatus, SessionInfo[]>();
        for (const session of notifiableSessions) {
          const group = byStatus.get(session.status) ?? [];
          group.push(session);
          byStatus.set(session.status, group);
        }

        for (const [status, sessions] of byStatus) {
          const names = sessions.map((s) => s.customName || s.projectName).join(", ");
          const title = NOTIFICATION_TITLES[status] ?? "Agent Town";
          const body = getNotificationBody(status, names);
          sendNotification(title, body);
        }

        // Play sound for the first notifiable status (avoid multiple overlapping sounds)
        if (notifSettings.enableSoundAlerts) {
          playNotificationSound(notifiableSessions[0].status);
        }
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
