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
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import pdfParse from 'pdf-parse';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── Config ───────────────────────────────────────────────── */

const cfg = JSON.parse(readFileSync(join(ROOT, 'pdf.config.json'), 'utf-8'));

/** Convierte "1.5cm" → puntos PDF (1cm = 28.35pt) */
function cmToPt(val) { return parseFloat(val) * 28.35; }

/** Convierte "#rrggbb" → rgb() de pdf-lib (valores 0-1) */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}
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

/**
 * Regex para marcadores. Formatos:
 *   FWMARK-TOC                → id='TOC', label='ÍNDICE DE CONTENIDOS'
 *   FWMARK-01-INIT.SYS        → id='01',  label='INIT.SYS'
 */
const MARKER_RE = /FWMARK-(\w+?)(?:-([A-Z0-9_.]+))?(?=\s|$)/g;

/**
 * Extrae los marcadores FWMARK de cada página del PDF.
 * Devuelve un array ordenado: [{ id, label, startPage }]
 * No depende de ninguna lista hardcodeada de secciones.
 */
async function extractSectionMap(pdfBuffer) {
  const pageTexts = [];

  await pdfParse(pdfBuffer, {
    pagerender(pageData) {
      return pageData.getTextContent().then(tc => {
        const text = tc.items.map(item => item.str).join(' ');
        pageTexts.push(text);
        return text;
      });
    },
  });

  const map = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const pageNum = i + 1;
    for (const match of pageTexts[i].matchAll(MARKER_RE)) {
      const id = match[1];    // 'TOC', '01', '02', ...
      const label = match[2]; // undefined para TOC, 'INIT.SYS' para secciones
      map.push({
        id,
        label: label ?? (id === 'TOC' ? 'ÍNDICE DE CONTENIDOS' : id),
        startPage: pageNum,
      });
    }
  }

  map.sort((a, b) => a.startPage - b.startPage);
  return map;
}

/**
 * Devuelve la etiqueta de sección para una página dada,
 * basándose en el mapa real extraído del PDF.
 */
function getLabelForPage(sectionMap, pageNum) {
  for (let i = sectionMap.length - 1; i >= 0; i--) {
    if (pageNum >= sectionMap[i].startPage) return sectionMap[i].label;
  }
  return null; // portada: sin header
}

/* 1 — Generar PDF con doble pasada */
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

try {
  const { page: pgCfg, header: hCfg, pageNumber: pnCfg } = cfg;
  const pdfOpts = {
    format: pgCfg.format,
    printBackground: true,
    displayHeaderFooter: false,
    margin: pgCfg.margin,
  };

  await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('body[data-pdf-ready]', { timeout: 60_000 });

  /* ── PASADA 1: generar PDF y extraer mapa de secciones ── */
  const pass1Pdf = await page.pdf(pdfOpts);
  console.log(`✔ Pasada 1 completada  (${(pass1Pdf.byteLength / 1024).toFixed(1)} KB)`);

  const sectionMap = await extractSectionMap(Buffer.from(pass1Pdf));
  const pass1Pages = (await PDFDocument.load(pass1Pdf)).getPageCount();

  console.log(`  Mapa de secciones:`);
  for (const s of sectionMap) {
    console.log(`    ${s.id.padEnd(4)} ${s.label.padEnd(24)} → pág. ${s.startPage}`);
  }

  /* ── PASADA 2: inyectar números de página en TOC y regenerar ── */
  await page.evaluate((sections) => {
    for (const { num, startPage } of sections) {
      const el = document.getElementById(`toc-pn-${num}`);
      if (el) el.textContent = String(startPage);
    }
  }, sectionMap.filter(s => s.id !== 'TOC').map(s => ({ num: s.id, startPage: s.startPage })));

  const pass2Pdf = await page.pdf(pdfOpts);
  const pass2Pages = (await PDFDocument.load(pass2Pdf)).getPageCount();

  if (pass1Pages !== pass2Pages) {
    console.warn(`⚠️  Pasada 1 tiene ${pass1Pages} páginas, pasada 2 tiene ${pass2Pages}. Verificar TOC.`);
  }

  console.log(`✔ Pasada 2 completada  (${(pass2Pdf.byteLength / 1024).toFixed(1)} KB, ${pass2Pages} págs.)`);

  /* ── POST-PROCESO: headers, footers y números de página con pdf-lib ── */
  const pdfDoc      = await PDFDocument.load(pass2Pdf);
  const font        = await pdfDoc.embedFont(StandardFonts.Courier);
  const textColor   = hexToRgb(hCfg.textColor);
  const borderColor = hexToRgb(hCfg.borderColor);
  const pnColor     = hexToRgb(pnCfg.color);
  const hFontSize   = hCfg.fontSize;
  const pnFontSize  = pnCfg.fontSize;

  const topMarginPt    = cmToPt(pgCfg.margin.top);
  const bottomMarginPt = cmToPt(pgCfg.margin.bottom);
  const sideMarginPt   = cmToPt(pgCfg.margin.left);
  const yPnPt          = cmToPt(pnCfg.yFromBottom);

  pdfDoc.getPages().forEach((p, i) => {
    const pageNum = i + 1;
    const label = getLabelForPage(sectionMap, pageNum);
    if (!label) return;                             // portada: sin header ni footer

    const { width: W, height: H } = p.getSize();
    const isRecto     = pageNum % 2 === 1;          // impar = recto (derecha)
    const headerLineY = H - topMarginPt;
    const hTextY      = headerLineY + (topMarginPt - hFontSize) / 2;

    const sectionText = hCfg.sectionPrefix + label;
    const versionText = `v${version}`;
    const sectionW    = font.widthOfTextAtSize(sectionText, hFontSize);
    const versionW    = font.widthOfTextAtSize(versionText, hFontSize);
    const pnText      = String(pageNum);
    const pnW         = font.widthOfTextAtSize(pnText, pnFontSize);

    if (isRecto) {
      p.drawText(sectionText, { x: W - sideMarginPt - sectionW, y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(versionText, { x: sideMarginPt,                y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(pnText,      { x: W - sideMarginPt - pnW,      y: yPnPt,  size: pnFontSize, font, color: pnColor });
    } else {
      p.drawText(sectionText, { x: sideMarginPt,                    y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(versionText, { x: W - sideMarginPt - versionW,     y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(pnText,      { x: sideMarginPt,                    y: yPnPt,  size: pnFontSize, font, color: pnColor });
    }

    // Líneas separadoras de ancho completo
    p.drawLine({ start: { x: 0, y: headerLineY },    end: { x: W, y: headerLineY },    thickness: 0.75, color: borderColor });
    p.drawLine({ start: { x: 0, y: bottomMarginPt }, end: { x: W, y: bottomMarginPt }, thickness: 0.75, color: borderColor });
  });

  const finalPdf = await pdfDoc.save();
  writeFileSync(tmpFile, finalPdf);
  console.log(`✔ Header/footer añadidos  (${(finalPdf.byteLength / 1024).toFixed(1)} KB)`);
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
