import { describe, expect, test } from "bun:test";
import { detectMultiplexers } from "./multiplexer";

describe("multiplexer", () => {
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
