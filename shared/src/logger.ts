type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL: Record<Level, string> = { debug: "DBG", info: "INF", warn: "WRN", error: "ERR" };

function stamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function minLevel(): number {
  return LEVEL_VALUE[process.env.LOG_LEVEL as Level] ?? LEVEL_VALUE.info;
}

export interface Logger {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(module: string): Logger {
  function emit(level: Level, msg: string): void {
    if (LEVEL_VALUE[level] < minLevel()) return;
    const line = `${stamp()} ${LEVEL_LABEL[level]} [${module}] ${msg}`;
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg) => emit("debug", msg),
    info: (msg) => emit("info", msg),
    warn: (msg) => emit("warn", msg),
    error: (msg) => emit("error", msg),
  };
}
