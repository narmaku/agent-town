import type React from "react";
import { useCallback, useRef, useState } from "react";
import { formatFileRef, getFileRefPrefix, uploadFile } from "../utils/file-upload";

const ERROR_DISMISS_MS = 5000;

interface Props {
  machineId: string;
  onFileUploaded: (ref: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

export function FileDropZone({ machineId, onFileUploaded, disabled, children }: Props): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");
  const dragCounterRef = useRef(0);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
    }
    errorTimeoutRef.current = setTimeout(() => {
      setError("");
      errorTimeoutRef.current = null;
    }, ERROR_DISMISS_MS);
  }, []);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    if (disabled || uploading) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploading(true);
    const refs: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(`Uploading ${file.name}${files.length > 1 ? ` (${i + 1}/${files.length})` : ""}...`);

      try {
        const result = await uploadFile(machineId, file);
        const prefix = getFileRefPrefix(file.type);
        refs.push(formatFileRef(prefix, result.path));
      } catch (err) {
        showError(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
      }
    }

    setUploading(false);
    setUploadProgress("");

    if (refs.length > 0) {
      onFileUploaded(refs.join("\n"));
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop zone requires event handlers
    <div
      className="file-drop-zone"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {isDragging && (
        <div className="file-drop-overlay" role="status">
          <div className="file-drop-overlay-content">
            <span className="file-drop-icon">📁</span>
            <span className="file-drop-text">Drop files here</span>
          </div>
        </div>
      )}

      {uploading && uploadProgress && (
        <div className="file-upload-progress" aria-live="polite">
          {uploadProgress}
        </div>
      )}

      {error && (
        <div className="file-upload-error" aria-live="assertive">
          {error}
        </div>
      )}
    </div>
  );
}
