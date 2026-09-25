import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeSource, parseClaudeFile } from '../src/parsers/claude.js';
import { parseCodexFile } from '../src/parsers/codex.js';
import { claudeAssistant, codexUsage, tempDir, writeJsonl } from './helpers.js';

const claudeUsage = (output, extra = {}) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 5000,
  output_tokens: output,
  output_tokens_details: { thinking_tokens: 40 },
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
  service_tier: 'standard',
  speed: 'standard',
  inference_geo: 'not_available',
  ...extra,
});

test('Claude: one event per message, keeping the most complete copy', () => {
  const path = writeJsonl(join(tempDir(), 'session.jsonl'), [
    { type: 'user', timestamp: '2026-09-25T18:59:00.000Z', message: { role: 'user', content: 'hi' } },
    claudeAssistant({ id: 'msg_011A', usage: claudeUsage(10) }),
    claudeAssistant({ id: 'msg_011A', usage: claudeUsage(120) }),
    claudeAssistant({ id: 'msg_011A', usage: claudeUsage(120) }),
    claudeAssistant({ id: 'msg_011B', usage: claudeUsage(7) }),
  ]);
  const events = parseClaudeFile(path);
  assert.equal(events.length, 2);
  const first = events.find((event) => event.id === 'claude:msg_011A');
  assert.equal(first.output, 120);
  assert.equal(first.reasoning, 40);
  assert.equal(first.input, 2);
  assert.equal(first.cacheRead, 5000);
  assert.equal(first.cacheWrite1h, 1000);
  assert.equal(first.cacheWrite, 0);
  assert.equal(first.source, 'claude');
  assert.equal(first.project, '/work/project');
});

test('Claude: Bedrock responses are detected by message ID or model ID', () => {
  assert.equal(claudeSource('msg_bdrk_abc', 'claude-opus-5-5'), 'bedrock');
  assert.equal(claudeSource('msg_011Cf', 'claude-opus-5-5'), 'claude');
  assert.equal(claudeSource('msg_x', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'bedrock');

  const path = writeJsonl(join(tempDir(), 'bedrock.jsonl'), [
    claudeAssistant({ id: 'msg_bdrk_xyz', requestId: 'cfba74a9-5a44', usage: claudeUsage(5) }),
  ]);
  assert.equal(parseClaudeFile(path)[0].source, 'bedrock');
});

test('Claude: cache writes without a TTL breakdown count as 5-minute writes', () => {
  const usage = claudeUsage(5);
  delete usage.cache_creation;
  const path = writeJsonl(join(tempDir(), 'old.jsonl'), [claudeAssistant({ id: 'msg_old', usage })]);
  const [event] = parseClaudeFile(path);
  assert.equal(event.cacheWrite, 1000);
  assert.equal(event.cacheWrite1h, 0);
});

test('Claude: synthetic messages, non-assistant lines and bad JSON are ignored', () => {
  const path = join(tempDir(), 'mixed.jsonl');
  writeJsonl(path, [
    claudeAssistant({ id: 'msg_s', model: '<synthetic>', usage: claudeUsage(0) }),
    { type: 'summary', usage: { output_tokens: 9 } },
  ]);
  appendFileSync(path, '{"type":"assistant","usage": broken\n');
  assert.deepEqual(parseClaudeFile(path), []);
});

const turnContext = (model, timestamp = '2026-09-25T18:00:00.000Z') => ({
  timestamp, type: 'turn_context', payload: { model, cwd: '/work/codex' },
});
const record = (responseId, usage, timestamp = '2026-09-25T18:00:05.000Z') => ({
  timestamp,
  type: 'token_usage_record',
  payload: { response_id: responseId, usage, turn_token_usage: usage, thread_token_usage: usage },
});
const tokenCount = (last, total, timestamp = '2026-09-25T18:00:05.000Z') => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
});

test('Codex: token_usage_record events are used when present, with the current model', () => {
  const path = writeJsonl(join(tempDir(), 'rollout.jsonl'), [
    { timestamp: '2026-09-25T18:00:00.000Z', type: 'session_meta', payload: { id: 't1' } },
    turnContext('gpt-6-astra'),
    record('resp_1', codexUsage(30_000, 26_000, 300, 10)),
    tokenCount(codexUsage(30_000, 26_000, 300, 10), codexUsage(30_000, 26_000, 300, 10)),
    { timestamp: '2026-09-25T18:01:00.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', service_tier: 'priority' } } },
    record('resp_2', codexUsage(1000, 0, 50)),
  ]);
  const events = parseCodexFile(path);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.id), ['codex:resp_1', 'codex:resp_2']);
  const [first, second] = events;
  assert.equal(first.model, 'gpt-6-astra');
  assert.equal(first.input, 4000);
  assert.equal(first.cacheRead, 26_000);
  assert.equal(first.output, 300);
  assert.equal(first.reasoning, 10);
  assert.equal(second.model, 'gpt-5.6-sol');
  assert.equal(second.serviceTier, 'priority');
});

test('Codex: a record logged before any settings gets the thread model', () => {
  const path = writeJsonl(join(tempDir(), 'guardian.jsonl'), [
    { timestamp: '2026-09-25T18:00:00.000Z', type: 'session_meta', payload: { id: 't2' } },
    record('resp_compact', codexUsage(240_000, 4864, 438)),
    turnContext('codex-auto-review'),
    record('resp_review', codexUsage(1000, 0, 20)),
  ]);
  assert.deepEqual(parseCodexFile(path).map((event) => event.model), ['codex-auto-review', 'codex-auto-review']);
});

test('Codex legacy: counts changes in the running total and skips replays', () => {
  const t1 = codexUsage(100, 0, 10);
  const t2 = codexUsage(250, 100, 30);
  const path = writeJsonl(join(tempDir(), 'legacy.jsonl'), [
    // Replayed from the parent thread before this rollout's first turn.
    tokenCount(codexUsage(85_000, 0, 500), codexUsage(5_000_000, 0, 20_000), '2026-09-17T18:50:13.207Z'),
    turnContext('gpt-5.5', '2026-09-17T18:50:14.000Z'),
    tokenCount(t1, codexUsage(5_000_100, 0, 20_010), '2026-09-17T18:50:15.000Z'),
    // Same total logged twice.
    tokenCount(t1, codexUsage(5_000_100, 0, 20_010), '2026-09-17T18:50:15.500Z'),
    tokenCount(t2, codexUsage(5_000_350, 100, 20_040), '2026-09-17T18:50:16.000Z'),
    { timestamp: '2026-09-17T18:50:17.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
  ]);
  const events = parseCodexFile(path);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => [event.input, event.cacheRead, event.output]), [[100, 0, 10], [150, 100, 30]]);
  assert.ok(events.every((event) => event.model === 'gpt-5.5'));
});

test('Codex legacy: falls back to the total delta when last usage is missing', () => {
  const count = (total, timestamp) => ({
    timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } },
  });
  const path = writeJsonl(join(tempDir(), 'delta.jsonl'), [
    turnContext('gpt-5-codex'),
    count(codexUsage(100, 0, 10), '2026-09-25T18:00:01.000Z'),
    count(codexUsage(300, 50, 40), '2026-09-25T18:00:02.000Z'),
  ]);
  const events = parseCodexFile(path);
  assert.deepEqual(events.map((event) => [event.input, event.cacheRead, event.output]), [[100, 0, 10], [150, 50, 30]]);
});
