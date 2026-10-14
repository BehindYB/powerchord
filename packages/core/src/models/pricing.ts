/*
 * List prices of pay-as-you-go APIs, used to estimate what a request costs before and after it
 * runs. Providers bill by their own records; free tiers, credits, caching and batch discounts
 * make the actual charge lower. Prices are in USD per million tokens.
 */

export const PRICES_REVIEWED = '2026-10-14';

export type PricedProvider = 'anthropic' | 'openai' | 'gemini';

export interface ModelPrice {
  input: number;
  output: number;
  /** Higher rates for long prompts, applied when the prompt exceeds `aboveInputTokens`. */
  longPrompt?: { aboveInputTokens: number; input: number; output: number };
}

const price = (input: number, output: number): ModelPrice => ({ input, output });

const PRICES: Record<PricedProvider, Record<string, ModelPrice>> = {
  // https://platform.claude.com/docs/en/about-claude/pricing
  anthropic: {
    'claude-fable-5-1': price(10, 50),
    'claude-fable-5': price(10, 50),
    'claude-mythos-5-1': price(10, 50),
    'claude-mythos-5': price(10, 50),
    'claude-opus-5-5': price(4, 20),
    'claude-opus-5': price(5, 25),
    'claude-opus-4-8': price(5, 25),
    'claude-opus-4-7': price(5, 25),
    'claude-opus-4-6': price(5, 25),
    'claude-opus-4-5': price(5, 25),
    'claude-opus-4-1': price(15, 75),
    'claude-opus-4': price(15, 75),
    'claude-sonnet-5-5': price(2, 10),
    'claude-sonnet-5': price(2, 10),
    'claude-sonnet-4-6': price(3, 15),
    'claude-sonnet-4-5': price(3, 15),
    'claude-sonnet-4': price(3, 15),
    'claude-haiku-5-5': {
      input: 0.1,
      output: 0.5,
      longPrompt: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
    },
    'claude-haiku-4-5': price(1, 5),
    'claude-3-5-haiku': price(0.8, 4),
  },
  // https://developers.openai.com/api/docs/pricing (standard tier)
  openai: {
    'gpt-6-astra': price(10, 50),
    'gpt-6.1-sol': price(2, 10),
    'gpt-6-sol': price(2, 10),
    'gpt-5.6-sol': price(4, 20),
    'gpt-5.6-terra': price(2, 12),
    'gpt-5.6-luna': price(0.2, 1.2),
    'gpt-5.5': price(5, 30),
    'gpt-5.5-pro': price(30, 180),
    'gpt-5.4': price(2.5, 15),
    'gpt-5.4-mini': price(0.75, 4.5),
    'gpt-5.4-nano': price(0.2, 1.25),
    'gpt-5-mini': price(0.25, 2),
    'gpt-5-nano': price(0.05, 0.4),
    o3: price(2, 8),
    'o3-pro': price(20, 80),
    'o4-mini': price(1.1, 4.4),
  },
  // https://ai.google.dev/gemini-api/docs/pricing (paid tier; several rates rise from
  // December 2026)
  gemini: {
    'gemini-4-argon': price(2, 10),
    'gemini-3.8-flash': price(0.75, 3.75),
    'gemini-3.6-flash': price(0.75, 3.75),
    'gemini-3.5-flash-lite': price(0.3, 2.5),
    'gemini-3.1-flash-lite': price(0.25, 1.5),
    'gemini-3.1-pro-preview': {
      input: 2,
      output: 12,
      longPrompt: { aboveInputTokens: 200_000, input: 4, output: 18 },
    },
    'gemini-3.1-pro-preview-customtools': {
      input: 2,
      output: 12,
      longPrompt: { aboveInputTokens: 200_000, input: 4, output: 18 },
    },
    'gemini-3-flash-preview': price(0.5, 3),
    'gemini-2.5-pro': {
      input: 1.25,
      output: 10,
      longPrompt: { aboveInputTokens: 200_000, input: 2.5, output: 15 },
    },
    'gemini-2.5-flash': price(0.3, 2.5),
    'gemini-2.5-flash-lite': price(0.1, 0.4),
  },
};

/** Dated snapshots (`-20251001`, `-2025-10-01`) and `-latest` aliases share their model's price. */
const SNAPSHOT_SUFFIX = /^-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

export function findPrice(provider: PricedProvider, model: string): ModelPrice | null {
  const id = model.replace(/^models\//, '');
  const table = PRICES[provider];
  const exact = table[id];
  if (exact) return exact;
  for (const [key, value] of Object.entries(table)) {
    if (id.startsWith(key) && SNAPSHOT_SUFFIX.test(id.slice(key.length))) return value;
  }
  return null;
}

export function estimateCost(
  modelPrice: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates =
    modelPrice.longPrompt && inputTokens > modelPrice.longPrompt.aboveInputTokens
      ? modelPrice.longPrompt
      : modelPrice;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

/** Rough token count of text, for estimates before a request is sent. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
