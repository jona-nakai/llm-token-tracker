import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, summarize } from './aggregate.js';
import { UsageStore } from './store.js';
import { PERIODS, fromDateKey } from '../public/lib/periods.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
// Re-index in the background so usage is captured (and survives Claude Code's
// transcript cleanup) even when nobody has the dashboard open.
const INDEX_INTERVAL_MS = Number(process.env.INDEX_INTERVAL_MS) || 5 * 60_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const store = new UsageStore({
  pricesPath: join(ROOT, 'prices.json'),
  cachePath: join(ROOT, '.cache', 'index.json'),
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': CONTENT_TYPES['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handleSummary(url, res) {
  const period = url.searchParams.get('period') ?? 'day';
  if (!PERIODS.includes(period)) return sendJson(res, 400, { error: `Unknown period "${period}"` });

  const now = new Date();
  const dateParam = url.searchParams.get('date');
  const anchor = dateParam ? fromDateKey(dateParam) : now;
  if (!anchor) return sendJson(res, 400, { error: `Bad date "${dateParam}", expected YYYY-MM-DD` });

  const sourceParam = url.searchParams.get('sources');
  const sources = sourceParam === null
    ? SOURCES.map((source) => source.id)
    : sourceParam.split(',').filter((id) => SOURCES.some((source) => source.id === id));

  store.refresh({ force: url.searchParams.has('refresh') });
  const summary = summarize(store.events(), { period, anchor, sources, now, prices: store.prices });
  sendJson(res, 200, { ...summary, meta: store.stats() });
}

function handlePrices(res) {
  store.refresh();
  const { checkedAt, sources, providers, models, aliases, unpriced } = store.prices;
  sendJson(res, 200, { checkedAt, sources, providers, models, aliases, unpriced });
}

async function handleStatic(url, res) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(PUBLIC_DIR, relative));
  if (!path.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (url.pathname === '/api/summary') return handleSummary(url, res);
    if (url.pathname === '/api/prices') return handlePrices(res);
    return await handleStatic(url, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message });
    else res.end();
  }
});

const started = Date.now();
store.refresh({ force: true });
const stats = store.stats();
console.log(`Indexed ${stats.events} responses from ${stats.claudeFiles} Claude Code and ${stats.codexFiles} Codex files in ${Date.now() - started} ms`);

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Port ${PORT} is already in use; the dashboard may already be running at http://${HOST}:${PORT}.`);
  console.error(`Stop the other process (lsof -nP -iTCP:${PORT} -sTCP:LISTEN) or pick another port: PORT=4318 npm start`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`LLM token dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

setInterval(() => {
  try {
    if (store.refresh()) console.log(`${new Date().toISOString()} indexed ${store.stats().events} responses`);
  } catch (error) {
    console.error(`Background index failed: ${error.message}`);
  }
}, INDEX_INTERVAL_MS);
