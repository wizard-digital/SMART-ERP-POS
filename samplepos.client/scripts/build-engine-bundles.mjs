/**
 * One publish, two scripts. The page picks with engineBoot.mjs.
 * Modern engines get the split Chrome 80 build. Older engines get the Chrome 62 file.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineBootScript } from './engineBoot.mjs';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(clientRoot, 'dist');
const legacyDir = path.join(clientRoot, 'dist-engine-legacy');

function viteBuild(outDir, legacy) {
  const result = spawnSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: clientRoot,
    env: { ...process.env, SMART_ERP_LEGACY: legacy ? '1' : '' },
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function assetFiles(dir, ext) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(ext));
}

viteBuild(distDir, false);
viteBuild(legacyDir, true);

const modernHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const modernJs = modernHtml.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
const modernCss = modernHtml.match(/href="(\/assets\/index-[^"]+\.css)"/)?.[1];
if (!modernJs || !modernCss) {
  throw new Error('Modern build did not emit index script and stylesheet');
}

const legacyAssets = path.join(legacyDir, 'assets');
const legacyJsFiles = assetFiles(legacyAssets, '.js');
const legacyCssFiles = assetFiles(legacyAssets, '.css');
if (legacyJsFiles.length !== 1 || legacyCssFiles.length !== 1) {
  throw new Error(`Legacy build must be one script and one stylesheet, got js=${legacyJsFiles.length} css=${legacyCssFiles.length}`);
}

const legacyJsName = `legacy-${legacyJsFiles[0]}`;
const legacyCssName = `legacy-${legacyCssFiles[0]}`;
fs.copyFileSync(path.join(legacyAssets, legacyJsFiles[0]), path.join(distDir, 'assets', legacyJsName));
fs.copyFileSync(path.join(legacyAssets, legacyCssFiles[0]), path.join(distDir, 'assets', legacyCssName));

const boot = engineBootScript({
  modernJs,
  legacyJs: `/assets/${legacyJsName}`,
  modernCss,
  legacyCss: `/assets/${legacyCssName}`,
});

const html = modernHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*href="\/assets\/[^"]*"[^>]*>/gi, '')
  .replace('</head>', `<script>${boot}</script>\n</head>`);
fs.writeFileSync(path.join(distDir, 'index.html'), html);
fs.rmSync(legacyDir, { recursive: true, force: true });

const proof = spawnSync('node', ['scripts/proof-sunmi-webview62-syntax.mjs', 'dist'], {
  cwd: clientRoot,
  stdio: 'inherit',
  shell: true,
});
if (proof.status !== 0) process.exit(proof.status ?? 1);
