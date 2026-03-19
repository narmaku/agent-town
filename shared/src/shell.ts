// --- Shell escaping ---

/** Characters that are safe to leave unquoted in a shell argument. */
export const SAFE_SHELL_RE = /^[a-zA-Z0-9._:/@=+-]+$/;

/** Escape a string for safe use as a shell argument using single-quote wrapping. */
export function shellEscape(arg: string): string {
  if (arg.length === 0) return "''";
  if (SAFE_SHELL_RE.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join command parts into a shell-safe string, optionally prepending `cd <dir> &&`. */
export function buildShellCommand(parts: string[], projectDir?: string): string {
  const escaped = parts.map(shellEscape).join(" ");
  if (projectDir) {
    return `cd ${shellEscape(projectDir)} && ${escaped}`;
  }
  return escaped;
}
