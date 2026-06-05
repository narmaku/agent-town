import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { altCode, arrowCode, ctrlCode, ESCAPE, parseKeyCombo, TAB } from "../utils/key-codes";

const HELPERS_STORAGE_KEY = "agentTown:terminalHelpersExpanded";
const MODIFIER_TIMEOUT_MS = 5000;

type PendingModifier = "ctrl" | "alt" | null;

function loadExpanded(): boolean {
  try {
    const stored = localStorage.getItem(HELPERS_STORAGE_KEY);
    if (stored !== null) return stored === "true";
  } catch (_err) {
    // localStorage unavailable
  }
  return false;
}

interface Props {
  sendData: (data: string) => void;
  isConnected: boolean;
  onFocusTerminal: () => void;
}

export function TerminalHelpers({ sendData, isConnected, onFocusTerminal }: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [pendingModifier, setPendingModifier] = useState<PendingModifier>(null);
  const [showSendKeys, setShowSendKeys] = useState(false);
  const [sendKeysValue, setSendKeysValue] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendKeysInputRef = useRef<HTMLInputElement>(null);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HELPERS_STORAGE_KEY, String(next));
      } catch (_err) {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  const clearModifier = useCallback(() => {
    setPendingModifier(null);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const activateModifier = useCallback(
    (mod: "ctrl" | "alt") => {
      clearModifier();
      setPendingModifier(mod);
      timeoutRef.current = setTimeout(() => {
        setPendingModifier(null);
        timeoutRef.current = null;
      }, MODIFIER_TIMEOUT_MS);
    },
    [clearModifier],
  );

  // Listen for next keypress when a modifier is pending
  useEffect(() => {
    if (!pendingModifier) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;

      e.preventDefault();
      e.stopPropagation();

      let code: string;
      if (pendingModifier === "ctrl") {
        code = ctrlCode(e.key);
      } else {
        code = altCode(e.key);
      }

      if (code) {
        sendData(code);
      }

      setPendingModifier(null);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      onFocusTerminal();
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [pendingModifier, sendData, onFocusTerminal]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  function handleDirectSend(data: string) {
    sendData(data);
    onFocusTerminal();
  }

  function handleSendKeysSubmit() {
    const combo = sendKeysValue.trim();
    if (!combo) return;

    const code = parseKeyCombo(combo);
    if (code) {
      sendData(code);
    }

    setSendKeysValue("");
    setShowSendKeys(false);
    onFocusTerminal();
  }

  function handleSendKeysKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      handleSendKeysSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setShowSendKeys(false);
      setSendKeysValue("");
      onFocusTerminal();
    }
  }

  // Focus the send-keys input when it opens
  useEffect(() => {
    if (showSendKeys) {
      sendKeysInputRef.current?.focus();
    }
  }, [showSendKeys]);

  return (
    <div className="terminal-helpers">
      <button
        type="button"
        className={`terminal-helpers-toggle${expanded ? " active" : ""}`}
        onClick={toggleExpanded}
        aria-label={expanded ? "Collapse terminal helpers" : "Expand terminal helpers"}
        title="Terminal helpers"
      >
        Helpers
      </button>

      {expanded && (
        <div className="terminal-helpers-panel">
          {/* Modifier keys */}
          <button
            type="button"
            className={`terminal-helper-btn modifier-btn${pendingModifier === "ctrl" ? " active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => activateModifier("ctrl")}
            disabled={!isConnected}
            aria-label="Ctrl modifier — press then type a key"
            title="Ctrl — click then press a key"
          >
            Ctrl
          </button>
          <button
            type="button"
            className={`terminal-helper-btn modifier-btn${pendingModifier === "alt" ? " active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => activateModifier("alt")}
            disabled={!isConnected}
            aria-label="Alt modifier — press then type a key"
            title="Alt — click then press a key"
          >
            Alt
          </button>

          <span className="terminal-helpers-separator" />

          {/* Arrow keys */}
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(arrowCode("up"))}
            disabled={!isConnected}
            aria-label="Send arrow up"
            title="Arrow Up"
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(arrowCode("down"))}
            disabled={!isConnected}
            aria-label="Send arrow down"
            title="Arrow Down"
          >
            ↓
          </button>
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(arrowCode("left"))}
            disabled={!isConnected}
            aria-label="Send arrow left"
            title="Arrow Left"
          >
            ←
          </button>
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(arrowCode("right"))}
            disabled={!isConnected}
            aria-label="Send arrow right"
            title="Arrow Right"
          >
            →
          </button>

          <span className="terminal-helpers-separator" />

          {/* Special keys */}
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(TAB)}
            disabled={!isConnected}
            aria-label="Send Tab key"
            title="Tab"
          >
            Tab
          </button>
          <button
            type="button"
            className="terminal-helper-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleDirectSend(ESCAPE)}
            disabled={!isConnected}
            aria-label="Send Escape key"
            title="Escape"
          >
            Esc
          </button>

          <span className="terminal-helpers-separator" />

          {/* Send Keys dialog */}
          <div className="send-keys-wrapper">
            <button
              type="button"
              className={`terminal-helper-btn send-keys-btn${showSendKeys ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowSendKeys((prev) => !prev)}
              disabled={!isConnected}
              aria-label="Open send keys dialog"
              title="Send custom key combination"
            >
              Send Keys
            </button>

            {showSendKeys && (
              <div className="send-keys-dialog">
                <input
                  ref={sendKeysInputRef}
                  type="text"
                  className="send-keys-input"
                  value={sendKeysValue}
                  onChange={(e) => setSendKeysValue(e.target.value)}
                  onKeyDown={handleSendKeysKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="e.g. Ctrl+C, Alt+B"
                  aria-label="Key combination to send"
                />
                <button
                  type="button"
                  className="send-keys-submit"
                  onClick={handleSendKeysSubmit}
                  disabled={!sendKeysValue.trim()}
                  aria-label="Send key combination"
                >
                  Send
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {pendingModifier && (
        <div className="modifier-prompt" aria-live="polite">
          Press a key for {pendingModifier === "ctrl" ? "Ctrl" : "Alt"}+...
        </div>
      )}
    </div>
  );
}
