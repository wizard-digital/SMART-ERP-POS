/**
 * Prove dist/index.html can boot on Chrome 62 and on a current engine.
 *
 * Chrome 62: ES5 boot + one legacy script parsed as ES2018 (no import() / import.meta).
 * Current engines: the split scripts parse as ES2020.
 *
 * Usage: node scripts/proof-sunmi-webview62-syntax.mjs [distDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

const distDir = path.resolve(process.argv[2] || 'dist');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function parseFile(rel, text, ecmaVersion, sourceType) {
  try {
    parse(text, { ecmaVersion, sourceType, allowReturnOutsideFunction: true });
    return null;
  } catch (err) {
    return {
      file: rel,
      line: err.loc ? err.loc.line : null,
      column: err.loc ? err.loc.column : null,
      message: err.message,
    };
  }
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const bootMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const failures = [];
let executedEngine = null;
let executedSrc = null;
let forcedSrc = null;
if (!bootMatch) {
  failures.push({ file: 'index.html', line: null, column: null, message: 'boot script missing' });
} else {
  const bootFailure = parseFile('index.html#boot', bootMatch[1], 5, 'script');
  if (bootFailure) failures.push(bootFailure);
  const created = [];
  const sandbox = {
    console,
    window: {},
    Promise,
    Object,
    Array,
    String,
    Symbol,
    TypeError,
    RegExp,
    document: {
      head: { appendChild(node) { created.push(node); } },
      createElement() { return {}; },
    },
    location: { search: '' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bootMatch[1], sandbox, { filename: 'index.html' });
  const scriptEl = created.find((node) => typeof node.src === 'string');
  executedSrc = scriptEl ? scriptEl.src : null;
  const log = bootMatch[1].includes('SMART_ERP_ENGINE') ? 'ran' : 'missing-log';
  executedEngine = executedSrc && executedSrc.indexOf('/assets/legacy-') === 0 ? 'legacy' : (executedSrc ? 'modern' : null);
  if (log !== 'ran') failures.push({ file: 'index.html', message: 'boot did not emit SMART_ERP_ENGINE' });
  if (!executedSrc) failures.push({ file: 'index.html', message: 'executed boot did not set a script src' });
  const forced = [];
  const legacySandbox = {
    ...sandbox,
    location: { search: '?engine=legacy' },
    document: {
      head: { appendChild(node) { forced.push(node); } },
      createElement() { return {}; },
    },
  };
  legacySandbox.window = legacySandbox;
  vm.runInNewContext(bootMatch[1], legacySandbox, { filename: 'index.html?engine=legacy' });
  forcedSrc = (forced.find((node) => typeof node.src === 'string') || {}).src || null;
}

const modernJs = html.match(/"(\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
const legacyJs = html.match(/"(\/assets\/legacy-index-[^"]+\.js)"/)?.[1] ?? null;
if (!modernJs) failures.push({ file: 'index.html', message: 'modern script path missing' });
if (!legacyJs) failures.push({ file: 'index.html', message: 'legacy script path missing' });

const files = walk(distDir);
let legacyImport = 0;
let legacyImportMeta = 0;
const entryBytes = {};

for (const file of files) {
  const rel = path.relative(distDir, file).replaceAll('\\', '/');
  const text = fs.readFileSync(file, 'utf8');
  const legacy = rel.startsWith('assets/legacy-');
  const failure = parseFile(rel, text, legacy || rel === 'sw.js' ? 2018 : 2022, rel === 'sw.js' ? 'script' : 'module');
  if (failure) failures.push(failure);
  if (legacy) {
    legacyImport += (text.match(/\bimport\(/g) || []).length;
    legacyImportMeta += (text.match(/import\.meta/g) || []).length;
    entryBytes[rel] = fs.statSync(file).size;
  }
}

if (modernJs) {
  const rel = modernJs.replace(/^\//, '');
  const full = path.join(distDir, rel);
  if (fs.existsSync(full)) entryBytes[rel] = fs.statSync(full).size;
  else failures.push({ file: rel, message: 'modern entry missing on disk' });
}

const result = {
  provedAt: new Date().toISOString(),
  distDir,
  parser: 'boot ES5; legacy acorn ES2018; modern acorn ES2022 (class fields Chrome 72+)',
  fileCount: files.length,
  modernJs,
  legacyJs,
  executedOnCurrentEngine: { engine: executedEngine, src: executedSrc },
  executedWhenForcedLegacy: forcedSrc,
  entryBytes,
  legacyImport,
  legacyImportMeta,
  failureCount: failures.length,
  failures: failures.slice(0, 40),
  device: {
    serial: 'VB52217622413',
    model: 'V2',
    android: '7.1.1',
    webView: '62.0.3202.84',
    liveScript: 'https://wizarddigital-inv.com/assets/index-DNNao3Gg.js',
    liveConsole: 'Uncaught SyntaxError: Unexpected token .',
    liveCaptured: '2026-10-01T05:24:14+03:00',
  },
  pass: failures.length === 0 && legacyImport === 0 && legacyImportMeta === 0 && Boolean(modernJs) && Boolean(legacyJs) && executedEngine === 'modern' && executedSrc === modernJs && forcedSrc === legacyJs,
};

const outPath = path.resolve(distDir, '..', '..', 'PROOF_SUNMI_WEBVIEW62_SYNTAX.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  pass: result.pass,
  fileCount: result.fileCount,
  failureCount: result.failureCount,
  modernJs,
  legacyJs,
  executedEngine,
  executedSrc,
  legacyImport,
  legacyImportMeta,
}, null, 2));
if (!result.pass) process.exit(1);
