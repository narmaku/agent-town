import type { GitDiffFile, GitDiffResponse } from "@agent-town/shared";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { API } from "../utils";

interface Props {
  machineId: string;
  dir: string;
  onClose: () => void;
}

type LoadingState = "loading" | "loaded" | "error";

const STATUS_ICONS: Record<string, string> = {
  added: "+",
  modified: "*",
  deleted: "-",
  renamed: ">",
  untracked: "?",
};

const STATUS_CLASSES: Record<string, string> = {
  added: "diff-file-added",
  modified: "diff-file-modified",
  deleted: "diff-file-deleted",
  renamed: "diff-file-renamed",
  untracked: "diff-file-untracked",
};

function DiffLine({ line }: { line: string }): React.JSX.Element {
  let className = "diff-line diff-context";
  if (line.startsWith("+")) {
    className = "diff-line diff-add";
  } else if (line.startsWith("-")) {
    className = "diff-line diff-del";
  } else if (line.startsWith("@@")) {
    className = "diff-line diff-hunk";
  } else if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  ) {
    className = "diff-line diff-meta";
  }

  return <div className={className}>{line || "\u00A0"}</div>;
}

function DiffContent({ file }: { file: GitDiffFile }): React.JSX.Element {
  if (file.status === "untracked") {
    return (
      <div className="diff-content-body">
        <div className="diff-untracked-notice">Untracked file (not yet added to git)</div>
      </div>
    );
  }

  const lines = file.diff.split("\n");
  // Build stable keys: line number is unique within a file's diff
  const keyedLines = lines.map((line, i) => ({ key: `L${i}`, line }));

  return (
    <div className="diff-content-body">
      {keyedLines.map((entry) => (
        <DiffLine key={entry.key} line={entry.line} />
      ))}
    </div>
  );
}

export function DiffModal({ machineId, dir, onClose }: Props): React.JSX.Element {
  const [state, setState] = useState<LoadingState>("loading");
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const fetchDiff = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const resp = await fetch(
        `${API.GIT_DIFF}?machineId=${encodeURIComponent(machineId)}&dir=${encodeURIComponent(dir)}`,
      );
      const json: unknown = await resp.json();

      if (!resp.ok) {
        const errObj = json as { error?: string };
        setError(errObj?.error || `Request failed with status ${resp.status}`);
        setState("error");
        return;
      }

      const result = json as GitDiffResponse;
      setData(result);
      setSelectedIndex(0);
      setState("loaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to agent");
      setState("error");
    }
  }, [machineId, dir]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Escape to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const selectedFile = data?.files[selectedIndex];
  const shortDir = dir.replace(/^\/home\/[^/]+/, "~");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismissal
    <div
      className="diff-overlay"
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="diff-panel">
        {/* Header */}
        <div className="diff-header">
          <div className="diff-header-left">
            <span className="diff-header-title">Changes</span>
            {data?.branch && <span className="diff-branch-badge">{data.branch}</span>}
            {state === "loaded" && data && (
              <span className="diff-summary">
                {data.summary.filesChanged} file{data.summary.filesChanged !== 1 ? "s" : ""} changed
                {data.summary.insertions > 0 && <span className="diff-summary-add"> +{data.summary.insertions}</span>}
                {data.summary.deletions > 0 && <span className="diff-summary-del"> -{data.summary.deletions}</span>}
              </span>
            )}
          </div>
          <div className="diff-header-right">
            <button
              type="button"
              className="action-btn"
              onClick={fetchDiff}
              disabled={state === "loading"}
              aria-label="Refresh diff"
            >
              Refresh
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close diff viewer">
              &times;
            </button>
          </div>
        </div>

        <div className="diff-dir-bar">
          <span className="diff-dir-path">{shortDir}</span>
        </div>

        {/* Body */}
        <div className="diff-body">
          {state === "loading" && <div className="diff-loading">Loading diff...</div>}

          {state === "error" && (
            <div className="diff-error">
              <div className="diff-error-message">{error}</div>
              <button type="button" className="action-btn" onClick={fetchDiff} aria-label="Retry loading diff">
                Retry
              </button>
            </div>
          )}

          {state === "loaded" && data && data.files.length === 0 && (
            <div className="diff-empty">No uncommitted changes</div>
          )}

          {state === "loaded" && data && data.files.length > 0 && (
            <>
              {/* File list sidebar */}
              <div className="diff-file-list">
                {data.files.map((file, index) => (
                  <button
                    key={file.path}
                    type="button"
                    className={`diff-file-entry ${index === selectedIndex ? "selected" : ""} ${STATUS_CLASSES[file.status] || ""}`}
                    onClick={() => setSelectedIndex(index)}
                    aria-label={`View diff for ${file.path}`}
                  >
                    <span className="diff-file-icon">{STATUS_ICONS[file.status] || "?"}</span>
                    <span className="diff-file-name" title={file.path}>
                      {file.path.split("/").pop()}
                    </span>
                    {(file.insertions > 0 || file.deletions > 0) && (
                      <span className="diff-file-stats">
                        {file.insertions > 0 && <span className="diff-stat-add">+{file.insertions}</span>}
                        {file.deletions > 0 && <span className="diff-stat-del">-{file.deletions}</span>}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* Diff content area */}
              <div className="diff-content">
                {selectedFile && (
                  <>
                    <div className="diff-content-header">
                      <span className="diff-content-path">{selectedFile.path}</span>
                      <span className={`diff-content-status ${STATUS_CLASSES[selectedFile.status] || ""}`}>
                        {selectedFile.status}
                      </span>
                    </div>
                    <DiffContent file={selectedFile} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
