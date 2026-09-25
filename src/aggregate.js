import { displayName } from './pricing.js';
import {
  bucketLabel, periodBuckets, periodLabel, periodRange, shiftAnchor, toDateKey,
} from '../public/lib/periods.js';

export const SOURCES = [
  { id: 'codex', label: 'Codex', plan: 'ChatGPT plan' },
  { id: 'claude', label: 'Claude Code', plan: 'Claude plan' },
  { id: 'bedrock', label: 'Claude Code', plan: 'AWS Bedrock' },
];

const TOKEN_KEYS = ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning'];

function emptyTotals() {
  return {
    requests: 0,
    unpricedRequests: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
    cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
  };
}

function addEvent(totals, event) {
  totals.requests += 1;
  if (!event.priced) totals.unpricedRequests += 1;
  totals.tokens.input += event.input;
  totals.tokens.cacheWrite += event.cacheWrite + event.cacheWrite1h;
  totals.tokens.cacheRead += event.cacheRead;
  totals.tokens.output += event.output;
  totals.tokens.reasoning += event.reasoning;
  totals.tokens.total += event.input + event.cacheWrite + event.cacheWrite1h + event.cacheRead + event.output;
  for (const key of [...TOKEN_KEYS, 'total']) totals.cost[key] += event.cost[key];
}

// Summary of usage for one period, shaped for the dashboard.
export function summarize(events, { period, anchor, sources, now, prices }) {
  const firstUsage = events.length ? new Date(events[0].ts) : null;
  const range = periodRange(period, anchor);
  const startMs = range.start?.getTime() ?? -Infinity;
  const endMs = range.end?.getTime() ?? Infinity;
  const wanted = new Set(sources);

  const buckets = periodBuckets(period, range, firstUsage, now);
  const bucketStarts = buckets.map((bucket) => bucket.start.getTime());
  const series = Object.fromEntries(SOURCES.map(({ id }) => [id, buckets.map(() => ({ cost: 0, tokens: 0 }))]));

  const totals = emptyTotals();
  const bySource = Object.fromEntries(SOURCES.map(({ id }) => [id, emptyTotals()]));
  const byModel = new Map();

  for (const event of events) {
    if (event.ts < startMs || event.ts >= endMs || !wanted.has(event.source)) continue;
    addEvent(totals, event);
    addEvent(bySource[event.source], event);

    const modelId = event.modelKey ?? event.model;
    const key = `${event.source}\u0000${modelId}`;
    if (!byModel.has(key)) {
      byModel.set(key, {
        source: event.source,
        model: modelId,
        name: displayName(prices, event.model),
        priced: event.priced,
        unpricedNote: event.priced ? null : prices.unpriced?.[modelId] ?? 'No API price on file for this model.',
        ...emptyTotals(),
      });
    }
    addEvent(byModel.get(key), event);

    const index = bucketIndex(bucketStarts, event.ts);
    if (index >= 0) {
      const cell = series[event.source][index];
      cell.cost += event.cost.total;
      cell.tokens += event.input + event.cacheWrite + event.cacheWrite1h + event.cacheRead + event.output;
    }
  }

  const currentRange = periodRange(period, now);
  const isCurrent = period === 'all' || range.start.getTime() === currentRange.start.getTime();
  const firstRange = firstUsage && period !== 'all' ? periodRange(period, firstUsage) : null;

  return {
    period,
    anchor: toDateKey(anchor),
    label: periodLabel(period, range, firstUsage),
    range: { start: range.start?.toISOString() ?? null, end: range.end?.toISOString() ?? null },
    isCurrent,
    hasPrev: period !== 'all' && !!firstRange && range.start > firstRange.start,
    hasNext: period !== 'all' && !isCurrent && range.end <= currentRange.start,
    prevAnchor: period === 'all' ? null : toDateKey(shiftAnchor(period, anchor, -1)),
    nextAnchor: period === 'all' ? null : toDateKey(shiftAnchor(period, anchor, 1)),
    currentAnchor: toDateKey(now),
    sources: SOURCES.map((source) => ({ ...source, selected: wanted.has(source.id) })),
    totals,
    bySource,
    models: [...byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total || b.cost.total - a.cost.total),
    chart: {
      buckets: buckets.map((bucket) => ({
        start: bucket.start.toISOString(),
        label: bucketLabel(period, bucket.start),
      })),
      series,
    },
  };
}

function bucketIndex(starts, ts) {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0 || ts < starts[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
