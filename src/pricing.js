import { readFileSync } from 'node:fs';

const PER_TOKEN = 1 / 1_000_000;

export function loadPrices(path) {
  const table = JSON.parse(readFileSync(path, 'utf8'));
  const envMultiplier = Number(process.env.BEDROCK_PRICE_MULTIPLIER);
  if (Number.isFinite(envMultiplier) && envMultiplier > 0) {
    table.providers.bedrock.multiplier = envMultiplier;
  }
  return table;
}

// Reduce provider-specific model IDs to the canonical key used in prices.json:
// "us.anthropic.claude-haiku-4-5-20251001-v1:0" -> "claude-haiku-4-5",
// "claude-opus-5-5[1m]" -> "claude-opus-5-5", "gpt-5.4-2026-03-05" -> "gpt-5.4".
// Only dates and provider decorations are stripped; a different variant name
// ("gpt-5-nano") stays distinct so it is never priced as its base model.
export function normalizeModel(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[@-]\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

// Returns { key, entry } for a model, or null when there is no price for it.
export function resolveModel(table, raw) {
  const normalized = normalizeModel(raw);
  if (!normalized) return null;
  // An alias wins over an "unpriced" note, so users can opt into an estimate.
  const key = table.aliases?.[normalized] ?? normalized;
  return table.models[key] ? { key, entry: table.models[key] } : null;
}

export function displayName(table, raw) {
  const resolved = resolveModel(table, raw);
  return resolved?.entry.name ?? (normalizeModel(raw) || 'unknown');
}

// Cost of one usage event. Token fields are disjoint: `input` is uncached
// input, `output` already includes `reasoning`.
export function costEvent(table, event) {
  const resolved = resolveModel(table, event.model);
  const cost = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 };
  if (!resolved) return { cost, modelKey: null, priced: false };

  const { key, entry } = resolved;
  const promptTokens = event.input + event.cacheRead + event.cacheWrite + event.cacheWrite1h;
  const rates = entry.longContext && promptTokens > entry.longContext.threshold
    ? { ...entry, ...entry.longContext }
    : entry;

  let multiplier = 1;
  if (event.speed === 'fast' && entry.fastMultiplier) multiplier *= entry.fastMultiplier;
  if ((event.serviceTier === 'priority' || event.serviceTier === 'fast') && entry.priorityMultiplier) {
    multiplier *= entry.priorityMultiplier;
  }
  if (event.source === 'bedrock') {
    if (!entry.legacyRegionalPricing) multiplier *= table.providers.bedrock.multiplier;
  } else if (event.geo === 'us' && entry.vendor === 'anthropic' && !entry.legacyRegionalPricing) {
    multiplier *= table.providers.anthropicUsGeo.multiplier;
  }

  const rate = (value) => value * PER_TOKEN * multiplier;
  const writeRate = rates.cacheWrite ?? rates.input;
  const write1hRate = rates.cacheWrite1h ?? writeRate;

  cost.input = event.input * rate(rates.input);
  cost.cacheWrite = event.cacheWrite * rate(writeRate) + event.cacheWrite1h * rate(write1hRate);
  cost.cacheRead = event.cacheRead * rate(rates.cacheRead ?? rates.input);
  cost.output = event.output * rate(rates.output);
  cost.reasoning = event.reasoning * rate(rates.output);
  cost.total = cost.input + cost.cacheWrite + cost.cacheRead + cost.output;
  return { cost, modelKey: key, priced: true };
}
