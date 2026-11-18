import { describe, expect, test } from "bun:test";

import { isLoopbackHost } from "./network";

describe("isLoopbackHost", () => {
  test("recognizes loopback names and addresses", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.0.1.1", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("treats LAN and public addresses as non-loopback", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "town.example", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
