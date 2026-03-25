import { resolve } from "node:path";
import type { GitDiffFile, GitDiffFileStatus, GitDiffResponse } from "@agent-town/shared";

/** Maximum diff output size in characters (500 K characters). */
const MAX_DIFF_CHARS = 500 * 1024;

/**
 * Validate that `dir` is a canonical absolute path.
 * Returns an error message string or null if valid.
 */
export function validateDiffDir(dir: string): string | null {
  if (!dir) return "Missing dir parameter";
  if (!dir.startsWith("/")) return "dir must be an absolute path";
  const canonical = resolve(dir);
  if (canonical !== dir) return "dir must be a canonical absolute path (no .., //, or trailing /)";
  return null;
}

/**
 * Run a git command in the given directory and return stdout as a string.
 * Throws on non-zero exit or if the directory is not a git repo.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    if (stderr.includes("not a git repository")) {
      throw new GitDiffError("Not a git repository", 400);
    }
    throw new GitDiffError(`git ${args[0]} failed: ${stderr.trim()}`, 500);
  }
  return stdout;
}

/**
 * Custom error class for git-diff operations with an HTTP status code.
 */
export class GitDiffError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "GitDiffError";
  }
}

/**
 * Parse a unified diff string into per-file GitDiffFile entries.
 * Splits on "diff --git" markers and extracts path, status, and hunks.
 */
export function parseUnifiedDiff(diffOutput: string): GitDiffFile[] {
  if (!diffOutput.trim()) return [];

  const files: GitDiffFile[] = [];
  // Split on "diff --git" but keep the marker
  const sections = diffOutput.split(/^(?=diff --git )/m).filter((s) => s.trim());

  for (const section of sections) {
    const file = parseDiffSection(section);
    if (file) files.push(file);
  }

  return files;
}

/**
 * Parse a single "diff --git a/... b/..." section into a GitDiffFile.
 */
function parseDiffSection(section: string): GitDiffFile | null {
  const lines = section.split("\n");
  const headerLine = lines[0];

  // Extract file path from "diff --git a/path b/path"
  const headerMatch = headerLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!headerMatch) return null;

  const pathB = headerMatch[2];
  let status: GitDiffFileStatus = "modified";

  // Detect status from diff header lines
  for (const line of lines.slice(1, 10)) {
    if (line.startsWith("new file mode")) {
      status = "added";
      break;
    }
    if (line.startsWith("deleted file mode")) {
      status = "deleted";
      break;
    }
    if (line.startsWith("rename from") || line.startsWith("similarity index")) {
      status = "renamed";
      break;
    }
  }

  // Count insertions and deletions from hunk lines
  let insertions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return {
    path: pathB,
    status,
    insertions,
    deletions,
    diff: section,
  };
}

/**
 * Parse git numstat output into a map of path -> { insertions, deletions }.
 * Not currently used — kept for future enhanced diff stats (e.g., binary file detection).
 */
export function parseNumstat(numstatOutput: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const line of numstatOutput.trim().split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
    const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
    // For renames, numstat shows "old => new" — use the full path segment
    const filePath = parts.slice(2).join("\t");
    stats.set(filePath, { insertions: ins, deletions: del });
  }
  return stats;
}

/**
 * Fetch the complete git diff data for a directory.
 * Resolves to the git repository root if `dir` is a subdirectory.
 */
export async function fetchGitDiff(dir: string): Promise<GitDiffResponse> {
  // Resolve to the git repo root — cwd may be a subdirectory
  const repoRootOutput = await runGit(["rev-parse", "--show-toplevel"], dir);
  const repoRoot = repoRootOutput.trim();

  // Get branch name
  const branchOutput = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  const branch = branchOutput.trim();

  // Get full unified diff (tracked changes)
  const diffOutput = await runGit(["diff", "--no-color", "-U3"], repoRoot);

  // Truncate if diff is too large
  const safeDiff = diffOutput.length > MAX_DIFF_CHARS ? diffOutput.slice(0, MAX_DIFF_CHARS) : diffOutput;

  // Get staged changes too
  const stagedOutput = await runGit(["diff", "--cached", "--no-color", "-U3"], repoRoot);
  const safeStagedDiff = stagedOutput.length > MAX_DIFF_CHARS ? stagedOutput.slice(0, MAX_DIFF_CHARS) : stagedOutput;

  // Get untracked files
  const untrackedOutput = await runGit(["ls-files", "--others", "--exclude-standard"], repoRoot);

  // Parse diffs
  const unstaged = parseUnifiedDiff(safeDiff);
  const staged = parseUnifiedDiff(safeStagedDiff);

  // Build untracked file entries
  const untrackedFiles: GitDiffFile[] = untrackedOutput
    .trim()
    .split("\n")
    .filter((f) => f.trim())
    .map((path) => ({
      path,
      status: "untracked" as const,
      insertions: 0,
      deletions: 0,
      diff: `new untracked file: ${path}`,
    }));

  // Merge: staged files first, then unstaged (skip duplicates), then untracked
  const fileMap = new Map<string, GitDiffFile>();
  for (const f of staged) {
    fileMap.set(f.path, f);
  }
  for (const f of unstaged) {
    if (!fileMap.has(f.path)) {
      fileMap.set(f.path, f);
    }
  }
  for (const f of untrackedFiles) {
    if (!fileMap.has(f.path)) {
      fileMap.set(f.path, f);
    }
  }

  const files = Array.from(fileMap.values());

  const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    branch,
    files,
    summary: {
      filesChanged: files.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
    },
  };
}
