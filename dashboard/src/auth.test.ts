import { describe, expect, test } from "bun:test";

import { buildRequestInit, readTokenFromFragment, withTokenParam } from "./auth";

describe("readTokenFromFragment", () => {
  test("reads the token from a login link fragment", () => {
    expect(readTokenFromFragment("#token=abc123")).toBe("abc123");
  });

  test("decodes URL-encoded tokens and tolerates other fragment params", () => {
    expect(readTokenFromFragment("#view=board&token=a%2Bb")).toBe("a+b");
  });

  test("returns null when the fragment has no token", () => {
    expect(readTokenFromFragment("")).toBeNull();
    expect(readTokenFromFragment("#view=board")).toBeNull();
    expect(readTokenFromFragment("#token=")).toBeNull();
  });
});

describe("buildRequestInit", () => {
  test("adds the bearer token", () => {
    const headers = new Headers(buildRequestInit({}, "tok").headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  test("sends no Authorization header without a token", () => {
    const headers = new Headers(buildRequestInit({}, null).headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  test("marks body-less POSTs as JSON so the server's content-type guard accepts them", () => {
    const headers = new Headers(buildRequestInit({ method: "POST" }, "tok").headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("keeps an explicit content type", () => {
    const init = buildRequestInit(
      { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8" } },
      "t",
    );
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  test("lets the browser set the multipart boundary for FormData uploads", () => {
    const init = buildRequestInit({ method: "POST", body: new FormData() }, "tok");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  test("leaves GET requests without a content type", () => {
    expect(new Headers(buildRequestInit({}, "tok").headers).has("Content-Type")).toBe(false);
  });
});

describe("withTokenParam", () => {
  test("appends the token to a WebSocket URL", () => {
    expect(withTokenParam("ws://h/ws", "a b")).toBe("ws://h/ws?token=a%20b");
  });

  test("extends an existing query string", () => {
    expect(withTokenParam("ws://h/ws/terminal?session=s", "t")).toBe("ws://h/ws/terminal?session=s&token=t");
  });

  test("leaves the URL alone without a token", () => {
    expect(withTokenParam("ws://h/ws", null)).toBe("ws://h/ws");
  });
});
