import { PERIODS, fromDateKey, periodRange, toDateKey } from './lib/periods.js';

const SOURCE_IDS = ['codex', 'claude', 'bedrock'];
const REFRESH_MS = 30_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state

const state = readUrlState();
let summary = null;
let prices = null;
let inflight = null;
let modelSort = { key: 'total', dir: -1 };

function readUrlState() {
  const params = new URLSearchParams(location.search);
  const period = PERIODS.includes(params.get('period')) ? params.get('period') : 'day';
  const date = fromDateKey(params.get('date')) ? params.get('date') : null;
  const metric = params.get('metric') === 'cost' ? 'cost' : 'tokens';
  return { period, date, metric };
}

function writeUrlState() {
  const params = new URLSearchParams();
  if (state.period !== 'day') params.set('period', state.period);
  if (state.date) params.set('date', state.date);
  if (state.metric !== 'tokens') params.set('metric', state.metric);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

// ------------------------------------------------------------ formatting

function compact(n) {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs >= size) {
      const value = n / size;
      const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
      return `${value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1')}${suffix}`;
    }
  }
  return String(n);
}

function money(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: n >= 1000 ? 0 : 2,
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  })}`;
}

const fullNumber = (n) => Math.round(n).toLocaleString();
const percent = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');

function sourceMeta(id) {
  return summary?.sources.find((source) => source.id === id) ?? { id, label: id, plan: '' };
}

function sourceName(id) {
  const meta = sourceMeta(id);
  return `${meta.label} · ${meta.plan}`;
}

// ------------------------------------------------------------ DOM helper

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// ----------------------------------------------------------------- data

async function load({ force = false } = {}) {
  const params = new URLSearchParams({ period: state.period });
  if (state.date) params.set('date', state.date);
  if (force) params.set('refresh', '1');

  const controller = new AbortController();
  inflight?.abort();
  inflight = controller;
  $('content').classList.add('loading');
  try {
    const response = await fetch(`/api/summary?${params}`, { signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    summary = body;
    $('error').style.display = 'none';
    render();
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('error').textContent = `Could not load usage: ${error.message}`;
    $('error').style.display = 'block';
  } finally {
    if (inflight === controller) {
      inflight = null;
      $('content').classList.remove('loading');
    }
  }
}

async function loadPrices() {
  const response = await fetch('/api/prices');
  prices = await response.json();
  renderRates();
}

// --------------------------------------------------------------- render

function render() {
  renderControls();
  renderHero();
  renderKpis();
  renderSourceCards();
  renderChart();
  renderModels();
  renderRates();
  const scanned = new Date(summary.meta.scannedAt);
  $('updated').textContent = `Updated ${scanned.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

function renderControls() {
  for (const button of $('period-tabs').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === state.period));
  }
  for (const button of $('metric-tabs').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.metric === state.metric));
  }
  $('period-label').textContent = summary.label;
  $('prev').disabled = !summary.hasPrev;
  $('next').disabled = !summary.hasNext;
  $('prev').style.visibility = state.period === 'all' ? 'hidden' : 'visible';
  $('next').style.visibility = state.period === 'all' ? 'hidden' : 'visible';

  const current = $('current');
  current.hidden = state.period === 'all';
  current.textContent = { day: 'Today', week: 'This week', month: 'This month' }[state.period] ?? '';
  current.disabled = summary.isCurrent;
}

