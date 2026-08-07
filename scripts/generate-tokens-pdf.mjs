#!/usr/bin/env node
/**
 * Genera el PDF de las Fichas (marcadores de estado + moneda de intercepción)
 * y lo deja en `firmware-wars/public/assets/pdf/Firmware Wars - Fichas.pdf`.
 *
 * Como el de cartas, no va versionado en R2: es un print & play estático que
 * se sirve como asset y viaja con el deploy.
 *
 * Uso:
 *   npm run tokens-pdf                      # 5 marcadores por estado
 *   npm run tokens-pdf -- --copies 3        # 3 por estado
 *   APP_URL=http://localhost:4200 npm run tokens-pdf
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* El nombre coincide con el <title> de /docs/tokens-print, que es de donde
   Chrome saca el título del PDF. Si cambia uno, cambia el otro. */
const OUT = join(ROOT, '..', 'firmware-wars', 'public', 'assets', 'pdf', 'Firmware Wars - Fichas.pdf');

const args = process.argv.slice(2);
const copiesIdx = args.indexOf('--copies');
const copies = copiesIdx >= 0 ? parseInt(args[copiesIdx + 1], 10) : null;
if (copiesIdx >= 0 && (!Number.isFinite(copies) || copies < 1 || copies > 5)) {
  console.error(`❌ --copies inválido: "${args[copiesIdx + 1]}". Usa 1..5.`);
  process.exit(1);
}

const appUrl = process.env.APP_URL ?? 'https://firmware-wars.josepec.eu';
const printUrl = `${appUrl}/docs/tokens-print?worker=1${copies ? `&copies=${copies}` : ''}`;

console.log(`\n🎲 Generando PDF de Fichas`);
console.log(`   Fuente: ${printUrl}\n`);

/* Las fichas son maquetación milimétrica dentro de un hexágono: con la
   tipografía de reserva los rótulos desbordan el recorte. */
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

  const { hexes, monedas, paginas } = await page.evaluate(() => ({
    hexes: document.querySelectorAll('.hex:not(.hex--back)').length,
    monedas: document.querySelectorAll('.coin:not(.coin--used)').length,
    paginas: document.querySelectorAll('.page').length,
  }));
  console.log(`   ${hexes} marcadores · ${monedas} fichas de intercepción · ${paginas} páginas A4`);

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
