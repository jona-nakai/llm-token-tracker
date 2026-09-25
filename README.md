# LLM token tracker

A local dashboard of the tokens you spend on this machine through three sources:

- **Codex (ChatGPT plan).** Read from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- **Claude Code (Claude plan).** Read from `~/.claude/projects` (and `~/.config/claude/projects`).
- **Claude Code (AWS Bedrock).** Read from the same transcripts. Bedrock responses are recognized by their `msg_bdrk_` message IDs.

For today, a Monday–Sunday week, a month, or all time (with prev/next navigation), it shows:
- Token counts, split into uncached input, cache writes, cache reads, output, and reasoning.
- Each model's usage.
- The API-equivalent cost of that usage.

Nothing is sent anywhere: the server only reads local log files and listens on `127.0.0.1`.

## Run it

```sh
npm start          # http://127.0.0.1:4317
```

It needs Node 20 or newer and has no dependencies to install. The first start indexes every log file, which takes about a second here. After that, only files whose size or mtime changed are re-read. The page refreshes every 30 seconds.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_CONFIG_DIR` | `~/.config/claude,~/.claude` | Comma-separated Claude Code config dirs |
| `CODEX_HOME` | `~/.codex` | Codex home |
| `BEDROCK_PRICE_MULTIPLIER` | `1.1` | Bedrock premium over Anthropic list price (see below) |
| `INDEX_INTERVAL_MS` | `300000` | How often logs are re-indexed in the background |

### Start at login (macOS)

```sh
npm run service:install     # LaunchAgent: starts at login, restarts if it exits
npm run service:status
npm run service:uninstall
```

The agent (`~/Library/LaunchAgents/local.llm-token-tracker.plist`) runs `src/server.js` from this folder with the Node binary that ran the install command. Logs go to `~/Library/Logs/llm-token-tracker.log`.
- Re-run `service:install` after moving this folder or switching Node versions (for example with nvm). It also picks up any of the env vars above that are set at install time.
- While the service is running, `npm start` reports the port as in use. Uninstall the service first if you want to run it in a terminal.

The service re-indexes every 5 minutes even when no browser is open. That keeps capturing Claude Code transcripts before they are pruned.

Controls:
- `←` / `→` step through periods.
- Clicking a bar drills down: from a month or week into that day, from all time into that month.
- The URL keeps the current view, so you can bookmark a view.

## How tokens are counted

| Column | Claude Code | Codex |
|---|---|---|
| Input | `input_tokens` | `input_tokens − cached_input_tokens − cache_write_input_tokens` |
| Cache write | `cache_creation_input_tokens` (5-minute and 1-hour TTLs priced separately) | `cache_write_input_tokens` |
| Cache read | `cache_read_input_tokens` | `cached_input_tokens` |
| Output | `output_tokens` | `output_tokens` |
| Reasoning | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens` |

On both platforms, output already includes reasoning. Reasoning is shown on its own but is never added to totals a second time.

- **Claude Code** writes one transcript line per content block, each repeating the response's usage. Events are therefore keyed by message ID, and the same ID seen in resumed or sub-agent transcripts counts once.
- **Codex:** newer rollouts log a `token_usage_record` per response, keyed by `response_id`, and those are used when present. Older rollouts only log running totals (`token_count`), and a response is counted when the total changes. Forked and guardian sub-agent rollouts replay their parent's last total before their first turn; that replay is skipped.

Claude Code deletes transcripts older than 30 days by default (`cleanupPeriodDays`). The index in `.cache/index.json` keeps responses from deleted files, so all-time totals don't shrink. Deleting `.cache/` rebuilds the index from whatever logs still exist.

## How cost is computed

Rates are in `prices.json` (USD per 1M tokens, checked 2026-09-25):
- Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing).
- OpenAI's [pricing docs](https://developers.openai.com/api/docs/pricing).
- Cross-checked against LiteLLM's price table.

Pricing rules:
- Plan usage (Codex, Claude Code on a Claude plan) is shown at **API list prices**, which is what the same usage would cost on the API. It is not what the plan charges you.
- **Bedrock:** Claude Code is configured with a `us.anthropic.*` inference profile. On Bedrock, that is a regional endpoint, which costs 10% more than global endpoints for Claude 4.5 and later models. Set `BEDROCK_PRICE_MULTIPLIER=1` if you switch to `global.*` profiles.
- **Long context:** when a single request's prompt exceeds a model's threshold, the long-context rate applies to that request. For GPT-6 / GPT-5.6 / GPT-5.5 / GPT-5.4 the threshold is 272K; for Claude Sonnet 4.5 and 4 it is 200K.
- **Fast mode and priority tier:** Claude fast mode (2×) and Codex's priority ("Fast") tier multipliers apply only to responses that report that mode or tier.
- **`codex-auto-review`** is Codex's hidden approval-review model and has no public API price. Its tokens are counted and its cost is left out, and the UI marks it "no API price". To estimate it, add an alias to `prices.json`:
  ```json
  "aliases": { "codex-auto-review": "gpt-5.6-sol" }
  ```

Edits to `prices.json` take effect on the next refresh. To see whether published rates have moved:

```sh
npm run check-prices   # compares prices.json with LiteLLM's table; writes nothing
```

## Development

```sh
npm test
```

Layout:
- `src/parsers/` turns log files into usage events.
- `src/pricing.js` prices them.
- `src/store.js` handles incremental indexing and dedup.
- `src/aggregate.js` builds the period summaries.
- `public/` is the dashboard. `public/lib/periods.js` holds the period math, shared by the server and the browser.
