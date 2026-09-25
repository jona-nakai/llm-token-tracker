process.env.TZ = 'America/Los_Angeles';

const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');
const { summarize } = await import('../src/aggregate.js');
const { costEvent } = await import('../src/pricing.js');
const { prices, usageEvent } = await import('./helpers.js');

const table = prices();
const ALL = ['codex', 'claude', 'bedrock'];
const now = new Date(2026, 8, 25, 15, 30); // Fri Sep 25 2026, 3:30 PM

function priced(overrides) {
  const event = usageEvent(overrides);
  return { ...event, ...costEvent(table, event) };
}

const events = [
  priced({ id: 'a', source: 'codex', model: 'gpt-6-astra', ts: new Date(2026, 7, 30, 10).getTime(), input: 1_000_000 }),
  priced({ id: 'b', source: 'claude', model: 'claude-opus-5', ts: new Date(2026, 8, 21, 9).getTime(), output: 1_000_000, reasoning: 100_000 }),
  priced({ id: 'c', source: 'bedrock', model: 'claude-opus-5-5', ts: new Date(2026, 8, 25, 12, 5).getTime(), cacheRead: 1_000_000 }),
  priced({ id: 'd', source: 'codex', model: 'codex-auto-review', ts: new Date(2026, 8, 25, 12, 40).getTime(), input: 500 }),
];

const run = (period, anchor = now, sources = ALL) => summarize(events, { period, anchor, sources, now, prices: table });

test('day view: totals, sources, models and hourly buckets', () => {
  const day = run('day');
  assert.equal(day.label, 'Fri, Sep 25, 2026');
  assert.equal(day.totals.requests, 2);
  assert.equal(day.totals.unpricedRequests, 1);
  assert.equal(day.totals.tokens.total, 1_000_500);
  assert.ok(Math.abs(day.totals.cost.total - 0.22) < 1e-9);
  assert.equal(day.bySource.bedrock.requests, 1);
  assert.equal(day.bySource.codex.requests, 1);
  assert.deepEqual(day.models.map((m) => [m.source, m.model, m.priced]), [
    ['bedrock', 'claude-opus-5-5', true],
    ['codex', 'codex-auto-review', false],
  ]);
  assert.match(day.models[1].unpricedNote, /no API price/i);
  assert.equal(day.chart.buckets.length, 24);
  assert.equal(day.chart.series.bedrock[12].tokens, 1_000_000);
  assert.equal(day.chart.series.codex[12].tokens, 500);
  assert.equal(day.isCurrent, true);
  assert.equal(day.hasNext, false);
  assert.equal(day.hasPrev, true);
});

test('week view runs Monday to Sunday and includes reasoning as part of output', () => {
  const week = run('week');
  assert.equal(week.label, 'Sep 21 – 27, 2026');
  assert.equal(week.totals.requests, 3);
  assert.equal(week.totals.tokens.output, 1_000_000);
  assert.equal(week.totals.tokens.reasoning, 100_000);
  assert.equal(week.totals.tokens.total, 2_000_500);
  assert.ok(Math.abs(week.chart.series.claude[0].cost - 25) < 1e-9);
});

test('navigating: previous periods have a next, and nothing precedes the first usage', () => {
  const lastMonth = run('month', new Date(2026, 7, 10));
  assert.equal(lastMonth.label, 'August 2026');
  assert.equal(lastMonth.isCurrent, false);
  assert.equal(lastMonth.hasNext, true);
  assert.equal(lastMonth.hasPrev, false);
  assert.equal(lastMonth.nextAnchor, '2026-09-01');
  assert.equal(lastMonth.totals.requests, 1);
});

test('source filter scopes every figure', () => {
  const claudeOnly = run('all', now, ['claude']);
  assert.equal(claudeOnly.totals.requests, 1);
  assert.equal(claudeOnly.bySource.codex.requests, 0);
  assert.deepEqual(claudeOnly.sources.filter((s) => s.selected).map((s) => s.id), ['claude']);
});

test('all time spans months from the first usage to now', () => {
  const all = run('all');
  assert.equal(all.label, 'Since Aug 30, 2026');
  assert.deepEqual(all.chart.buckets.map((b) => b.label), ['Aug 26', 'Sep 26']);
  assert.equal(all.totals.requests, 4);
  assert.equal(all.hasPrev, false);
  assert.equal(all.hasNext, false);
});
