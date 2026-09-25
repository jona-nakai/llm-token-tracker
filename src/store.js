import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseClaudeFile } from './parsers/claude.js';
import { parseCodexFile } from './parsers/codex.js';
import { costEvent, loadPrices } from './pricing.js';

const CACHE_VERSION = 2;
const MIN_REFRESH_MS = 3000;

export function defaultRoots(env = process.env, home = homedir()) {
  const claudeConfigDirs = env.CLAUDE_CONFIG_DIR
    ? env.CLAUDE_CONFIG_DIR.split(',').map((dir) => dir.trim()).filter(Boolean)
    : [join(home, '.config', 'claude'), join(home, '.claude')];
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  return {
    claude: claudeConfigDirs.map((dir) => join(dir, 'projects')),
    codex: [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')],
  };
}

function listJsonl(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(root);
  return files;
}

export class UsageStore {
  constructor({ roots = defaultRoots(), pricesPath, cachePath }) {
    this.roots = roots;
    this.pricesPath = pricesPath;
    this.cachePath = cachePath;
    this.files = new Map();
    this.prices = null;
    this.pricesMtime = 0;
    this.merged = [];
    this.lastRefresh = 0;
    this.scannedAt = null;
    this.loadCache();
  }

  loadCache() {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try {
      const cache = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      if (cache.version !== CACHE_VERSION) return;
      for (const [path, entry] of Object.entries(cache.files)) this.files.set(path, entry);
    } catch {
      this.files.clear();
    }
  }

  saveCache() {
    if (!this.cachePath) return;
    mkdirSync(dirname(this.cachePath), { recursive: true });
    const files = Object.fromEntries(this.files);
    // Write-then-rename so a crash mid-write never leaves a truncated index,
    // which matters because the index is the only copy of pruned transcripts.
    const temp = `${this.cachePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, files }));
    renameSync(temp, this.cachePath);
  }

  // Re-parses only files whose size or mtime changed since the last scan.
  refresh({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastRefresh < MIN_REFRESH_MS && this.prices) return false;
    this.lastRefresh = now;

    const pricesMtime = statSync(this.pricesPath).mtimeMs;
    const pricesChanged = pricesMtime !== this.pricesMtime;
    if (pricesChanged) {
      this.prices = loadPrices(this.pricesPath);
      this.pricesMtime = pricesMtime;
    }

    const seen = new Set();
    let filesChanged = false;
    const scan = (kind, parse) => {
      for (const root of this.roots[kind]) {
        for (const path of listJsonl(root)) {
          seen.add(path);
          let stat;
          try {
            stat = statSync(path);
          } catch {
            continue;
          }
          const cached = this.files.get(path);
          if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            if (cached.deleted) {
              delete cached.deleted;
              filesChanged = true;
            }
            continue;
          }
          let events;
          try {
            events = parse(path);
          } catch (error) {
            console.warn(`Skipping ${path}: ${error.message}`);
            events = [];
          }
          this.files.set(path, { kind, size: stat.size, mtimeMs: stat.mtimeMs, events });
          filesChanged = true;
        }
      }
    };
    scan('claude', parseClaudeFile);
    scan('codex', parseCodexFile);

    // Claude Code prunes old transcripts (cleanupPeriodDays, 30 by default).
    // Their events stay in the cache so all-time totals never shrink.
    for (const [path, entry] of this.files) {
      if (!seen.has(path) && !entry.deleted) {
        entry.deleted = true;
        filesChanged = true;
      }
    }

    if (filesChanged) this.saveCache();
    if (filesChanged || pricesChanged || !this.scannedAt) this.merge();
    this.scannedAt = new Date(now);
    return filesChanged;
  }

  // The same response can appear in several files (resumed sessions, forked
  // threads, archived copies); IDs are global, so keep one copy of each.
  merge() {
    const byId = new Map();
    const paths = [...this.files.keys()].sort();
    for (const path of paths) {
      for (const event of this.files.get(path).events) {
        const existing = byId.get(event.id);
        if (!existing || event.output > existing.output) byId.set(event.id, event);
      }
    }
    this.merged = [...byId.values()]
      .map((event) => ({ ...event, ...costEvent(this.prices, event) }))
      .sort((a, b) => a.ts - b.ts);
  }

  events() {
    return this.merged;
  }

  stats() {
    let claudeFiles = 0;
    let codexFiles = 0;
    let retainedFiles = 0;
    for (const entry of this.files.values()) {
      if (entry.deleted) retainedFiles += 1;
      else if (entry.kind === 'claude') claudeFiles += 1;
      else codexFiles += 1;
    }
    return { claudeFiles, codexFiles, retainedFiles, events: this.merged.length, scannedAt: this.scannedAt };
  }
}
