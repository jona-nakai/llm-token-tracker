import { forEachLine, parseJson } from '../lines.js';

// Bedrock responses carry "msg_bdrk_" message IDs; first-party (Claude plan)
// responses carry "msg_01…". The model field is the same on both.
export function claudeSource(messageId, model) {
  if (String(messageId).startsWith('msg_bdrk_')) return 'bedrock';
  if (/^(?:[a-z]{2,6}\.)?anthropic\./.test(String(model))) return 'bedrock';
  return 'claude';
}

// One Claude Code transcript -> usage events. Claude Code writes one line per
// content block, each repeating the message's usage, so events are keyed by
// message ID and the most complete copy (largest output) wins.
export function parseClaudeFile(path) {
  const byId = new Map();
  forEachLine(path, (line, index) => {
    if (!line.includes('"usage"')) return;
    const record = parseJson(line);
    if (record?.type !== 'assistant') return;
    const message = record.message;
    const usage = message?.usage;
    if (!usage || !message.model || message.model === '<synthetic>') return;

    // cache_creation_input_tokens is the total; the breakdown (when present)
    // says how much of it went to the pricier 1-hour cache.
    const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
    const cacheWrite1h = Math.min(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0, cacheWriteTotal);
    const cacheWrite = cacheWriteTotal - cacheWrite1h;

    const event = {
      id: `claude:${message.id ?? record.requestId ?? `${path}#${index}`}`,
      source: claudeSource(message.id, message.model),
      ts: Date.parse(record.timestamp),
      model: message.model,
      input: usage.input_tokens ?? 0,
      cacheWrite,
      cacheWrite1h,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
      speed: usage.speed ?? null,
      serviceTier: usage.service_tier ?? null,
      geo: usage.inference_geo ?? null,
      project: record.cwd ?? null,
    };
    if (!Number.isFinite(event.ts)) return;

    const existing = byId.get(event.id);
    if (!existing || event.output > existing.output) byId.set(event.id, event);
  });
  return [...byId.values()];
}
