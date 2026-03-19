import { describe, expect, test } from "bun:test";
import { paginateFromEnd, safeJsonParse, truncateId } from "./utils";

describe("paginateFromEnd", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  test("returns last N items with offset=0", () => {
    const result = paginateFromEnd(items, 0, 3);
    expect(result.slice).toEqual([8, 9, 10]);
    expect(result.hasMore).toBe(true);
  });

  test("returns items with offset", () => {
    const result = paginateFromEnd(items, 3, 3);
    expect(result.slice).toEqual([5, 6, 7]);
    expect(result.hasMore).toBe(true);
  });

  test("returns first items when offset+limit exceeds total", () => {
    const result = paginateFromEnd(items, 7, 5);
    expect(result.slice).toEqual([1, 2, 3]);
    expect(result.hasMore).toBe(false);
  });

  test("returns all items when limit equals total", () => {
    const result = paginateFromEnd(items, 0, 10);
    expect(result.slice).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.hasMore).toBe(false);
  });

  test("returns all items when limit exceeds total", () => {
    const result = paginateFromEnd(items, 0, 20);
    expect(result.slice).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.hasMore).toBe(false);
  });

  test("returns empty slice when offset equals total", () => {
    const result = paginateFromEnd(items, 10, 5);
    expect(result.slice).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("returns empty slice when offset exceeds total", () => {
    const result = paginateFromEnd(items, 15, 5);
    expect(result.slice).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("handles empty array", () => {
    const result = paginateFromEnd([], 0, 5);
    expect(result.slice).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("handles single item array", () => {
    const result = paginateFromEnd(["a"], 0, 1);
    expect(result.slice).toEqual(["a"]);
    expect(result.hasMore).toBe(false);
  });

  test("handles limit of 1", () => {
    const result = paginateFromEnd(items, 0, 1);
    expect(result.slice).toEqual([10]);
    expect(result.hasMore).toBe(true);
  });
});

describe("truncateId", () => {
  test("truncates to default length of 12", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(truncateId(id)).toBe("550e8400-e29");
  });

  test("truncates to custom length", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(truncateId(id, 8)).toBe("550e8400");
  });

  test("returns full string when shorter than length", () => {
    expect(truncateId("short")).toBe("short");
  });

  test("returns full string when exactly default length", () => {
    expect(truncateId("123456789012")).toBe("123456789012");
  });

  test("handles empty string", () => {
    expect(truncateId("")).toBe("");
  });

  test("handles length of 0", () => {
    expect(truncateId("some-id", 0)).toBe("");
  });
});

describe("safeJsonParse", () => {
  test("parses valid JSON object", () => {
    const result = safeJsonParse<{ name: string }>('{"name": "test"}');
    expect(result).toEqual({ name: "test" });
  });

  test("parses valid JSON array", () => {
    const result = safeJsonParse<number[]>("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  test("parses valid JSON string", () => {
    const result = safeJsonParse<string>('"hello"');
    expect(result).toBe("hello");
  });

  test("parses valid JSON number", () => {
    const result = safeJsonParse<number>("42");
    expect(result).toBe(42);
  });

  test("returns null for invalid JSON", () => {
    expect(safeJsonParse("{invalid}")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(safeJsonParse("")).toBeNull();
  });

  test("returns null for partial JSON", () => {
    expect(safeJsonParse('{"key":')).toBeNull();
  });
});
