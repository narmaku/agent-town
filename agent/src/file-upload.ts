import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const UPLOAD_DIR = "/tmp/agent-town-uploads";

const envMaxMB = process.env.MAX_UPLOAD_SIZE_MB;
export const MAX_UPLOAD_SIZE_BYTES = (envMaxMB ? parseInt(envMaxMB, 10) : 50) * 1024 * 1024;

export function sanitizeFilename(name: string): string {
  let sanitized = name.replace(/[/\\]/g, "_");

  const lastSep = Math.max(sanitized.lastIndexOf("/"), sanitized.lastIndexOf("\\"));
  if (lastSep >= 0) {
    sanitized = sanitized.slice(lastSep + 1);
  }

  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, "_");

  sanitized = sanitized.replace(/\.{2,}/g, "").replace(/^\.+/, "");

  sanitized = sanitized
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_\./g, ".");

  if (!sanitized) {
    sanitized = "upload";
  }

  const uuid = crypto.randomUUID();
  return `${uuid}-${sanitized}`;
}

export async function cleanupOldUploads(maxAgeMs: number, dir: string = UPLOAD_DIR): Promise<number> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (_err) {
    return 0;
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    const filePath = join(dir, entry);
    try {
      const stat = statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        removed++;
      }
    } catch (_err) {
      // skip files we can't stat or delete
    }
  }

  return removed;
}
