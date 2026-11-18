/**
 * Run a command inside a pseudo-terminal using Bun's built-in PTY support.
 * Replaces the former Python helper, so the agent needs nothing but Bun.
 */
export interface PtyProcess {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly exited: Promise<number>;
}

export interface PtyOptions {
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  onData?: (data: Uint8Array) => void;
}

export function spawnPty(command: string[], options: PtyOptions): PtyProcess {
  const proc = Bun.spawn(command, {
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        options.onData?.(data);
      },
    },
  });
  const terminal = proc.terminal;
  if (!terminal) throw new Error(`failed to open a terminal for ${command[0]}`);

  // Release the terminal once the command ends so it doesn't keep the event loop alive.
  const exited = proc.exited.finally(() => {
    if (!terminal.closed) terminal.close();
  });

  return {
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    kill: () => {
      proc.kill();
      if (!terminal.closed) terminal.close();
    },
    exited,
  };
}
