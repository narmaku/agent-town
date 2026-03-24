import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Result of listing directories in a path.
 */
export interface ListDirsResult {
  dirs: string[];
  parent: string | null;
}

/**
 * Validate that `dir` is a canonical absolute path.
 * Returns an error message string or null if valid.
 */
export function validateListDirsPath(dir: string): string | null {
  if (!dir) return "Missing dir parameter";
  if (!dir.startsWith("/")) return "dir must be an absolute path";
  const canonical = resolve(dir);
  if (canonical !== dir) return "dir must be a canonical absolute path (no .., //, or trailing /)";
  return null;
}

/**
 * List only subdirectories in the given path.
 * Returns sorted directory names and the parent directory path.
 *
 * @throws Error if the path does not exist or cannot be read.
 */
export async function listDirectories(dir: string): Promise<ListDirsResult> {
  const entries = await readdir(dir, { withFileTypes: true });

  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    }
  }

  dirs.sort();

  const parent = dir === "/" ? null : dirname(dir);

  return { dirs, parent };
}
