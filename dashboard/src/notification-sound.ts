import type { SessionStatus } from "@agent-town/shared";

/** Oscillator frequencies by status category (Hz). */
export const NOTIFICATION_FREQUENCIES = {
  default: 660,
  error: 880,
  done: 440,
  exited: 520,
} as const;

function getFrequency(status: SessionStatus): number {
  if (status === "error") return NOTIFICATION_FREQUENCIES.error;
  if (status === "done") return NOTIFICATION_FREQUENCIES.done;
  if (status === "exited") return NOTIFICATION_FREQUENCIES.exited;
  return NOTIFICATION_FREQUENCIES.default;
}

/**
 * Play a short, gentle notification tone via Web Audio API.
 * No external audio files are required.
 * Silently does nothing if AudioContext is unavailable.
 */
export function playNotificationSound(status: SessionStatus): void {
  try {
    const AudioCtx =
      (globalThis as Record<string, unknown>).AudioContext ??
      (globalThis as Record<string, unknown>).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new (AudioCtx as { new (): AudioContext })();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.value = getFrequency(status);
    gain.gain.value = 0.15;

    // Close the AudioContext after the tone finishes to free system resources
    osc.onended = () => ctx.close();

    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.stop(ctx.currentTime + 0.3);
  } catch (_err) {
    // AudioContext may be blocked or unavailable
  }
}

/** Build a human-readable notification body for a given status change. */
export function getNotificationBody(status: SessionStatus, sessionName: string): string {
  switch (status) {
    case "awaiting_input":
      return `${sessionName} — waiting for your input`;
    case "action_required":
      return `${sessionName} — agent is asking a question`;
    case "done":
      return `${sessionName} — session finished`;
    case "error":
      return `${sessionName} — session encountered an error`;
    case "exited":
      return `${sessionName} — session exited`;
    default:
      return `${sessionName} — status changed to ${status}`;
  }
}
