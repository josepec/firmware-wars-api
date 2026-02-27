#!/usr/bin/env node
/**
 * Publica una nueva versión del manual PDF.
 *
 * Uso:
 *   node scripts/publish-pdf.mjs patch    # 1.0.0 → 1.0.1  (correcciones)
 *   node scripts/publish-pdf.mjs minor    # 1.0.0 → 1.1.0  (nuevo contenido)
 *   node scripts/publish-pdf.mjs major    # 1.0.0 → 2.0.0  (cambio importante)
 *
 * Requiere en .dev.vars (o variables de entorno):
 *   WORKER_URL=https://firmware-wars-api.josepec.eu
 *   GENERATE_SECRET=tu_secreto
 */

const bump = process.argv[2] ?? 'patch';

if (!['major', 'minor', 'patch'].includes(bump)) {
  console.error(`❌ Tipo de bump inválido: "${bump}". Usa major, minor o patch.`);
  process.exit(1);
}

// Leer variables del entorno o de .dev.vars
let workerUrl = process.env.WORKER_URL;
let secret = process.env.GENERATE_SECRET;

if (!workerUrl || !secret) {
  // Intentar leer .dev.vars
  try {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const devVars = readFileSync(join(dir, '..', '.dev.vars'), 'utf-8');
    for (const line of devVars.split('\n')) {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=').trim();
      if (key?.trim() === 'WORKER_URL' && !workerUrl) workerUrl = value;
      if (key?.trim() === 'GENERATE_SECRET' && !secret) secret = value;
    }
  } catch {
    // .dev.vars no existe, continuamos con lo que tengamos
  }
}

if (!workerUrl) {
  console.error('❌ WORKER_URL no definida. Añádela a .dev.vars o como variable de entorno.');
  process.exit(1);
}
if (!secret) {
  console.error('❌ GENERATE_SECRET no definida. Añádela a .dev.vars o como variable de entorno.');
  process.exit(1);
}

console.log(`📄 Generando PDF (bump: ${bump})...`);
console.log(`   Worker: ${workerUrl}`);

const url = `${workerUrl}/generate?bump=${bump}`;

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
} catch (err) {
  console.error(`❌ Error de red: ${err.message}`);
  process.exit(1);
}

const body = await response.text();

if (!response.ok) {
  console.error(`❌ Error ${response.status}: ${body}`);
  process.exit(1);
}

const result = JSON.parse(body);
console.log(`✅ PDF publicado correctamente`);
console.log(`   Versión : v${result.version}`);
console.log(`   Fichero : ${result.key}`);
console.log(`   Tamaño  : ${(result.size / 1024).toFixed(1)} KB`);
console.log(`   URL     : ${workerUrl}/pdf`);
