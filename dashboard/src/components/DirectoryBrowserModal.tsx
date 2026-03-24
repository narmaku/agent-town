import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { API } from "../utils";
import { FolderIcon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  machineId: string;
  initialPath: string;
}

interface ListDirsResponse {
  dirs: string[];
  parent: string | null;
  error?: string;
}

export function DirectoryBrowserModal({
  open,
  onClose,
  onSelect,
  machineId,
  initialPath,
}: Props): React.JSX.Element | null {
  const [currentPath, setCurrentPath] = useState(initialPath || "/");
  const [dirs, setDirs] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchDirs = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError("");
      try {
        const resp = await fetch(
          `${API.LIST_DIRS}?machineId=${encodeURIComponent(machineId)}&dir=${encodeURIComponent(dir)}`,
        );
        const data: ListDirsResponse = await resp.json();
        if (!resp.ok) {
          setError(data.error || "Failed to list directories");
          setDirs([]);
          setParent(null);
        } else {
          setDirs(data.dirs);
          setParent(data.parent);
          setCurrentPath(dir);
        }
      } catch (_err) {
        setError("Failed to connect to server");
        setDirs([]);
        setParent(null);
      } finally {
        setLoading(false);
      }
    },
    [machineId],
  );

  useEffect(() => {
    if (open) {
      const startPath = initialPath || "/";
      setCurrentPath(startPath);
      fetchDirs(startPath);
    }
  }, [open, initialPath, fetchDirs]);

  if (!open) return null;

  function handleNavigate(dirName: string) {
    const newPath = currentPath === "/" ? `/${dirName}` : `${currentPath}/${dirName}`;
    fetchDirs(newPath);
  }

  function handleNavigateUp() {
    if (parent) {
      fetchDirs(parent);
    }
  }

  function handleSelect() {
    onSelect(currentPath);
    onClose();
  }

  // Build breadcrumb segments from current path
  const pathSegments = currentPath === "/" ? ["/"] : currentPath.split("/").filter(Boolean);

  function handleBreadcrumbClick(index: number) {
    if (index === -1) {
      fetchDirs("/");
      return;
    }
    const path = `/${pathSegments.slice(0, index + 1).join("/")}`;
    fetchDirs(path);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop
    <div
      className="modal-overlay dir-browser-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div className="modal-panel dir-browser-panel">
        <div className="modal-header">
          <h2 className="modal-title">Browse Directory</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close directory browser">
            &times;
          </button>
        </div>

        <div className="dir-browser-breadcrumb">
          <button
            type="button"
            className="dir-breadcrumb-segment"
            onClick={() => handleBreadcrumbClick(-1)}
            aria-label="Navigate to root"
          >
            /
          </button>
          {pathSegments.map((segment, i) =>
            segment === "/" ? null : (
              <span key={`/${pathSegments.slice(0, i + 1).join("/")}`}>
                <span className="dir-breadcrumb-separator">/</span>
                <button
                  type="button"
                  className="dir-breadcrumb-segment"
                  onClick={() => handleBreadcrumbClick(i)}
                  aria-label={`Navigate to ${segment}`}
                >
                  {segment}
                </button>
              </span>
            ),
          )}
        </div>

        <div className="modal-body dir-browser-body">
          {loading && <div className="dir-browser-loading">Loading...</div>}
          {error && <div className="form-error">{error}</div>}

          {!loading && !error && (
            <div className="dir-browser-list" role="listbox" aria-label="Directory listing">
              {parent !== null && (
                <button
                  type="button"
                  className="dir-browser-item"
                  onClick={handleNavigateUp}
                  aria-label="Navigate to parent directory"
                  role="option"
                  aria-selected={false}
                >
                  <FolderIcon size={14} />
                  <span>..</span>
                </button>
              )}
              {dirs.length === 0 && <div className="dir-browser-empty">No subdirectories</div>}
              {dirs.map((dir) => (
                <button
                  type="button"
                  className="dir-browser-item"
                  key={dir}
                  onClick={() => handleNavigate(dir)}
                  aria-label={`Open directory ${dir}`}
                  role="option"
                  aria-selected={false}
                >
                  <FolderIcon size={14} />
                  <span>{dir}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div className="dir-browser-current-path" title={currentPath}>
            {currentPath}
          </div>
          <div className="dir-browser-actions">
            <button type="button" className="action-btn" onClick={onClose} aria-label="Cancel directory selection">
              Cancel
            </button>
            <button type="button" className="send-btn" onClick={handleSelect} aria-label="Select current directory">
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