function renderHero() {
  const { totals } = summary;
  $('hero-cost').textContent = totals.cost.total >= 0.01 || !totals.cost.total
    ? `$${totals.cost.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '<$0.01';
  $('hero-tokens').textContent = compact(totals.tokens.total);
  $('hero-tokens').title = `${fullNumber(totals.tokens.total)} tokens`;
}

const TOKEN_TILES = [
  { key: 'input', label: 'Input', hint: 'Uncached input tokens' },
  { key: 'reasoning', label: 'Reasoning', hint: 'Reasoning/thinking tokens (part of output)' },
  { key: 'output', label: 'Output', hint: 'Output tokens, including reasoning' },
  { key: 'cacheWrite', label: 'Cache writes', hint: 'Tokens written to the prompt cache' },
  { key: 'cacheRead', label: 'Cache reads', hint: 'Input tokens served from the prompt cache' },
];

function renderKpis() {
  const { tokens, cost } = summary.totals;
  $('kpis').replaceChildren(...TOKEN_TILES.map(({ key, label, hint }) => el('div', { class: 'tile', title: hint }, [
    el('div', { class: 'tile-label', text: label }),
    el('div', { class: 'tile-figures' }, [
      tileFigure('Tokens', compact(tokens[key]), `${fullNumber(tokens[key])} tokens`),
      tileFigure('Cost', money(cost[key])),
      tileFigure('Of cost', percent(cost[key], cost.total)),
    ]),
  ])));
}

function tileFigure(label, value, title) {
  return el('div', { class: 'figure', title }, [
    el('div', { class: 'figure-label', text: label }),
    el('div', { class: 'tile-value', text: value }),
  ]);
}

function renderSourceCards() {
  $('source-cards').replaceChildren(...summary.sources.map((source) => {
    const data = summary.bySource[source.id];
    return el('div', { class: 'tile source-card' }, [
      el('div', { class: 'source-head' }, [
        el('span', { class: `swatch ${source.id}` }),
        source.label,
        el('span', { class: 'source-plan', text: source.plan }),
      ]),
      el('div', { class: 'source-figures' }, [
        el('div', { class: 'figure' }, [
          el('div', { class: 'source-label', text: 'Tokens' }),
          el('div', { class: 'source-value', text: compact(data.tokens.total), title: `${fullNumber(data.tokens.total)} tokens` }),
        ]),
        el('div', { class: 'figure' }, [
          el('div', { class: 'source-label', text: 'Cost' }),
          el('div', { class: 'source-value', text: money(data.cost.total) }),
        ]),
      ]),
    ]);
  }));
}

// ---------------------------------------------------------------- chart

function niceStep(max, targetTicks) {
  const raw = max / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function roundedTopBar(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function bucketTitle(start) {
  const date = new Date(start);
  if (state.period === 'day') {
    const end = new Date(date.getTime() + 3600_000);
    const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric' });
    return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmt(date)}–${fmt(end)}`;
  }
  if (state.period === 'all') return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function metricValue(cell) {
  return state.metric === 'cost' ? cell.cost : cell.tokens;
}

function formatMetric(value) {
  return state.metric === 'cost' ? money(value) : compact(value);
}

function formatAxis(value) {
  if (state.metric === 'tokens') return compact(value);
  if (value === 0) return '$0';
  return value < 1 ? `$${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}` : `$${compact(value)}`;
}

