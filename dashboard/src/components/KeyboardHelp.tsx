import type React from "react";
import { useEffect } from "react";

interface ShortcutEntry {
  keys: string;
  description: string;
}

const SHORTCUT_DISPLAY: ShortcutEntry[] = [
  { keys: "j / k", description: "Navigate sessions" },
  { keys: "Enter", description: "Expand / collapse" },
  { keys: "f", description: "Fullscreen view" },
  { keys: "Esc", description: "Close / back" },
  { keys: "/", description: "Search" },
  { keys: "t", description: "Open terminal" },
  { keys: "s", description: "Send message" },
  { keys: "?", description: "This help" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardHelp({ open, onClose }: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop
    <div
      className="keyboard-help-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="keyboard-help-panel">
        <div className="keyboard-help-header">
          <h2 className="keyboard-help-title">Keyboard Shortcuts</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="keyboard-help-body">
          {SHORTCUT_DISPLAY.map((entry) => (
            <div key={entry.keys} className="keyboard-help-row">
              <kbd className="keyboard-help-key">{entry.keys}</kbd>
              <span className="keyboard-help-desc">{entry.description}</span>
            </div>
          ))}
        </div>
        <div className="keyboard-help-footer">Shortcuts are suppressed when typing in an input field.</div>
      </div>
    </div>
  );
}
