import type { MachineInfo, SessionInfo } from "@agent-town/shared";

export interface ExplorerSelection {
  machineId: string;
  sessionId: string;
  /** A successful launch can precede its first websocket update. */
  awaitingSession?: boolean;
}

interface ResolvedSelection {
  selection: ExplorerSelection | null;
  machine: MachineInfo | null;
  session: SessionInfo | null;
}

/** Resolve against live, unfiltered machines so sidebar filters never close the pane. */
export function resolveExplorerSelection(
  machines: MachineInfo[],
  selection: ExplorerSelection | null,
): ResolvedSelection {
  const empty = { selection: null, machine: null, session: null };
  if (!selection) return empty;
  const machine = machines.find((item) => item.machineId === selection.machineId);
  if (!machine) return empty;
  const pendingName = selection.sessionId.startsWith("pending-") ? selection.sessionId.slice("pending-".length) : null;
  const session =
    machine.sessions.find((item) => item.sessionId === selection.sessionId) ??
    (pendingName ? machine.sessions.find((item) => item.multiplexerSession === pendingName) : undefined);
  if (!session) return selection.awaitingSession ? { selection, machine, session: null } : empty;
  const next =
    session.sessionId !== selection.sessionId || selection.awaitingSession
      ? { ...selection, sessionId: session.sessionId, awaitingSession: false }
      : selection;
  return { selection: next, machine, session };
}
