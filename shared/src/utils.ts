import { SESSION_ID_DISPLAY_LENGTH } from "./constants";

/**
 * Paginate items from the end of an array (reverse chronological order).
 * Returns a slice of items and whether there are more items before the slice.
 */
export function paginateFromEnd<T>(items: T[], offset: number, limit: number): { slice: T[]; hasMore: boolean } {
  const total = items.length;
  const startFromEnd = offset + limit;
  const startIndex = Math.max(0, total - startFromEnd);
  const endIndex = Math.max(0, total - offset);
  const slice = items.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;
  return { slice, hasMore };
}

/**
 * Truncate an ID for display in log messages.
 * Defaults to SESSION_ID_DISPLAY_LENGTH (12) characters.
 */
export function truncateId(id: string, length: number = SESSION_ID_DISPLAY_LENGTH): string {
  return id.slice(0, length);
}

/**
 * Parse JSON safely, returning null on failure.
 */
export function safeJsonParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch (_err: unknown) {
    return null;
  }
}

/**
 * Format a token count compactly (e.g., 12400 -> "12.4k", 1500000 -> "1.5M").
 */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}
