import { useCallback, useSyncExternalStore } from "react";
import { type SessionDraft, type SessionView, sessionViewStore } from "../session-view-state";

export function usePreferredSessionView(): SessionView {
  return useSyncExternalStore(
    sessionViewStore.subscribe,
    sessionViewStore.getPreferredView,
    sessionViewStore.getPreferredView,
  );
}

export function useSessionDraft(key: string): SessionDraft {
  const snapshot = useCallback(() => sessionViewStore.getDraft(key), [key]);
  return useSyncExternalStore(sessionViewStore.subscribe, snapshot, snapshot);
}
