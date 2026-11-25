import { describe, expect, test } from "bun:test";
import { createSessionViewStore, makeDraftKey } from "./session-view-state";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const a = makeDraftKey("machine-a", "codex", "session");
const b = makeDraftKey("machine-b", "codex", "session");

describe("session view continuity", () => {
  test("shares and restores the preferred view, ignoring malformed preferences", () => {
    const local = memoryStorage();
    const store = createSessionViewStore({ localStorage: () => local });
    expect(store.getPreferredView()).toBe("chat");
    store.setPreferredView("terminal");
    expect(createSessionViewStore({ localStorage: () => local }).getPreferredView()).toBe("terminal");
    local.setItem("agentTown:preferredSessionView", "invalid");
    expect(createSessionViewStore({ localStorage: () => local }).getPreferredView()).toBe("chat");
  });

  test("isolates machine, harness and session drafts with unambiguous identities", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "draft A");
    expect(store.getDraft(b).text).toBe("");
    expect(store.getDraft(makeDraftKey("machine-a", "claude-code", "session")).text).toBe("");
    expect(makeDraftKey("a:b", "codex", "c")).not.toBe(makeDraftKey("a", "codex", "b:c"));
  });

  test("restores text across store reload without restoring pending send state", () => {
    const storage = memoryStorage();
    const store = createSessionViewStore({ sessionStorage: () => storage });
    store.setDraftText(a, "draft survives reload");
    store.beginSend(a);
    const restored = createSessionViewStore({ sessionStorage: () => storage });
    expect(restored.getDraft(a)).toMatchObject({ text: "draft survives reload", sending: false, error: "" });
  });

  test("keeps stable snapshots and in-flight protection through resubscription", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "send this");
    const unsubscribe = store.subscribe(() => {});
    const submission = store.beginSend(a);
    if (!submission) throw new Error("Expected a send submission");
    unsubscribe();
    const nextUnsubscribe = store.subscribe(() => {});
    expect(store.getDraft(a)).toBe(store.getDraft(a));
    expect(store.getDraft(a).sending).toBe(true);
    expect(store.beginSend(a)).toBeNull();
    store.finishSend(submission);
    expect(store.getDraft(a)).toMatchObject({ text: "", sending: false });
    nextUnsubscribe();
  });

  test("successful send clears only its original unchanged draft", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "A");
    store.setDraftText(b, "B");
    const submission = store.beginSend(a);
    if (!submission) throw new Error("Expected a send submission");
    store.finishSend(submission);
    expect(store.getDraft(a).text).toBe("");
    expect(store.getDraft(b).text).toBe("B");
  });

  test("new edits survive completion even if text returns to its original value", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "original");
    const submission = store.beginSend(a);
    if (!submission) throw new Error("Expected a send submission");
    store.setDraftText(a, "changed");
    store.setDraftText(a, "original");
    store.finishSend(submission);
    expect(store.getDraft(a).text).toBe("original");
  });

  test("failed sends retain the correct draft and error", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "A");
    const submission = store.beginSend(a);
    if (!submission) throw new Error("Expected a send submission");
    store.finishSend(submission, "offline");
    expect(store.getDraft(a)).toMatchObject({ text: "A", error: "offline", sending: false });
    expect(store.getDraft(b).error).toBe("");
  });

  test("file references append to retained draft while its composer is absent", () => {
    const store = createSessionViewStore();
    store.setDraftText(a, "Please inspect");
    store.appendDraftText(a, "@/uploads/file.txt");
    expect(store.getDraft(a).text).toBe("Please inspect\n@/uploads/file.txt");
  });

  test("pending promotion retains text and both existing drafts without overwriting", () => {
    const store = createSessionViewStore();
    const pending = makeDraftKey("machine-a", "codex", "pending-new");
    store.setDraftText(pending, "typed before heartbeat");
    const appendLateUpload = store.captureDraftAppend(pending);
    store.transferDraft(pending, a);
    expect(store.getDraft(a).text).toBe("typed before heartbeat");
    appendLateUpload("upload finished late");
    expect(store.getDraft(a).text).toContain("upload finished late");
    const second = makeDraftKey("machine-a", "codex", "pending-second");
    store.setDraftText(second, "another draft");
    store.transferDraft(second, a);
    expect(store.getDraft(a).text).toBe("typed before heartbeat\nupload finished late\nanother draft");
  });

  test("a send started before pending promotion finishes safely on the real draft", () => {
    const store = createSessionViewStore();
    const pending = makeDraftKey("machine-a", "codex", "pending-new");
    store.setDraftText(pending, "sending");
    const submission = store.beginSend(pending);
    if (!submission) throw new Error("Expected a send submission");
    store.transferDraft(pending, a);
    expect(store.getDraft(a).sending).toBe(true);
    store.finishSend(submission);
    expect(store.getDraft(a)).toMatchObject({ text: "", sending: false });
  });

  test("reusing a pending mux name cannot redirect its new draft or an old upload", () => {
    const store = createSessionViewStore();
    const pending = makeDraftKey("machine-a", "codex", "pending-new");
    store.setDraftText(pending, "first launch");
    const appendOldUpload = store.captureDraftAppend(pending);
    store.transferDraft(pending, a);
    store.setDraftText(pending, "second launch");
    appendOldUpload("late first upload");
    expect(store.getDraft(pending).text).toBe("second launch");
    expect(store.getDraft(a).text).toBe("first launch\nlate first upload");
  });

  test("storage failures keep drafts and view functional in memory", () => {
    const blocked = () => {
      throw new Error("storage blocked");
    };
    const store = createSessionViewStore({ localStorage: blocked, sessionStorage: blocked });
    store.setPreferredView("terminal");
    store.setDraftText(a, "keep me");
    expect(store.getPreferredView()).toBe("terminal");
    expect(store.getDraft(a).text).toBe("keep me");
  });
});
