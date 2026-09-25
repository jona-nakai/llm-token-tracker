import assert from 'node:assert/strict';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageStore, defaultRoots } from '../src/store.js';
import { PRICES_PATH, claudeAssistant, codexUsage, tempDir, writeJsonl } from './helpers.js';

const usage = (output) => ({
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 100,
  output_tokens: output,
});

function setup() {
  const dir = tempDir();
  const roots = { claude: [join(dir, 'claude')], codex: [join(dir, 'codex', 'sessions'), join(dir, 'codex', 'archived')] };
  const cachePath = join(dir, 'cache', 'index.json');
  return { dir, roots, cachePath };
}

test('dedupes the same response across files and prices every event', () => {
  const { dir, roots, cachePath } = setup();
  writeJsonl(join(dir, 'claude', 'p', 'a.jsonl'), [claudeAssistant({ id: 'msg_1', usage: usage(10) })]);
  // A resumed session copies the earlier message into a new transcript.
  writeJsonl(join(dir, 'claude', 'p', 'b.jsonl'), [
    claudeAssistant({ id: 'msg_1', usage: usage(10) }),
    claudeAssistant({ id: 'msg_bdrk_2', usage: usage(20) }),
  ]);
  const codexRecords = [
    { timestamp: '2026-09-25T18:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { timestamp: '2026-09-25T18:00:01.000Z', type: 'token_usage_record', payload: { response_id: 'resp_1', usage: codexUsage(100, 0, 5) } },
  ];
  writeJsonl(join(dir, 'codex', 'sessions', '2026', 'r.jsonl'), codexRecords);
  writeJsonl(join(dir, 'codex', 'archived', 'r.jsonl'), codexRecords);

  const store = new UsageStore({ roots, pricesPath: PRICES_PATH, cachePath });
  store.refresh({ force: true });
  const events = store.events();
  assert.deepEqual(events.map((e) => e.id).sort(), ['claude:msg_1', 'claude:msg_bdrk_2', 'codex:resp_1']);
  assert.ok(events.every((e) => e.priced && e.cost.total > 0));
  assert.equal(events.find((e) => e.id === 'claude:msg_bdrk_2').source, 'bedrock');
  assert.deepEqual(store.stats().claudeFiles, 2);
  assert.ok(existsSync(cachePath));
});

test('re-parses only changed files and keeps events from deleted ones', () => {
  const { dir, roots, cachePath } = setup();
  const path = writeJsonl(join(dir, 'claude', 'p', 'a.jsonl'), [claudeAssistant({ id: 'msg_1', usage: usage(10) })]);
  const other = writeJsonl(join(dir, 'claude', 'p', 'b.jsonl'), [claudeAssistant({ id: 'msg_9', usage: usage(1) })]);

  const store = new UsageStore({ roots, pricesPath: PRICES_PATH, cachePath });
  store.refresh({ force: true });
  assert.equal(store.events().length, 2);
  assert.equal(store.refresh({ force: true }), false, 'nothing changed');

  appendFileSync(path, `${JSON.stringify(claudeAssistant({ id: 'msg_2', usage: usage(5) }))}\n`);
  rmSync(other);
  assert.equal(store.refresh({ force: true }), true);
  assert.deepEqual(store.events().map((e) => e.id).sort(), ['claude:msg_1', 'claude:msg_2', 'claude:msg_9']);
  assert.equal(store.stats().retainedFiles, 1);
  assert.equal(store.stats().claudeFiles, 1);

  // A new process picks up the persisted cache without re-parsing.
  const reloaded = new UsageStore({ roots, pricesPath: PRICES_PATH, cachePath });
  assert.equal(reloaded.refresh({ force: true }), false);
  assert.equal(reloaded.events().length, 3);
});

test('default roots honor CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
  const roots = defaultRoots({ CLAUDE_CONFIG_DIR: '/a, /b', CODEX_HOME: '/c' }, '/home/me');
  assert.deepEqual(roots.claude, ['/a/projects', '/b/projects']);
  assert.deepEqual(roots.codex, ['/c/sessions', '/c/archived_sessions']);
  const defaults = defaultRoots({}, '/home/me');
  assert.deepEqual(defaults.claude, ['/home/me/.config/claude/projects', '/home/me/.claude/projects']);
});
