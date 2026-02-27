#!/usr/bin/env node
/**
 * Genera el PDF del manual localmente y lo publica en R2.
 *
 * Uso:
 *   npm run publish -- patch    # 1.0.0 → 1.0.1  (corrección)
 *   npm run publish -- minor    # 1.0.0 → 1.1.0  (nuevo contenido)
 *   npm run publish -- major    # 1.0.0 → 2.0.0  (cambio importante)
 *
 * Por defecto apunta a http://localhost:4200 (ng serve corriendo).
 * Para generar desde producción:
 *   APP_URL=https://firmware-wars.josepec.eu npm run publish -- patch
 */

import puppeteer from 'puppeteer';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KV_NAMESPACE_ID = '459ee8f8ddb846cfb0d86221fcab04d0';
const R2_BUCKET = 'firmware-wars-assets';

/* ── Versión ──────────────────────────────────────────────── */

function getCurrentVersion() {
  const result = spawnSync(
    'npx',
    ['wrangler', 'kv', 'key', 'get', '--namespace-id', KV_NAMESPACE_ID, 'version'],
    { cwd: ROOT, encoding: 'utf-8' },
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    return { major: 0, minor: 0, patch: 0 };
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { major: 0, minor: 0, patch: 0 };
  }
}

function bumpVersion(v, bump) {
  if (bump === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function ver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/* ── Main ─────────────────────────────────────────────────── */

const bump = process.argv[2] ?? 'patch';
if (!['major', 'minor', 'patch'].includes(bump)) {
  console.error(`❌ Tipo de bump inválido: "${bump}". Usa major, minor o patch.`);
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'http://localhost:4200';
const printUrl = `${appUrl}/docs/print?worker=1`;

const current = getCurrentVersion();
const next = bumpVersion(current, bump);
const version = ver(next);
const tmpFile = join(tmpdir(), `firmware-wars-manual-v${version}.pdf`);

console.log(`\n📄 Generando PDF v${version}  (${ver(current)} → ${version})`);
console.log(`   Fuente: ${printUrl}\n`);

/* 1 — Generar PDF con Puppeteer local */
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('body[data-pdf-ready]', { timeout: 60_000 });

  const pdf = await page.pdf({
    format: 'A5',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="
        width:100%;box-sizing:border-box;padding:0 1.5cm;height:0.85cm;
        display:flex;align-items:center;justify-content:space-between;
        font-family:monospace;font-size:7pt;color:#3a6640;
        border-bottom:0.75pt solid #b8deba;">
        <span>FIRMWARE WARS</span>
        <span style="color:#6ea878;">◆</span>
        <span>System Manual v${version}</span>
      </div>`,
    footerTemplate: `
      <div style="
        width:100%;box-sizing:border-box;padding:0 1.5cm;height:0.85cm;
        display:flex;align-items:center;justify-content:space-between;
        font-family:monospace;font-size:6pt;color:#4a7a52;
        border-top:0.75pt solid #b8deba;">
        <span>28ª FIRMWARE WARS — Core Combat System</span>
        <span>
          <span class="pageNumber"></span>
          <span style="color:#b8deba;"> / </span>
          <span class="totalPages"></span>
        </span>
      </div>`,
    margin: { top: '1.5cm', right: '1.5cm', bottom: '1.2cm', left: '1.5cm' },
  });

  writeFileSync(tmpFile, pdf);
  console.log(`✔ PDF generado  (${(pdf.byteLength / 1024).toFixed(1)} KB)`);
} finally {
  await browser.close();
}

/* 2 — Subir a R2 */
console.log(`☁️  Subiendo a R2...`);
const r2Result = spawnSync(
  'npx',
  [
    'wrangler', 'r2', 'object', 'put',
    `${R2_BUCKET}/manual-v${version}.pdf`,
    '--file', tmpFile,
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
if (r2Result.status !== 0) {
  console.error('❌ Error subiendo a R2');
  process.exit(1);
}

/* 3 — Actualizar versión en KV */
console.log(`🔑 Actualizando versión en KV...`);
const kvResult = spawnSync(
  'npx',
  [
    'wrangler', 'kv', 'key', 'put',
    '--namespace-id', KV_NAMESPACE_ID,
    'version', JSON.stringify(next),
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
if (kvResult.status !== 0) {
  console.error('❌ Error actualizando KV');
  process.exit(1);
}

/* 4 — Limpiar */
unlinkSync(tmpFile);

console.log(`\n✅ Manual publicado correctamente`);
console.log(`   Versión : v${version}`);
console.log(`   URL     : https://firmware-wars-api.josepec.eu/pdf\n`);
