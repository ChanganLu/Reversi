/**
 * audit.mjs — static consistency checks across HTML, CSS and JS.
 *
 *   node tools/audit.mjs
 *
 * A browser is the only way to be sure the UI *looks* right, but a surprising
 * number of UI bugs are really wiring mistakes: an id that no longer exists, a
 * class the CSS never defines, a `var(--token)` nobody sets, an import path that
 * 404s on GitHub Pages. This tool checks all of those without a browser, and it
 * is part of the pre-commit routine.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const problems = [];
const notes = [];

/** Recursively collects files with one of the given extensions. */
async function collect(directory, extensions, out = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git') || entry.name === '.npm-cache') {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, extensions, out);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
}

const jsFiles = await collect(join(root, 'js'), ['.js']);
const cssFiles = await collect(join(root, 'css'), ['.css']);
const htmlFiles = (await collect(join(root, 'tests'), ['.html'])).concat([join(root, 'index.html')]);

const html = await fs.readFile(join(root, 'index.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* 1. Import graph                                                     */
/* ------------------------------------------------------------------ */

for (const file of jsFiles) {
  const source = await fs.readFile(file, 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g),
  ].map((match) => match[1]);

  for (const specifier of specifiers) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue; // bare import
    const target = resolve(dirname(file), specifier);
    if (!existsSync(target)) {
      problems.push(`${relative(root, file)}: import "${specifier}" does not resolve`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Element ids referenced from JS exist in the HTML                 */
/* ------------------------------------------------------------------ */

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
for (const file of jsFiles) {
  const source = await fs.readFile(file, 'utf8');
  for (const match of source.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!htmlIds.has(match[1])) {
      problems.push(`${relative(root, file)}: getElementById("${match[1]}") has no matching element`);
    }
  }
  // querySelector('#id') and querySelectorAll('#id ...')
  for (const match of source.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)/g)) {
    if (!htmlIds.has(match[1])) {
      problems.push(`${relative(root, file)}: selector "#${match[1]}" has no matching element`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Classes used from JS are styled somewhere                        */
/* ------------------------------------------------------------------ */

const cssText = (await Promise.all(cssFiles.map((file) => fs.readFile(file, 'utf8')))).join('\n');
const htmlFileText = await fs.readFile(join(root, 'index.html'), 'utf8');
const styledClasses = new Set();
for (const match of (cssText + htmlFileText).matchAll(/\.([a-z][a-z0-9-]*)/gi)) {
  styledClasses.add(match[1]);
}

/** Classes deliberately state-only (no visual rule needed). */
const INTENTIONAL = new Set([
  // state hooks that only drive behaviour
  'is-black',
  'is-white',
  'is-current',
  'is-playable',
  // targeted by JS, styled through their colour modifier
  'face-a',
  'face-b',
]);

const usedClasses = new Set();
/** Adds every plausible class token found in `text` to the set. */
function collectClasses(text) {
  const withoutExpressions = text.replace(/\$\{[^}]*\}/g, ' ');
  for (const token of withoutExpressions.split(/[\s'"`,]+/)) {
    if (!/^[a-z][a-z0-9-]*$/.test(token)) continue;
    usedClasses.add(token);
  }
}

for (const file of jsFiles) {
  const source = await fs.readFile(file, 'utf8');
  // classList.add/remove/toggle('a', 'b', condition)
  for (const match of source.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) collectClasses(literal[1]);
  }
  // className = '...' and class="..."
  for (const match of source.matchAll(/className\s*=\s*['"`]([^'"`]+)['"`]/g)) collectClasses(match[1]);
  for (const match of source.matchAll(/class="([^"]+)"/g)) collectClasses(match[1]);
}

for (const className of usedClasses) {
  if (styledClasses.has(className)) continue;
  if (INTENTIONAL.has(className)) continue;
  notes.push(`class "${className}" is used from JS but never styled`);
}

/* ------------------------------------------------------------------ */
/* 4. Every CSS custom property that is read is also written          */
/* ------------------------------------------------------------------ */

const defined = new Set([...cssText.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
const used = new Set();
for (const match of cssText.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
  if (match[2] === ',') continue; // var(--x, fallback) is safe
  used.add(match[1]);
}
for (const token of used) {
  if (defined.has(token)) continue;
  // Theme tokens are all declared in themes.css; anything else is a typo.
  problems.push(`css: var(${token}) is used but never defined`);
}

/* ------------------------------------------------------------------ */
/* 5. Referenced assets exist                                          */
/* ------------------------------------------------------------------ */

for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const target = match[1];
  if (/^(https?:|data:|#|mailto:)/.test(target)) continue;
  if (!existsSync(resolve(root, target))) {
    problems.push(`index.html: referenced asset "${target}" is missing`);
  }
}

/* ------------------------------------------------------------------ */

console.log(`checked ${jsFiles.length} JS files, ${cssFiles.length} CSS files`);
if (notes.length > 0) {
  console.log('\nnotes:');
  for (const note of notes) console.log(` - ${note}`);
}
if (problems.length === 0) {
  console.log('\nNo wiring problems found.');
} else {
  console.log('\nProblems:');
  for (const problem of problems) console.log(` - ${problem}`);
  process.exitCode = 1;
}