function renderChart() {
  const titles = { day: 'By hour', week: 'By day', month: 'By day', all: 'By month' };
  $('chart-title').textContent = `${titles[state.period]} · ${state.metric === 'cost' ? 'API-equivalent cost' : 'tokens'}`;

  const visible = SOURCE_IDS;
  $('chart-legend').replaceChildren(...visible.map((id) => el('span', {}, [
    el('span', { class: `swatch ${id}` }),
    sourceName(id),
  ])));

  const { buckets, series } = summary.chart;
  const stacks = buckets.map((bucket, i) => {
    const values = visible.map((id) => ({ id, value: metricValue(series[id][i]), cell: series[id][i] }));
    return { bucket, values, total: values.reduce((sum, v) => sum + v.value, 0) };
  });

  const container = $('chart');
  const width = Math.max(container.clientWidth, 320);
  const height = 260;
  const margin = { top: 22, right: 8, bottom: 26, left: 52 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  const maxTotal = Math.max(...stacks.map((s) => s.total), 0);
  const step = maxTotal > 0 ? niceStep(maxTotal, 4) : 1;
  const yMax = maxTotal > 0 ? Math.ceil(maxTotal / step) * step : 4;
  const y = (value) => margin.top + plotH - (value / yMax) * plotH;

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': $('chart-title').textContent });
  const grid = svg('g', { class: 'grid' });
  for (let tick = 0; tick <= yMax + step / 2; tick += step) {
    const ty = Math.round(y(tick)) + 0.5;
    if (tick > 0) grid.append(svg('line', { x1: margin.left, x2: width - margin.right, y1: ty, y2: ty }));
    const label = svg('text', { x: margin.left - 8, y: ty + 4, 'text-anchor': 'end' });
    label.textContent = formatAxis(tick);
    grid.append(label);
  }
  root.append(grid);

  const band = plotW / stacks.length;
  const barW = Math.max(2, Math.min(24, band * 0.68));
  const labelEvery = Math.max(1, Math.ceil(stacks.length / Math.max(1, Math.floor(plotW / 44))));
  const peak = stacks.reduce((best, s, i) => (s.total > (stacks[best]?.total ?? -1) ? i : best), 0);
  const GAP = 2;

  stacks.forEach((stack, i) => {
    const cx = margin.left + band * i + band / 2;
    const x = cx - barW / 2;
    let cursor = 0;
    const drawn = stack.values.filter((v) => v.value > 0);
    drawn.forEach((v, j) => {
      const top = y(cursor + v.value);
      const bottom = y(cursor);
      cursor += v.value;
      let segH = bottom - top;
      if (j > 0 && segH > GAP + 1) segH -= GAP; // surface gap between stacked segments
      if (segH < 0.5) return;
      const isTop = j === drawn.length - 1;
      root.append(isTop
        ? svg('path', { d: roundedTopBar(x, top, barW, segH, 4), class: `seg-${v.id}` })
        : svg('rect', { x, y: top, width: barW, height: segH, class: `seg-${v.id}` }));
    });

    if (i === peak && stack.total > 0) {
      const label = svg('text', { x: cx, y: y(stack.total) - 6, 'text-anchor': 'middle', class: 'value-label' });
      label.textContent = formatMetric(stack.total);
      root.append(label);
    }
    if (i % labelEvery === 0) {
      const tick = svg('text', { x: cx, y: height - 8, 'text-anchor': 'middle' });
      tick.textContent = stack.bucket.label;
      root.append(tick);
    }

    const hit = svg('rect', {
      class: 'hit',
      x: margin.left + band * i,
      y: margin.top,
      width: band,
      height: plotH,
      tabindex: '0',
      'aria-label': `${bucketTitle(stack.bucket.start)}: ${formatMetric(stack.total)}`,
    });
    const show = (event) => showChartTooltip(event, stack);
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('blur', hideTooltip);
    if (state.period !== 'day') {
      hit.style.cursor = 'pointer';
      const drill = () => drillInto(stack.bucket.start);
      hit.addEventListener('click', drill);
      hit.addEventListener('keydown', (event) => { if (event.key === 'Enter') drill(); });
    }
    root.append(hit);
  });

  const base = Math.round(y(0)) + 0.5;
  root.append(svg('line', { class: 'baseline', x1: margin.left, x2: width - margin.right, y1: base, y2: base }));

  if (maxTotal === 0) {
    const empty = svg('text', { x: margin.left + plotW / 2, y: margin.top + plotH / 2, 'text-anchor': 'middle', class: 'empty' });
    empty.textContent = 'No usage in this period';
    root.append(empty);
  }
  container.replaceChildren(root);
}

function showChartTooltip(event, stack) {
  const tooltip = $('tooltip');
  const rows = [...stack.values].sort((a, b) => b.value - a.value).map((v) => el('div', { class: 'tt-row' }, [
    el('span', { class: 'tt-key', style: `background: var(--series-${v.id})` }),
    el('span', { class: 'name', text: sourceName(v.id) }),
    el('strong', { text: formatMetric(v.value) }),
  ]));
  const cost = stack.values.reduce((sum, v) => sum + v.cell.cost, 0);
  const tokens = stack.values.reduce((sum, v) => sum + v.cell.tokens, 0);
  tooltip.replaceChildren(
    el('div', { class: 'tt-title', text: bucketTitle(stack.bucket.start) }),
    ...rows,
    el('div', { class: 'tt-row tt-total' }, [
      el('span'),
      el('span', { class: 'name', text: 'Total' }),
      el('strong', { text: `${compact(tokens)} · ${money(cost)}` }),
    ]),
  );
  tooltip.style.display = 'block';
  const rect = event.target.getBoundingClientRect();
  const anchorX = event.clientX ?? rect.left + rect.width / 2;
  const anchorY = event.clientY ?? rect.top + rect.height / 3;
  const { offsetWidth: w, offsetHeight: h } = tooltip;
  let left = anchorX + 14;
  if (left + w > window.innerWidth - 8) left = anchorX - w - 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, Math.min(anchorY - h / 2, window.innerHeight - h - 8))}px`;
}

function hideTooltip() {
  $('tooltip').style.display = 'none';
}

function drillInto(startIso) {
  const date = new Date(startIso);
  state.period = state.period === 'all' ? 'month' : 'day';
  state.date = toDateKey(date);
  changed();
}

// ---------------------------------------------------------- model table

const TOKEN_KEYS = ['input', 'reasoning', 'output', 'cacheWrite', 'cacheRead'];

function tokenCell(tokens, cost, priced = true) {
  return el('td', { title: `${fullNumber(tokens)} tokens` }, [
    compact(tokens),
    el('span', { class: 'sub', text: priced ? money(cost) : '–' }),
  ]);
}

function shareCell(part, total) {
  return el('td', {}, el('div', { class: 'share' }, [
    percent(part, total),
    el('span', { class: 'share-track' }, el('span', {
      class: 'share-fill',
      style: `width: ${total ? (part / total) * 100 : 0}%`,
    })),
  ]));
}

// Column order is defined once; header, rows and the totals row follow it.
// `value` makes a column sortable.
const MODEL_COLUMNS = [
  {
    key: 'name',
    label: 'Model',
    value: (m) => m.name.toLowerCase(),
    cell: (m) => el('td', {}, [
      el('span', { class: 'model-name', text: m.name }),
      el('span', { class: 'model-source' }, [el('span', { class: `swatch ${m.source}` }), sourceName(m.source)]),
    ]),
    foot: () => el('td', { text: 'Total' }),
  },
  {
    key: 'total',
    label: 'Total tokens',
    value: (m) => m.tokens.total,
    cell: (m) => el('td', { text: compact(m.tokens.total), title: `${fullNumber(m.tokens.total)} tokens` }),
    foot: (t) => el('td', { text: compact(t.tokens.total), title: `${fullNumber(t.tokens.total)} tokens` }),
  },
  {
    key: 'cost',
    label: 'Cost',
    value: (m) => m.cost.total,
    cell: (m) => el('td', { text: m.priced ? money(m.cost.total) : '–', title: m.priced ? `$${m.cost.total.toFixed(4)}` : m.unpricedNote }),
    foot: (t) => el('td', { text: money(t.cost.total) }),
  },
  {
    key: 'requests',
    label: 'Responses',
    value: (m) => m.requests,
    cell: (m) => el('td', { text: fullNumber(m.requests) }),
    foot: (t) => el('td', { text: fullNumber(t.requests) }),
  },
  ...TOKEN_KEYS.map((key) => ({
    key,
    label: { input: 'Input', cacheWrite: 'Cache write', cacheRead: 'Cache read', output: 'Output', reasoning: 'Reasoning' }[key],
    value: (m) => m.tokens[key],
    cell: (m) => tokenCell(m.tokens[key], m.cost[key], m.priced),
    foot: (t) => tokenCell(t.tokens[key], t.cost[key]),
  })),
  {
    key: 'tokenShare',
    label: 'Token share',
    cell: (m, t) => shareCell(m.tokens.total, t.tokens.total),
    foot: () => el('td'),
  },
  {
    key: 'costShare',
    label: 'Cost share',
    cell: (m, t) => shareCell(m.cost.total, t.cost.total),
    foot: () => el('td'),
  },
];

function renderModels() {
  const { models, totals } = summary;
  const column = MODEL_COLUMNS.find((c) => c.key === modelSort.key);
  const sorted = [...models].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);
    return (av < bv ? -1 : av > bv ? 1 : 0) * modelSort.dir;
  });

  const head = el('tr', {}, MODEL_COLUMNS.map((c) => el('th', {}, c.value ? el('button', {
    type: 'button',
    'aria-sort': c.key === modelSort.key ? (modelSort.dir < 0 ? 'descending' : 'ascending') : null,
    onclick: () => {
      modelSort = c.key === modelSort.key ? { key: c.key, dir: -modelSort.dir } : { key: c.key, dir: c.key === 'name' ? 1 : -1 };
      renderModels();
    },
  }, [c.label, c.key === modelSort.key ? (modelSort.dir < 0 ? ' ↓' : ' ↑') : '']) : c.label)));

  const rows = sorted.map((m) => el('tr', {}, MODEL_COLUMNS.map((c) => c.cell(m, totals))));
  const body = rows.length
    ? rows
    : [el('tr', { class: 'empty-row' }, el('td', { colspan: MODEL_COLUMNS.length, text: 'No usage in this period' }))];
  const foot = el('tr', {}, MODEL_COLUMNS.map((c) => c.foot(totals)));

  $('models').replaceChildren(el('table', {}, [el('thead', {}, head), el('tbody', {}, body), el('tfoot', {}, foot)]));
}

// ----------------------------------------------------------- rates table

function rate(value) {
  if (value === undefined || value === null) return '–';
  return `$${value < 0.1 ? value.toFixed(3).replace(/0+$/, '') : value.toFixed(2)}`;
}

function renderRates() {
  if (!prices || !summary) return;
  const inUse = new Set(summary.models.map((m) => m.model));
  const sourceLink = (label, href) => el('a', { href, target: '_blank', rel: 'noreferrer', text: label });
  $('rates-notes').replaceChildren(
    el('p', {}, [
      `USD per million tokens, checked ${prices.checkedAt}. Sources: `,
      sourceLink('Anthropic', prices.sources.anthropic), ', ',
      sourceLink('OpenAI', prices.sources.openai), ', ',
      sourceLink('AWS Bedrock', prices.sources.bedrock), '. Edit prices.json to change them.',
    ]),
    el('p', { text: `Codex and Claude Code plan usage is shown at API list prices (what the same usage would cost on the API), not what the plan charges.` }),
    el('p', { text: `Bedrock: ×${prices.providers.bedrock.multiplier}. ${prices.providers.bedrock.note}` }),
    el('p', { text: 'Long-context rates apply per request when its prompt exceeds the threshold. Fast/priority multipliers apply only when a response reports that tier.' }),
    ...Object.entries(prices.unpriced ?? {}).map(([model, note]) => el('p', {}, [el('strong', { text: `${model}: ` }), note])),
  );

  const models = Object.entries(prices.models).sort(([a], [b]) => Number(inUse.has(b)) - Number(inUse.has(a)));
  const head = el('tr', {}, ['Model', 'Input', 'Cache write', '1h cache write', 'Cache read', 'Output', 'Long context', 'Modifiers']
    .map((label) => el('th', { text: label })));
  const rows = models.map(([key, m]) => {
    const long = m.longContext
      ? `>${compact(m.longContext.threshold)}: ${rate(m.longContext.input)} in / ${rate(m.longContext.output)} out`
      : '–';
    const modifiers = [
      m.fastMultiplier && `fast ×${m.fastMultiplier}`,
      m.priorityMultiplier && `priority ×${m.priorityMultiplier}`,
      m.legacyRegionalPricing && 'no Bedrock regional premium',
    ].filter(Boolean).join(', ') || '–';
    return el('tr', { class: inUse.has(key) ? 'in-use' : null }, [
      el('td', { text: m.name, title: key }),
      el('td', { text: rate(m.input) }),
      el('td', { text: rate(m.cacheWrite) }),
      el('td', { text: rate(m.cacheWrite1h) }),
      el('td', { text: rate(m.cacheRead) }),
      el('td', { text: rate(m.output) }),
      el('td', { text: long }),
      el('td', { text: modifiers }),
    ]);
  });
  $('rates-table').replaceChildren(el('table', {}, [el('thead', {}, head), el('tbody', {}, rows)]));
}

// --------------------------------------------------------------- events

function changed() {
  writeUrlState();
  load();
}

// Stepping into the current period drops the explicit date so the view keeps
// following "now" (for example across midnight).
function step(direction) {
  if (!summary || state.period === 'all') return;
  if (direction < 0 ? !summary.hasPrev : !summary.hasNext) return;
  const target = direction < 0 ? summary.prevAnchor : summary.nextAnchor;
  const targetStart = periodRange(state.period, fromDateKey(target)).start.getTime();
  const currentStart = periodRange(state.period, new Date()).start.getTime();
  state.date = targetStart === currentStart ? null : target;
  changed();
}

$('period-tabs').addEventListener('click', (event) => {
  const period = event.target.closest('button')?.dataset.period;
  if (!period || period === state.period) return;
  state.period = period;
  changed();
});

$('metric-tabs').addEventListener('click', (event) => {
  const metric = event.target.closest('button')?.dataset.metric;
  if (!metric || metric === state.metric) return;
  state.metric = metric;
  writeUrlState();
  render();
});

$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('current').addEventListener('click', () => {
  state.date = null;
  changed();
});
$('refresh').addEventListener('click', () => load({ force: true }));

document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => summary && renderChart(), 120);
});

setInterval(() => {
  if (document.visibilityState === 'visible' && !inflight) load();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

load();
loadPrices();
