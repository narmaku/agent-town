import { API } from "../utils";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

interface UploadResult {
  path: string;
  filename: string;
}

export function getFileRefPrefix(mimeType: string): "image" | "file" {
  return mimeType.startsWith("image/") ? "image" : "file";
}

export function formatFileRef(prefix: "image" | "file", path: string): string {
  return `[${prefix}: ${path}]`;
}

export async function uploadFile(machineId: string, file: File): Promise<UploadResult> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large (${Math.round(file.size / 1024 / 1024)}MB). Max: 50MB`);
  }

  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${API.SESSIONS_UPLOAD}?machineId=${encodeURIComponent(machineId)}`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({ error: "Upload failed" }));
    throw new Error((data as { error?: string }).error || `Upload failed (${resp.status})`);
  }

  const data: { ok: boolean; path: string; filename: string } = await resp.json();
  return { path: data.path, filename: data.filename };
}
