/**
 * Model pricing lookup table for cost estimation.
 * Prices are in USD per 1 million tokens.
 */

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude models
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4": { inputPer1M: 0.8, outputPer1M: 4 },
  // OpenAI models
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  o3: { inputPer1M: 2, outputPer1M: 8 },
  // Google models
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
};

/**
 * Look up pricing for a model by name with fuzzy matching.
 * Strips provider prefixes (e.g., "anthropic/") and date/version suffixes
 * to match against known model keys.
 */
export function lookupModelPricing(model: string): ModelPricing | undefined {
  if (!model) return undefined;

  // Strip provider prefix (e.g., "anthropic/claude-opus-4" -> "claude-opus-4")
  const parts = model.split("/");
  const stripped = parts.length > 1 ? (parts.at(-1) ?? model) : model;

  // Try exact match first
  if (MODEL_PRICING[stripped]) {
    return MODEL_PRICING[stripped];
  }

  // Try prefix matching: find the longest key that is a prefix of the model name
  let bestMatch: string | undefined;
  let bestLength = 0;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (stripped.startsWith(key) && key.length > bestLength) {
      bestMatch = key;
      bestLength = key.length;
    }
  }

  return bestMatch ? MODEL_PRICING[bestMatch] : undefined;
}

/**
 * Calculate estimated cost in USD for given token counts and model.
 * Returns 0 if model pricing is unknown.
 */
export function calculateCost(inputTokens: number, outputTokens: number, model: string | undefined): number {
  if (!model) return 0;
  const pricing = lookupModelPricing(model);
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
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

/**
 * Format a cost in USD (e.g., 0.38 -> "$0.38", 0.001 -> "$0.001").
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.001) return "<$0.01";
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
