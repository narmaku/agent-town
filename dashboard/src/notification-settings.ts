import type { SessionStatus } from "@agent-town/shared";

export interface NotificationSettings {
  enableNotifications: boolean;
  enableSoundAlerts: boolean;
  notifyOnStatuses: SessionStatus[];
}

export const NOTIFICATION_STORAGE_KEY = "agentTown:notifications" as const;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enableNotifications: true,
  enableSoundAlerts: true,
  notifyOnStatuses: ["awaiting_input", "action_required", "error", "done", "exited"],
};

/** Load notification settings from localStorage, falling back to defaults. */
export function loadNotificationSettings(): NotificationSettings {
  try {
    const stored = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_NOTIFICATION_SETTINGS };

    const parsed = JSON.parse(stored) as Partial<NotificationSettings>;
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...parsed,
    };
  } catch (_err) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

/** Persist notification settings to localStorage. */
export function saveNotificationSettings(settings: NotificationSettings): void {
  localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(settings));
}
