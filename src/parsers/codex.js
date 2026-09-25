import { forEachLine, parseJson } from '../lines.js';

// Only the start of a line is searched for the record type, so multi-MB
// response items are never parsed or fully scanned.
const HEAD_CHARS = 400;
const RELEVANT = [
  '"token_usage_record"',
  '"token_count"',
  '"turn_context"',
  '"thread_settings_applied"',
];

function usageEvent({ id, ts, model, serviceTier, project, usage }) {
  const cached = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  return {
    id,
    source: 'codex',
    ts,
    model,
    // OpenAI's input_tokens includes cached and cache-write tokens.
    input: Math.max(0, (usage.input_tokens ?? 0) - cached - cacheWrite),
    cacheWrite,
    cacheWrite1h: 0,
    cacheRead: cached,
    // output_tokens includes reasoning_output_tokens.
    output: usage.output_tokens ?? 0,
    reasoning: usage.reasoning_output_tokens ?? 0,
    speed: null,
    serviceTier: serviceTier ?? null,
    geo: null,
    project: project ?? null,
  };
}

function isEmptyUsage(usage) {
  return !usage || ((usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0);
}

function subtractUsage(current, previous) {
  const delta = {};
  for (const key of Object.keys(current)) {
    delta[key] = Math.max(0, (current[key] ?? 0) - (previous?.[key] ?? 0));
  }
  return delta;
}

// One Codex rollout file -> usage events.
//
// Newer rollouts log a `token_usage_record` per model response (with a
// response_id); those are exact and used whenever present. Older rollouts only
// log `token_count` events carrying the thread's running total, so a response
// is counted when that total changes. Forked and sub-agent rollouts start by
// replaying the parent's last `token_count` before their own first turn, so
// counts seen before the first `turn_context` are skipped.
export function parseCodexFile(path) {
  const lines = [];
  let hasRecords = false;
  forEachLine(path, (line, index) => {
    const head = line.length > HEAD_CHARS ? line.slice(0, HEAD_CHARS) : line;
    if (!RELEVANT.some((marker) => head.includes(marker))) return;
    const record = parseJson(line);
    if (!record) return;
    if (record.type === 'token_usage_record') hasRecords = true;
    lines.push({ record, index });
  });

  const events = [];
  let firstModel = null;
  let model = null;
  let serviceTier = null;
  let project = null;
  let seenTurn = false;
  let previousTotal = null;

  for (const { record, index } of lines) {
    const payload = record.payload ?? {};
    const ts = Date.parse(record.timestamp);

    if (record.type === 'turn_context') {
      model = payload.model ?? model;
      firstModel ??= model;
      serviceTier = payload.service_tier ?? serviceTier;
      project = payload.cwd ?? project;
      seenTurn = true;
      continue;
    }
    if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      const settings = payload.thread_settings ?? {};
      model = settings.model ?? model;
      firstModel ??= model;
      serviceTier = settings.service_tier ?? serviceTier;
      project = settings.cwd ?? project;
      continue;
    }
    if (!Number.isFinite(ts)) continue;

    if (record.type === 'token_usage_record') {
      const usage = payload.usage;
      if (isEmptyUsage(usage)) continue;
      events.push(usageEvent({
        id: `codex:${payload.response_id ?? `${path}#${index}`}`,
        ts, model, serviceTier, project, usage,
      }));
      continue;
    }

    if (hasRecords || record.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info;
    const total = info?.total_token_usage;
    if (!total) continue;
    if (!seenTurn) {
      previousTotal = total;
      continue;
    }
    if (previousTotal && total.total_tokens === previousTotal.total_tokens) continue;

    const usage = info.last_token_usage ?? subtractUsage(total, previousTotal);
    previousTotal = total;
    if (isEmptyUsage(usage)) continue;
    events.push(usageEvent({
      // Copied history keeps its original timestamp and totals, so this ID
      // also collapses the same response appearing in two rollouts.
      id: `codex:tc:${record.timestamp}:${usage.total_tokens}:${total.total_tokens}`,
      ts, model, serviceTier, project, usage,
    }));
  }

  // A sub-agent can compact its inherited history before its settings are
  // logged; that response ran on the thread's model.
  for (const event of events) event.model ??= firstModel ?? 'unknown';
  return events;
}
