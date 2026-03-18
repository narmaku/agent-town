import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "./logger";

describe("createLogger", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // Reset LOG_LEVEL
    delete process.env.LOG_LEVEL;
  });

  function lastLog(): string {
    return logSpy.mock.calls.at(-1)?.[0] ?? "";
  }

  function lastError(): string {
    return errorSpy.mock.calls.at(-1)?.[0] ?? "";
  }

  test("info writes to stdout with module prefix", () => {
    const log = createLogger("server");
    log.info("started");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lastLog()).toContain("[server]");
    expect(lastLog()).toContain("INF");
    expect(lastLog()).toContain("started");
  });

  test("error writes to stderr", () => {
    const log = createLogger("agent");
    log.error("boom");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(lastError()).toContain("[agent]");
    expect(lastError()).toContain("ERR");
    expect(lastError()).toContain("boom");
  });

  test("warn writes to stderr", () => {
    const log = createLogger("agent");
    log.warn("careful");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(lastError()).toContain("WRN");
  });

  test("debug is suppressed at default level (info)", () => {
    const log = createLogger("agent");
    log.debug("verbose");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("debug is shown when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("agent");
    log.debug("verbose");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(lastLog()).toContain("DBG");
  });

  test("LOG_LEVEL=warn suppresses info", () => {
    process.env.LOG_LEVEL = "warn";
    const log = createLogger("server");
    log.info("hidden");
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("LOG_LEVEL=error suppresses warn", () => {
    process.env.LOG_LEVEL = "error";
    const log = createLogger("server");
    log.warn("hidden");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("output includes HH:MM:SS timestamp", () => {
    const log = createLogger("test");
    log.info("ts");
    expect(lastLog()).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
