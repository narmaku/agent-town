import { describe, expect, test } from "bun:test";

import { spawnPty } from "./pty";

describe("spawnPty", () => {
  test("runs a command in a sized terminal, forwards input, and applies resizes", async () => {
    let output = "";
    const pty = spawnPty(["bash", "-c", "stty size; read line; echo got:$line; stty size"], {
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH },
      onData: (data) => {
        output += new TextDecoder().decode(data);
      },
    });

    await Bun.sleep(200);
    pty.resize(120, 40);
    pty.write("hello\r");
    expect(await pty.exited).toBe(0);

    expect(output).toContain("30 100");
    expect(output).toContain("got:hello");
    expect(output).toContain("40 120");
  });

  test("kill stops the command and closes the terminal", async () => {
    const pty = spawnPty(["sleep", "30"], { cols: 80, rows: 24, env: { PATH: process.env.PATH } });
    pty.kill();
    expect(await pty.exited).not.toBe(0);
  });
});
