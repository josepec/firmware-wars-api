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

/* 1 — Generar PDF con Puppeteer local */
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('body[data-pdf-ready]', { timeout: 60_000 });

  /* 1a — Extraer secciones y contar páginas PDF reales por columna overflow */
  const domPages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.fw-page')).map(fw => {
      const sectionIdEl = fw.querySelector('.section-id');
      const tocLabelEl  = fw.querySelector('.toc-label');
      const label     = sectionIdEl?.textContent.trim()
                     ?? (tocLabelEl ? tocLabelEl.textContent.trim() : null);
      // El ID del elemento (ej: "fw-section-intro") permite mapear al TOC
      const sectionId = fw.id?.startsWith('fw-section-') ? fw.id.slice('fw-section-'.length) : null;

      // El overflow de columnas es HORIZONTAL: scrollWidth / clientWidth = nº de páginas
      const col = fw.querySelector('.md-col-2, .md-col-3');
      const pageCount = (col && col.clientWidth > 0)
        ? Math.max(1, Math.ceil(col.scrollWidth / col.clientWidth))
        : 1;

      return { label, sectionId, pageCount };
    });
  });

  // Calcular la página de inicio de cada sección (1-indexed)
  let currentPdfPage = 0;
  const sectionPageMap = {}; // { sectionId: startPage }
  const pdfPageLabels  = []; // pdfPageLabels[i] = label de la pág i del PDF
  for (const dp of domPages) {
    if (dp.sectionId) sectionPageMap[dp.sectionId] = currentPdfPage + 1;
    for (let i = 0; i < dp.pageCount; i++) pdfPageLabels.push(dp.label);
    currentPdfPage += dp.pageCount;
  }

  // Inyectar números de página en los spans .toc-pn del TOC
  await page.evaluate(map => {
    document.querySelectorAll('.toc-pn[data-section-id]').forEach(el => {
      const pg = map[el.dataset.sectionId];
      if (pg != null) el.textContent = String(pg);
    });
  }, sectionPageMap);

  /* 1b — Generar PDF (sin header/footer de Puppeteer — los pone pdf-lib) */
  const { page: pgCfg, header: hCfg, pageNumber: pnCfg } = cfg;
  const pdf = await page.pdf({
    format: pgCfg.format,
    printBackground: true,
    displayHeaderFooter: false,
    margin: pgCfg.margin,
  });

  console.log(`✔ PDF generado por Puppeteer  (${(pdf.byteLength / 1024).toFixed(1)} KB)`);

  /* 1c — Post-procesar con pdf-lib: header alternado + número de página */
  const pdfDoc      = await PDFDocument.load(pdf);
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

  let lastLabel = null;
  pdfDoc.getPages().forEach((p, i) => {
    // Etiqueta: del mapeo estimado; si no hay, propagar la última conocida
    const mapped = pdfPageLabels[i];
    const label  = mapped !== undefined ? mapped : lastLabel;
    if (mapped != null) lastLabel = mapped;
    if (!label) return;                             // portada: sin header ni footer

    const { width: W, height: H } = p.getSize();
    const pageNum     = i + 1;
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
      // Recto (impar): sección a la derecha (exterior), versión a la izquierda (interior)
      p.drawText(sectionText, { x: W - sideMarginPt - sectionW, y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(versionText, { x: sideMarginPt,                y: hTextY, size: hFontSize, font, color: textColor });
      p.drawText(pnText,      { x: W - sideMarginPt - pnW,      y: yPnPt,  size: pnFontSize, font, color: pnColor });
    } else {
      // Verso (par): sección a la izquierda (exterior), versión a la derecha (interior)
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
