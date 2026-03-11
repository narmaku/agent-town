import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalMultiplexer } from "@agent-town/shared";

interface Props {
  machineId: string;
  sessionName: string;
  multiplexer: TerminalMultiplexer;
  onClose: () => void;
}

export function TerminalOverlay({
  machineId,
  sessionName,
  multiplexer,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const handleClose = useCallback(() => {
    wsRef.current?.close();
    terminalRef.current?.dispose();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#3b82f680",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    terminalRef.current = term;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      machineId,
      session: sessionName,
      multiplexer,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?${params}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      term.focus();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      term.write("\r\n\x1b[90m--- Connection closed ---\x1b[0m\r\n");
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m--- Connection error ---\x1b[0m\r\n");
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          })
        );
      }
    });
    resizeObserver.observe(containerRef.current);

    let lastEscTime = 0;
    const keyHandler = term.onKey(({ domEvent }) => {
      if (domEvent.key === "Escape") {
        const now = Date.now();
        if (now - lastEscTime < 500) {
          handleClose();
        }
        lastEscTime = now;
      }
    });

    return () => {
      keyHandler.dispose();
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [machineId, sessionName, multiplexer, handleClose]);

  return (
    <div className="terminal-overlay">
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="terminal-session-name">{sessionName}</span>
          <span className="terminal-multiplexer">{multiplexer}</span>
        </div>
        <div className="terminal-controls">
          <span className="terminal-hint">ESC ESC to close</span>
          <button className="terminal-close-btn" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
