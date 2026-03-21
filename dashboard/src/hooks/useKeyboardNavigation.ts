import type { SessionInfo } from "@agent-town/shared";
import { useCallback, useEffect, useRef, useState } from "react";

/** Tags that should suppress keyboard shortcuts (user is typing). */
const INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Check if the active element is an input where shortcuts should be suppressed. */
function isTypingInInput(): boolean {
  const tag = document.activeElement?.tagName;
  if (tag && INPUT_TAGS.has(tag)) return true;
  // Also suppress if contentEditable is active
  if (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable) {
    return true;
  }
  return false;
}

interface UseKeyboardNavigationOptions {
  sessions: SessionInfo[];
  enabled: boolean;
  shortcuts: Record<string, string>;
  onExpand: (sessionId: string) => void;
  onFullscreen: (sessionId: string) => void;
  onOpenTerminal: (sessionId: string) => void;
  onFocusSearch: () => void;
  onFocusSendMessage: (sessionId: string) => void;
  onClose: () => void;
  onShowHelp: () => void;
}

interface UseKeyboardNavigationResult {
  selectedSessionId: string | null;
  clearSelection: () => void;
}

export function useKeyboardNavigation({
  sessions,
  enabled,
  shortcuts,
  onExpand,
  onFullscreen,
  onOpenTerminal,
  onFocusSearch,
  onFocusSendMessage,
  onClose,
  onShowHelp,
}: UseKeyboardNavigationOptions): UseKeyboardNavigationResult {
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // Keep a ref to always have fresh values in the keydown handler
  // without re-registering the listener on every render.
  const stateRef = useRef({
    sessions,
    enabled,
    shortcuts,
    selectedIndex,
    onExpand,
    onFullscreen,
    onOpenTerminal,
    onFocusSearch,
    onFocusSendMessage,
    onClose,
    onShowHelp,
  });

  stateRef.current = {
    sessions,
    enabled,
    shortcuts,
    selectedIndex,
    onExpand,
    onFullscreen,
    onOpenTerminal,
    onFocusSearch,
    onFocusSendMessage,
    onClose,
    onShowHelp,
  };

  // When sessions list changes (e.g., filter or new data), clamp selectedIndex
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (sessions.length === 0) return -1;
      if (prev < 0) return -1; // keep unselected
      if (prev >= sessions.length) return sessions.length - 1;
      return prev;
    });
  }, [sessions]);

  const clearSelection = useCallback(() => {
    setSelectedIndex(-1);
  }, []);

  // Scroll the selected card into view
  useEffect(() => {
    if (selectedIndex < 0 || sessions.length === 0) return;
    const sessionId = sessions[selectedIndex]?.sessionId;
    if (!sessionId) return;

    // Find the card DOM element via data attribute
    const card = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (card) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex, sessions]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const state = stateRef.current;
      if (!state.enabled) return;

      // Always allow the help shortcut, even when nothing is selected
      // But suppress all shortcuts when typing in an input
      if (isTypingInInput()) return;

      const key = e.key;
      const sc = state.shortcuts;

      // Help overlay - always available
      if (key === sc.showHelp) {
        e.preventDefault();
        state.onShowHelp();
        return;
      }

      // Focus search - always available
      if (key === sc.focusSearch) {
        e.preventDefault();
        state.onFocusSearch();
        return;
      }

      // Close/Escape - always available
      if (key === sc.close) {
        e.preventDefault();
        state.onClose();
        setSelectedIndex(-1);
        return;
      }

      // Navigation: j/k
      if (key === sc.navigateDown) {
        e.preventDefault();
        if (state.sessions.length === 0) return;
        setSelectedIndex((prev) => {
          const next = prev + 1;
          return next >= state.sessions.length ? 0 : next;
        });
        return;
      }

      if (key === sc.navigateUp) {
        e.preventDefault();
        if (state.sessions.length === 0) return;
        setSelectedIndex((prev) => {
          if (prev <= 0) return state.sessions.length - 1;
          return prev - 1;
        });
        return;
      }

      // Actions that require a selected session
      const currentSession = state.selectedIndex >= 0 ? state.sessions[state.selectedIndex] : null;
      if (!currentSession) return;

      if (key === sc.expandCollapse) {
        e.preventDefault();
        state.onExpand(currentSession.sessionId);
        return;
      }

      if (key === sc.fullscreen) {
        e.preventDefault();
        state.onFullscreen(currentSession.sessionId);
        return;
      }

      if (key === sc.openTerminal) {
        e.preventDefault();
        state.onOpenTerminal(currentSession.sessionId);
        return;
      }

      if (key === sc.sendMessage) {
        e.preventDefault();
        state.onFocusSendMessage(currentSession.sessionId);
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []); // Empty deps — we use stateRef for fresh values

  const selectedSessionId =
    selectedIndex >= 0 && selectedIndex < sessions.length ? (sessions[selectedIndex]?.sessionId ?? null) : null;

  return { selectedSessionId, clearSelection };
}
