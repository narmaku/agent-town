import type { AgentType, MachineInfo } from "@agent-town/shared";
import { createBrowserLogger } from "./logger";

export type SessionView = "chat" | "terminal";
interface StorageAccess {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface StoreOptions {
  localStorage?: () => StorageAccess | undefined;
  sessionStorage?: () => StorageAccess | undefined;
}
export interface SessionDraft {
  text: string;
  revision: number;
  sending: boolean;
  error: string;
}
export interface DraftSubmission {
  key: string;
  text: string;
  revision: number;
  token: number;
}
export interface SessionViewStore {
  subscribe(listener: () => void): () => void;
  getPreferredView(): SessionView;
  setPreferredView(view: SessionView): void;
  getDraft(key: string): SessionDraft;
  setDraftText(key: string, text: string): void;
  appendDraftText(key: string, text: string): void;
  captureDraftAppend(key: string): (text: string) => void;
  beginSend(key: string): DraftSubmission | null;
  finishSend(submission: DraftSubmission, error?: string): void;
  transferDraft(from: string, to: string): void;
  reconcileSessions(machines: readonly MachineInfo[]): void;
}
const VIEW_KEY = "agentTown:preferredSessionView";
const DRAFT_PREFIX = "agentTown:sessionDraft:";
const logger = createBrowserLogger("session-view-state");

export function makeDraftKey(machineId: string, agentType: AgentType, sessionId: string): string {
  return JSON.stringify([machineId, agentType, sessionId]);
}

/** Small shared UI state; only draft text and the chosen view reach browser storage. */
export function createSessionViewStore(options: StoreOptions = {}): SessionViewStore {
  const drafts = new Map<string, SessionDraft>();
  const uploadTargets = new Map<string, { key: string }>();
  const submissionKeys = new Map<number, string>();
  const submissions = new Map<string, Set<number>>();
  const listeners = new Set<() => void>();
  let nextToken = 0;
  let preferredView: SessionView = "chat";
  try {
    if (options.localStorage?.()?.getItem(VIEW_KEY) === "terminal") preferredView = "terminal";
  } catch (error) {
    logger.warn("Could not restore preferred view", error);
  }
  const notify = () => {
    for (const listener of listeners) listener();
  };
  function getDraft(key: string): SessionDraft {
    let draft = drafts.get(key);
    if (!draft) {
      let text = "";
      try {
        text = options.sessionStorage?.()?.getItem(DRAFT_PREFIX + key) ?? "";
      } catch (error) {
        logger.warn("Could not restore draft", error);
      }
      draft = { text, revision: 0, sending: false, error: "" };
      drafts.set(key, draft);
    }
    return draft;
  }
  function persist(key: string, text: string): void {
    try {
      const storage = options.sessionStorage?.();
      if (text) storage?.setItem(DRAFT_PREFIX + key, text);
      else storage?.removeItem(DRAFT_PREFIX + key);
    } catch (error) {
      logger.warn("Could not persist draft; retaining it in memory", error);
    }
  }
  function setDraftText(key: string, text: string): void {
    const draft = getDraft(key);
    if (draft.text === text) return;
    drafts.set(key, { ...draft, text, revision: draft.revision + 1, error: "" });
    persist(key, text);
    notify();
  }
  const store: SessionViewStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPreferredView: () => preferredView,
    setPreferredView(view) {
      if (preferredView === view) return;
      preferredView = view;
      try {
        options.localStorage?.()?.setItem(VIEW_KEY, view);
      } catch (error) {
        logger.warn("Could not persist preferred view", error);
      }
      notify();
    },
    getDraft,
    setDraftText,
    appendDraftText(key, text) {
      const draft = getDraft(key);
      setDraftText(key, draft.text + (draft.text && !draft.text.endsWith("\n") ? "\n" : "") + text);
    },
    captureDraftAppend(key) {
      let target = uploadTargets.get(key);
      if (!target) {
        target = { key };
        uploadTargets.set(key, target);
      }
      const captured = target;
      return (text) => store.appendDraftText(captured.key, text);
    },
    beginSend(key) {
      const draft = getDraft(key);
      if (!draft.text.trim() || draft.sending) return null;
      const submission = { key, text: draft.text.trim(), revision: draft.revision, token: ++nextToken };
      submissions.set(key, new Set([submission.token]));
      submissionKeys.set(submission.token, key);
      drafts.set(key, { ...draft, sending: true, error: "" });
      notify();
      return submission;
    },
    finishSend(submission, error = "") {
      const key = submissionKeys.get(submission.token);
      if (!key) return;
      submissionKeys.delete(submission.token);
      const pending = submissions.get(key);
      if (!pending?.delete(submission.token)) return;
      const draft = getDraft(key);
      const clear = !error && draft.revision === submission.revision;
      const next = {
        ...draft,
        sending: pending.size > 0,
        error,
        ...(clear ? { text: "", revision: draft.revision + 1 } : {}),
      };
      drafts.set(key, next);
      if (clear) persist(key, "");
      notify();
    },
    reconcileSessions(machines) {
      for (const key of drafts.keys()) {
        const [machineId, agentType, sessionId] = JSON.parse(key) as [string, AgentType, string];
        if (!sessionId.startsWith("pending-")) continue;
        const name = sessionId.slice("pending-".length);
        const real = machines
          .find((machine) => machine.machineId === machineId)
          ?.sessions.find(
            (session) =>
              !session.sessionId.startsWith("pending-") &&
              session.agentType === agentType &&
              session.multiplexerSession === name,
          );
        if (real) store.transferDraft(key, makeDraftKey(machineId, agentType, real.sessionId));
      }
    },
    transferDraft(from, to) {
      if (from === to) return;
      const source = getDraft(from);
      const target = getDraft(to);
      const text = target.text && source.text ? `${target.text}\n${source.text}` : target.text || source.text;
      const pending = new Set([...(submissions.get(from) ?? []), ...(submissions.get(to) ?? [])]);
      submissions.set(to, pending);
      submissions.delete(from);
      drafts.set(to, {
        text,
        revision: target.text ? Math.max(target.revision, source.revision) + 1 : source.revision,
        sending: pending.size > 0,
        error: target.error || source.error,
      });
      const uploadTarget = uploadTargets.get(from);
      if (uploadTarget) uploadTarget.key = to;
      uploadTargets.delete(from);
      for (const token of pending) submissionKeys.set(token, to);
      drafts.delete(from);
      persist(from, "");
      persist(to, text);
      notify();
    },
  };
  return store;
}

export const sessionViewStore = createSessionViewStore({
  localStorage: () => (typeof window === "undefined" ? undefined : window.localStorage),
  sessionStorage: () => (typeof window === "undefined" ? undefined : window.sessionStorage),
});
