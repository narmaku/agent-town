import { describe, expect, test } from "bun:test";
import { detectMultiplexers, parseTmuxPanes, parseTmuxSessions } from "./multiplexer";

describe("multiplexer", () => {
  test("lists detached tmux sessions as running regardless of viewer count", () => {
    expect(parseTmuxSessions("detached:0\nattached:1\nmultiple-viewers:2\n")).toEqual([
      { name: "detached", multiplexer: "tmux", attached: true },
      { name: "attached", multiplexer: "tmux", attached: true },
      { name: "multiple-viewers", multiplexer: "tmux", attached: true },
    ]);
  });

  test("parses tmux pane ancestry and paths without splitting spaces or colons", () => {
    expect(parseTmuxPanes("123\t/work/my project:main\tagent-session\t/dev/pts/1\n")).toEqual([
      { pid: 123, cwd: "/work/my project:main", session: "agent-session", tty: "/dev/pts/1" },
    ]);
  });

  test("ignores incomplete or invalid pane metadata", () => {
    expect(parseTmuxPanes("\nnot-a-pid\t/work\tagent\t/dev/pts/1\n0\t/work\tagent\t/dev/pts/2\n123\t/work\n")).toEqual(
      [],
    );
  });

  test("detectMultiplexers returns available multiplexers", async () => {
    const result = await detectMultiplexers();
    expect(Array.isArray(result)).toBe(true);
    // On this machine we know zellij and tmux are both installed
    // But in CI they might not be, so just check the types
    for (const mux of result) {
      expect(["zellij", "tmux"]).toContain(mux);
    }
  });
});
