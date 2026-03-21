import { describe, expect, test } from "bun:test";
import { calculateCost, formatCompactTokens, formatCost, lookupModelPricing, MODEL_PRICING } from "./model-pricing";

describe("MODEL_PRICING", () => {
  test("contains Claude models", () => {
    expect(MODEL_PRICING["claude-opus-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4"]).toBeDefined();
    expect(MODEL_PRICING["claude-haiku-4"]).toBeDefined();
  });

  test("contains OpenAI models", () => {
    expect(MODEL_PRICING["gpt-4o"]).toBeDefined();
    expect(MODEL_PRICING["gpt-4.1"]).toBeDefined();
    expect(MODEL_PRICING.o3).toBeDefined();
  });

  test("contains Google models", () => {
    expect(MODEL_PRICING["gemini-2.5-pro"]).toBeDefined();
  });

  test("every entry has inputPer1M and outputPer1M as positive numbers", () => {
    for (const [_key, pricing] of Object.entries(MODEL_PRICING)) {
      expect(typeof pricing.inputPer1M).toBe("number");
      expect(typeof pricing.outputPer1M).toBe("number");
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });
});

describe("lookupModelPricing", () => {
  test("returns exact match for known model", () => {
    const pricing = lookupModelPricing("claude-opus-4");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(15);
    expect(pricing?.outputPer1M).toBe(75);
  });

  test("returns match for model with date suffix", () => {
    const pricing = lookupModelPricing("claude-sonnet-4-20250514");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(3);
  });

  test("returns match for model with version suffix", () => {
    const pricing = lookupModelPricing("claude-opus-4-6");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(15);
  });

  test("returns match for model with provider prefix", () => {
    const pricing = lookupModelPricing("anthropic/claude-sonnet-4");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(3);
  });

  test("returns match for gpt-4o variant", () => {
    const pricing = lookupModelPricing("gpt-4o-2025-01-01");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(2.5);
  });

  test("returns undefined for unknown model", () => {
    const pricing = lookupModelPricing("unknown-model-xyz");
    expect(pricing).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    const pricing = lookupModelPricing("");
    expect(pricing).toBeUndefined();
  });

  test("matches claude-sonnet-4-5 to claude-sonnet-4", () => {
    const pricing = lookupModelPricing("claude-sonnet-4-5-20250514");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1M).toBe(3);
  });
});

describe("calculateCost", () => {
  test("calculates cost correctly for known token counts", () => {
    const cost = calculateCost(1_000_000, 500_000, "claude-opus-4");
    // 1M * 15/1M + 500K * 75/1M = 15 + 37.5 = 52.5
    expect(cost).toBeCloseTo(52.5, 2);
  });

  test("returns 0 for zero tokens", () => {
    const cost = calculateCost(0, 0, "claude-opus-4");
    expect(cost).toBe(0);
  });

  test("returns 0 for unknown model", () => {
    const cost = calculateCost(10000, 5000, "unknown-model");
    expect(cost).toBe(0);
  });

  test("calculates fractional costs correctly", () => {
    const cost = calculateCost(1000, 500, "claude-sonnet-4");
    // 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  test("handles undefined model", () => {
    const cost = calculateCost(1000, 500, undefined);
    expect(cost).toBe(0);
  });
});

describe("formatCompactTokens", () => {
  test("formats small numbers directly", () => {
    expect(formatCompactTokens(500)).toBe("500");
  });

  test("formats thousands with k suffix", () => {
    expect(formatCompactTokens(12400)).toBe("12.4k");
  });

  test("formats millions with M suffix", () => {
    expect(formatCompactTokens(1_500_000)).toBe("1.5M");
  });

  test("formats zero as 0", () => {
    expect(formatCompactTokens(0)).toBe("0");
  });

  test("formats exactly 1000 as 1.0k", () => {
    expect(formatCompactTokens(1000)).toBe("1.0k");
  });

  test("formats exactly 1000000 as 1.0M", () => {
    expect(formatCompactTokens(1_000_000)).toBe("1.0M");
  });

  test("formats 999 as 999 (below k threshold)", () => {
    expect(formatCompactTokens(999)).toBe("999");
  });
});

describe("formatCost", () => {
  test("formats zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  test("formats small cost with two decimal places", () => {
    expect(formatCost(0.38)).toBe("$0.38");
  });

  test("formats large cost", () => {
    expect(formatCost(12.5)).toBe("$12.50");
  });

  test("formats very small cost with more precision", () => {
    expect(formatCost(0.001)).toBe("$0.001");
  });

  test("formats cost less than a cent", () => {
    expect(formatCost(0.0001)).toBe("<$0.01");
  });
});
