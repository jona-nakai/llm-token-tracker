// Installs the dashboard as a macOS LaunchAgent so it starts at login and is
// restarted if it exits.  Usage: node scripts/service.js install|uninstall|status
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.llm-token-tracker';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library', 'Logs', 'llm-token-tracker.log');
const DOMAIN = `gui/${userInfo().uid}`;
const PORT = Number(process.env.PORT) || 4317;

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
  // The absolute Node path matters: launchd starts agents without your shell
  // PATH (nvm, Homebrew). Re-run install after switching Node versions.
  const env = { PORT: String(PORT) };
  for (const key of ['HOST', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'BEDROCK_PRICE_MULTIPLIER', 'INDEX_INTERVAL_MS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(ROOT, 'src', 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isLoaded() {
  try {
    launchctl('print', `${DOMAIN}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
}

function unload() {
  if (isLoaded()) launchctl('bootout', `${DOMAIN}/${LABEL}`);
}

function portOwner() {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/summary?period=day`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function install() {
  unload();
  const owner = portOwner();
  if (owner) {
    console.error(`Port ${PORT} is in use by process ${owner}. Stop it first (for example the terminal running npm start), then retry.`);
    process.exit(1);
  }
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'Logs'), { recursive: true });
  writeFileSync(PLIST, plist());
  launchctl('bootstrap', DOMAIN, PLIST);
  if (await waitForServer()) {
    console.log(`Installed. The dashboard starts at login: http://127.0.0.1:${PORT}`);
  } else {
    console.error(`Installed, but the server did not answer on port ${PORT}. Check ${LOG}`);
    process.exit(1);
  }
  console.log(`Agent: ${PLIST}\nLog:   ${LOG}`);
}

function uninstall() {
  unload();
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log('Uninstalled. The dashboard no longer starts at login.');
}

function status() {
  if (!isLoaded()) {
    console.log(existsSync(PLIST) ? `Installed at ${PLIST} but not loaded.` : 'Not installed.');
    return;
  }
  const info = launchctl('print', `${DOMAIN}/${LABEL}`);
  const field = (name) => info.match(new RegExp(`^\\s*${name} = (.*)$`, 'm'))?.[1];
  const lastExit = field('last exit code') ?? field('last terminating signal') ?? 'none';
  console.log(`Loaded: state ${field('state') ?? '?'}, pid ${field('pid') ?? '-'}, runs ${field('runs') ?? '?'}, last exit ${lastExit}`);
  console.log(`URL:    http://127.0.0.1:${PORT}\nLog:    ${LOG}`);
}

const command = process.argv[2];
if (process.platform !== 'darwin') {
  console.error('The login service uses launchd and is macOS only.');
  process.exit(1);
}
if (command === 'install') await install();
else if (command === 'uninstall') uninstall();
else if (command === 'status') status();
else {
  console.error('Usage: node scripts/service.js install|uninstall|status');
  process.exit(1);
}
