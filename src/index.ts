import puppeteer from '@cloudflare/puppeteer';

interface Env {
  BROWSER: Fetcher;
  ASSETS: R2Bucket;
  META: KVNamespace;
  APP_URL: string;
  GENERATE_SECRET: string;
}

interface VersionMeta {
  major: number;
  minor: number;
  patch: number;
}

type BumpType = 'major' | 'minor' | 'patch';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/* ── Helpers de versión ──────────────────────────────────────── */

function bumpVersion(v: VersionMeta, bump: BumpType): VersionMeta {
  if (bump === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function versionString(v: VersionMeta): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function r2Key(version: string): string {
  return `manual-v${version}.pdf`;
}

/* ── Generación del PDF ──────────────────────────────────────── */

async function generatePdf(env: Env): Promise<Uint8Array> {
  const appUrl = env.APP_URL ?? 'https://firmware-wars.josepec.eu';
  const printUrl = `${appUrl}/docs/print?worker=1`;

  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();

  try {
    await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('body[data-pdf-ready]', { timeout: 60_000 });

    return await page.pdf({
      format: 'A5',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="
          width: 100%; box-sizing: border-box;
          padding: 0 1.5cm; height: 0.85cm;
          display: flex; align-items: center; justify-content: space-between;
          font-family: monospace; font-size: 7pt; color: #3a6640;
          border-bottom: 0.75pt solid #b8deba;
        ">
          <span>FIRMWARE WARS</span>
          <span style="color:#6ea878;">◆</span>
          <span>System Manual v1.0</span>
        </div>`,
      footerTemplate: `
        <div style="
          width: 100%; box-sizing: border-box;
          padding: 0 1.5cm; height: 0.85cm;
          display: flex; align-items: center; justify-content: space-between;
          font-family: monospace; font-size: 6pt; color: #4a7a52;
          border-top: 0.75pt solid #b8deba;
        ">
          <span>28ª FIRMWARE WARS — Core Combat System</span>
          <span>
            <span class="pageNumber"></span>
            <span style="color:#b8deba;"> / </span>
            <span class="totalPages"></span>
          </span>
        </div>`,
      margin: { top: '1.5cm', right: '1.5cm', bottom: '1.2cm', left: '1.5cm' },
    });
  } finally {
    await browser.close();
  }
}

/* ── Handler principal ───────────────────────────────────────── */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname, searchParams } = new URL(request.url);

    /* ── GET /pdf — sirve la última versión desde R2 ────────── */
    if (request.method === 'GET' && pathname === '/pdf') {
      const meta = await env.META.get<VersionMeta>('version', 'json');

      if (!meta) {
        return new Response('No hay ningún PDF generado todavía. Ejecuta el comando publish.', {
          status: 404,
          headers: CORS_HEADERS,
        });
      }

      const version = versionString(meta);
      const object = await env.ASSETS.get(r2Key(version));

      if (!object) {
        return new Response(`PDF v${version} no encontrado en storage.`, {
          status: 404,
          headers: CORS_HEADERS,
        });
      }

      return new Response(object.body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="firmware-wars-manual-v${version}.pdf"`,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    /* ── GET /pdf/versions — lista el historial ─────────────── */
    if (request.method === 'GET' && pathname === '/pdf/versions') {
      const list = await env.ASSETS.list({ prefix: 'manual-v' });
      const versions = list.objects.map(o => ({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
      }));
      return new Response(JSON.stringify(versions, null, 2), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /generate — genera el PDF y lo sube a R2 ─────── */
    if (request.method === 'POST' && pathname === '/generate') {
      // Verificar secreto
      const auth = request.headers.get('Authorization');
      if (!env.GENERATE_SECRET || auth !== `Bearer ${env.GENERATE_SECRET}`) {
        return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
      }

      const bump = (searchParams.get('bump') ?? 'patch') as BumpType;
      if (!['major', 'minor', 'patch'].includes(bump)) {
        return new Response('bump debe ser major, minor o patch', {
          status: 400,
          headers: CORS_HEADERS,
        });
      }

      // Calcular nueva versión
      const current = (await env.META.get<VersionMeta>('version', 'json')) ?? {
        major: 0,
        minor: 0,
        patch: 0,
      };
      const next = bumpVersion(current, bump);
      const version = versionString(next);

      // Generar PDF
      let pdf: Uint8Array;
      try {
        pdf = await generatePdf(env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Error generando PDF: ${message}`, {
          status: 500,
          headers: CORS_HEADERS,
        });
      }

      // Subir a R2
      await env.ASSETS.put(r2Key(version), pdf, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { version, generatedAt: new Date().toISOString() },
      });

      // Actualizar versión en KV
      await env.META.put('version', JSON.stringify(next));

      return new Response(
        JSON.stringify({ version, key: r2Key(version), size: pdf.byteLength }),
        { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response('Not found', { status: 404 });
  },
};
