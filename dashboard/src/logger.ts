/**
 * Browser-compatible logger with module context.
 *
 * The shared `createLogger` uses `process.env` and is designed for
 * server-side Bun code.  This thin wrapper provides the same API shape
 * but delegates to the browser console methods so dev-tools filtering
 * and log-level controls work as expected.
 */

export interface BrowserLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createBrowserLogger(module: string): BrowserLogger {
  const prefix = `[${module}]`;
  return {
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
