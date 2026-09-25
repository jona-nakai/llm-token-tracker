import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costEvent, displayName, normalizeModel, resolveModel } from '../src/pricing.js';
import { prices, usageEvent } from './helpers.js';

const table = prices();
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('normalizes provider-specific model IDs', () => {
  assert.equal(normalizeModel('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(normalizeModel('global.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normalizeModel('claude-haiku-4-5@20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.equal(normalizeModel('GPT-6-Astra'), 'gpt-6-astra');
});

test('does not price an unknown variant as its base model', () => {
  assert.equal(resolveModel(table, 'gpt-5-nano'), null);
  assert.equal(resolveModel(table, 'gpt-5.3-codex-spark'), null);
  assert.equal(resolveModel(table, 'gpt-5-codex').key, 'gpt-5-codex');
});

test('prices Anthropic usage with separate 5m and 1h cache-write rates', () => {
  const { cost, priced } = costEvent(table, usageEvent({
    model: 'claude-opus-5-5',
    input: 1_000_000,
    cacheWrite: 1_000_000,
    cacheWrite1h: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
    reasoning: 250_000,
  }));
  assert.equal(priced, true);
  close(cost.input, 4);
  close(cost.cacheWrite, 5 + 8);
  close(cost.cacheRead, 0.2);
  close(cost.output, 20);
  close(cost.reasoning, 5);
  close(cost.total, 4 + 13 + 0.2 + 20);
});

test('applies the Bedrock regional premium except to legacy models', () => {
  const bedrock = costEvent(table, usageEvent({ source: 'bedrock', model: 'claude-opus-5-5', output: 1_000_000 }));
  close(bedrock.cost.output, 22);
  const legacy = costEvent(table, usageEvent({ source: 'bedrock', model: 'claude-opus-4-1', output: 1_000_000 }));
  close(legacy.cost.output, 75);
});

test('applies first-party US inference geography and fast mode multipliers', () => {
  const us = costEvent(table, usageEvent({ geo: 'us', output: 1_000_000 }));
  close(us.cost.output, 22);
  const fast = costEvent(table, usageEvent({ speed: 'fast', input: 1_000_000, output: 1_000_000 }));
  close(fast.cost.input, 8);
  close(fast.cost.output, 40);
  const notAvailable = costEvent(table, usageEvent({ geo: 'not_available', output: 1_000_000 }));
  close(notAvailable.cost.output, 20);
});

test('uses OpenAI long-context rates when the prompt exceeds 272K tokens', () => {
  const short = costEvent(table, usageEvent({ source: 'codex', model: 'gpt-6-astra', input: 100_000, cacheRead: 172_000, output: 1000 }));
  close(short.cost.input, 100_000 * 10 / 1e6);
  close(short.cost.cacheRead, 172_000 * 1 / 1e6);
  close(short.cost.output, 1000 * 50 / 1e6);

  const long = costEvent(table, usageEvent({ source: 'codex', model: 'gpt-6-astra', input: 100_000, cacheRead: 172_001, output: 1000 }));
  close(long.cost.input, 100_000 * 20 / 1e6);
  close(long.cost.cacheRead, 172_001 * 2 / 1e6);
  close(long.cost.output, 1000 * 75 / 1e6);
});

test('applies the priority-tier multiplier for Codex fast mode', () => {
  const priority = costEvent(table, usageEvent({ source: 'codex', model: 'gpt-5.5', serviceTier: 'priority', output: 1_000_000 }));
  close(priority.cost.output, 75);
  const standard = costEvent(table, usageEvent({ source: 'codex', model: 'gpt-5.5', serviceTier: 'default', output: 1_000_000 }));
  close(standard.cost.output, 30);
});

test('leaves models without a public price unpriced, unless aliased', () => {
  const event = usageEvent({ source: 'codex', model: 'codex-auto-review', input: 100_000 });
  const unpriced = costEvent(table, event);
  assert.equal(unpriced.priced, false);
  assert.equal(unpriced.cost.total, 0);

  const aliased = costEvent({ ...table, aliases: { 'codex-auto-review': 'gpt-5.6-sol' } }, event);
  assert.equal(aliased.priced, true);
  assert.equal(aliased.modelKey, 'gpt-5.6-sol');
  close(aliased.cost.input, 0.4);
});

test('display names come from the price table', () => {
  assert.equal(displayName(table, 'us.anthropic.claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(displayName(table, 'mystery-model'), 'mystery-model');
});
