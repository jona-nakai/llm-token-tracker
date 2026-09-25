import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '../src/pricing.js';

export const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));

export function prices() {
  return loadPrices(PRICES_PATH);
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'llm-token-tracker-'));
}

export function writeJsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return path;
}

export function usageEvent(overrides = {}) {
  return {
    id: 'test:1',
    source: 'claude',
    ts: Date.parse('2026-09-25T12:00:00'),
    model: 'claude-opus-5-5',
    input: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    reasoning: 0,
    speed: null,
    serviceTier: null,
    geo: null,
    project: null,
    ...overrides,
  };
}

export function claudeAssistant({ id, model = 'claude-opus-5-5', timestamp = '2026-09-25T19:00:00.000Z', usage, requestId = 'req_1' }) {
  return {
    type: 'assistant',
    timestamp,
    requestId,
    cwd: '/work/project',
    message: { id, model, role: 'assistant', usage },
  };
}

export function codexUsage(input, cached, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}
