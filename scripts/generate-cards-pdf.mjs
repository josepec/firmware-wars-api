#!/usr/bin/env node
/**
 * Genera el PDF de las Cartas de Función y lo deja en el sitio, junto al
 * Terminal: `firmware-wars/public/assets/pdf/Firmware Wars - Cartas.pdf`.
 *
 * A diferencia del manual o los escenarios, este PDF no va versionado en R2:
 * es un print & play estático que se sirve como asset y viaja con el deploy.
 *
 * Uso:
 *   npm run cards-pdf                       # 3 cartas de cada (set de juego)
 *   npm run cards-pdf -- --copies 1         # catálogo, 1 de cada
 *   APP_URL=http://localhost:4200 npm run cards-pdf
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* El nombre coincide con el <title> de /docs/cards-print en modo catálogo, que
   es de donde Chrome saca el título del PDF. Si cambia uno, cambia el otro. */
const OUT = join(ROOT, '..', 'firmware-wars', 'public', 'assets', 'pdf', 'Firmware Wars - Cartas Completas.pdf');

/* ── Argumentos ────────────────────────────────────────────── */

const args = process.argv.slice(2);
const copiesIdx = args.indexOf('--copies');
/* 3 por defecto: son las Operaciones que un Bot puede programar en un turno,
   así que es el número de copias que hacen falta para jugar. */
const copies = copiesIdx >= 0 ? parseInt(args[copiesIdx + 1], 10) : 3;
if (!Number.isFinite(copies) || copies < 1 || copies > 9) {
  console.error(`❌ --copies inválido: "${args[copiesIdx + 1]}". Usa 1..9.`);
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'https://firmware-wars.josepec.eu';
const printUrl = `${appUrl}/docs/cards-print?worker=1&copies=${copies}`;

console.log(`\n🃏 Generando PDF de Cartas  (${copies} copia${copies > 1 ? 's' : ''} de cada)`);
console.log(`   Fuente: ${printUrl}\n`);

/* ── Comprobación de tipografías ────────────────────────────
   Las cartas son maquetación milimétrica: si Chrome captura con la
   tipografía de reserva, los nombres desbordan y el autoajuste del
   texto mide sobre métricas equivocadas. Mejor abortar. */
async function assertFontsLoaded(p) {
  const faltan = await p.evaluate(async () => {
    await document.fonts.ready;
    return ['JetBrains Mono'].filter(f => !document.fonts.check(`12px "${f}"`));
  });
  if (faltan.length) {
    throw new Error(`Tipografías no cargadas: ${faltan.join(', ')}. `
      + 'Abortado para no generar un PDF mal maquetado.');
  }
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 120_000 });
  await page.waitForSelector('body[data-pdf-ready]', { timeout: 120_000 });
  await assertFontsLoaded(page);

  const sheets = await page.evaluate(() => document.querySelectorAll('.page').length);
  const cards = await page.evaluate(
    () => document.querySelectorAll('.card:not(.card--empty):not(.card-back)').length,
  );
  console.log(`   ${cards} cartas · ${sheets} páginas A4 (caras + dorsos)`);

  /* Sin márgenes: la hoja ya reserva los suyos y las marcas de corte
     viven dentro de la página. */
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: false,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, pdf);
  console.log(`\n✅ PDF generado  (${(pdf.byteLength / 1024).toFixed(1)} KB)`);
  console.log(`   ${OUT}\n`);
} finally {
  await browser.close();
}
