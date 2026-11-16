/**
 * browser-check.mjs — end-to-end verification in a real headless Chromium.
 *
 *   node tools/browser-check.mjs [baseUrl] [outDir]
 *
 * Two things are checked, both through the browser's own command line so there
 * is no DevTools protocol to drive:
 *
 *   1. tests/browser.html runs the in-page suite (real DOM, real worker) and
 *      writes its verdict into the DOM, which `--dump-dom` hands back.
 *   2. index.html is screenshotted in every theme and at a phone width, so the
 *      result can be inspected visually.
 *
 * `--virtual-time-budget` lets timers run fast, so the screenshots show a game
 * in progress rather than an empty board.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:8080/').replace(/\/?$/, '/');
const outDir = resolve(process.argv[3] ?? join(tmpdir(), 'reversi-shots'));

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const candidate of BROWSERS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium-based browser found. Install Chrome or Edge to run the browser checks.');
}

const browser = findBrowser();
mkdirSync(outDir, { recursive: true });

let failures = 0;

/**
 * Runs the browser once and returns whatever it printed.
 *
 * Output is redirected to a real file descriptor rather than a pipe: pipes are
 * unavailable in some sandboxed environments, while an inherited fd works
 * everywhere.
 */
function runBrowser({ url, profile, logFile, extraArgs = [], timeout = 120000, dump = false }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${profile}`,
    ...(dump ? ['--dump-dom'] : []),
    ...extraArgs,
    url,
  ];
  const fd = openSync(logFile, 'w');
  try {
    const result = spawnSync(browser, args, { timeout, stdio: ['ignore', fd, fd] });
    if (result.error) throw result.error;
  } finally {
    closeSync(fd);
  }
  const output = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  return { stdout: output, stderr: output };
}

function freshProfile(name) {
  return join(tmpdir(), `reversi-check-${name}-${Date.now()}`);
}

/* ------------------------------------------------------------------ */
/* 1. In-page test suite                                              */
/* ------------------------------------------------------------------ */

console.log('--- running tests/browser.html ---');
{
  const profile = freshProfile('suite');
  const logFile = join(tmpdir(), `reversi-suite-${Date.now()}.html`);
  const { stdout, stderr } = runBrowser({
    url: `${baseUrl}tests/browser.html`,
    profile,
    logFile,
    dump: true,
    extraArgs: ['--virtual-time-budget=60000'],
    timeout: 180000,
  });
  // --dump-dom prints the serialised DOM; the results live in the <pre>.
  const text = extractText(stdout, 'results');
  if (text === null) {
    failures++;
    console.log('FAIL could not find the results block in the dumped DOM.');
    const preview = stdout.slice(0, 400).replace(/\s+/g, ' ');
    console.log(`dom preview: ${preview}`);
  } else {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      console.log(line);
      if (line.startsWith('FAIL')) failures++;
    }
  }
  const consoleErrors = [...stderr.matchAll(/ERROR:CONSOLE\[[^\]]*\] "?([^"\n]*)"?/g)].map((match) => match[1]);
  const unique = [...new Set(consoleErrors)].filter((line) => line && !line.includes('favicon'));
  if (unique.length > 0) {
    failures += unique.length;
    for (const line of unique) console.log(`FAIL console error: ${line}`);
  }
  rmSync(profile, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 2. Screenshots                                                     */
/* ------------------------------------------------------------------ */

const SHOTS = [
  { name: '01-paper', query: '?theme=paper', size: '1280,900', budget: 2500 },
  { name: '02-midnight', query: '?theme=midnight', size: '1280,900', budget: 2500 },
  { name: '03-felt', query: '?theme=felt', size: '1280,900', budget: 2500 },
  { name: '04-mid-game', query: '?theme=paper&demo=24', size: '1280,1100', budget: 2500 },
  { name: '05-mobile', query: '?theme=midnight', size: '420,900', budget: 2500 },
];

console.log('\n--- screenshots ---');
for (const shot of SHOTS) {
  const profile = freshProfile(shot.name);
  const file = join(outDir, `${shot.name}.png`);
  runBrowser({
    url: `${baseUrl}${shot.query}`,
    profile,
    logFile: join(tmpdir(), `reversi-shot-${shot.name}.log`),
    extraArgs: [
      `--screenshot=${file}`,
      `--window-size=${shot.size}`,
      '--force-device-scale-factor=2',
      `--virtual-time-budget=${shot.budget}`,
    ],
  });
  const ok = existsSync(file);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
  rmSync(profile, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */

if (failures === 0) {
  console.log('\nAll browser checks passed.');
} else {
  console.log(`\n${failures} browser check(s) failed.`);
  process.exitCode = 1;
}

/** Pulls the text of `id` out of a dumped DOM document. */
function extractText(html, id) {
  const match = html.match(new RegExp(`<pre[^>]*id="${id}"[^>]*>([\\s\\S]*?)</pre>`, 'i'));
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

void readFileSync;
