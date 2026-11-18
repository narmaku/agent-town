import { describe, expect, test } from "bun:test";

import { buildHookCommand } from "./hook-command";

describe("buildHookCommand", () => {
  test("posts to the agent on loopback with a JSON content type", () => {
    const command = buildHookCommand(4681);
    expect(command).toStartWith("curl -s -X POST http://127.0.0.1:4681/api/hook-event");
    expect(command).toContain("-H 'Content-Type: application/json'");
  });

  test("reads the token from $HOME by default so it works on remote nodes", () => {
    expect(buildHookCommand(4681)).toContain(`-H "Authorization: Bearer $(cat "$HOME/.agent-town/token")"`);
  });

  test("authenticates successfully when run by a shell", async () => {
    // Run the real command against a stub that echoes the Authorization header
    const token = "hook-token-0123456789abcdefghijklmn";
    const tokenDir = await Bun.$`mktemp -d`.text();
    const tokenFile = `${tokenDir.trim()}/token`;
    await Bun.write(tokenFile, `${token}\n`);
    let seen: string | null = null;
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen = req.headers.get("authorization");
        return Response.json({ exit: 0 });
      },
    });
    try {
      const command = buildHookCommand(stub.port, `'${tokenFile}'`);
      const proc = Bun.spawn(["sh", "-c", command], { stdin: new TextEncoder().encode("{}"), stdout: "ignore" });
      await proc.exited;
      expect(seen).toBe(`Bearer ${token}`);
    } finally {
      stub.stop(true);
      await Bun.$`rm -rf ${tokenDir.trim()}`;
    }
  });
});
