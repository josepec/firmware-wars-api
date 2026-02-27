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
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_ID   = '6ae2e655cdb9fce3177feb49d02fdfa1';
const KV_NAMESPACE_ID = '459ee8f8ddb846cfb0d86221fcab04d0';
const R2_BUCKET = 'firmware-wars-assets';

/* ── Cloudflare API token (desde env o desde el config de wrangler) ── */

function getCfToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  // Wrangler guarda el OAuth token en el config de usuario
  const candidates = [
    join(process.env.APPDATA ?? '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.wrangler', 'config', 'default.toml'),
  ];
  for (const p of candidates) {
    try {
      const toml = readFileSync(p, 'utf-8');
      const m = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch { /* fichero no existe */ }
  }
  throw new Error(
    'No se encontró token de Cloudflare. ' +
    'Define la variable CLOUDFLARE_API_TOKEN o ejecuta `npx wrangler login`.',
  );
}

/* ── Escribe un valor en KV via REST API (evita problemas de shell) ── */

async function kvPut(key, value) {
  const token = getCfToken();
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}` +
              `/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`KV write falló: ${resp.status} ${text}`);
  }
}

/* ── Versión ──────────────────────────────────────────────── */

function getCurrentVersion() {
  const result = spawnSync(
    'npx',
    ['wrangler', 'kv', 'key', 'get', '--namespace-id', KV_NAMESPACE_ID, 'version', '--remote'],
    { cwd: ROOT, encoding: 'utf-8', shell: true },
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

const appUrl = process.env.APP_URL ?? 'https://firmware-wars.josepec.eu';
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
        <span>Core Combat System v${version}</span>
      </div>`,
    footerTemplate: `
      <div style="
        width:100%;box-sizing:border-box;padding:0 1.5cm;height:0.85cm;
        display:flex;align-items:center;justify-content:flex-end;
        font-family:monospace;font-size:6pt;color:#4a7a52;
        border-top:0.75pt solid #b8deba;">
        <span class="pageNumber"></span>
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
    '--remote',
  ],
  { cwd: ROOT, encoding: 'utf-8', shell: true },
);
process.stdout.write(r2Result.stdout ?? '');
process.stderr.write(r2Result.stderr ?? '');
if (r2Result.status !== 0) {
  console.error(`❌ Error subiendo a R2 (exit code: ${r2Result.status})`);
  process.exit(1);
}

/* 3 — Actualizar versión en KV via REST API */
console.log(`🔑 Actualizando versión en KV...`);
await kvPut('version', next);

/* 4 — Limpiar */
unlinkSync(tmpFile);

console.log(`\n✅ Manual publicado correctamente`);
console.log(`   Versión : v${version}`);
console.log(`   URL     : https://firmware-wars-api.josepec.eu/pdf\n`);
