import puppeteer from '@cloudflare/puppeteer';

interface Env {
  BROWSER: Fetcher;
  APP_URL: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    if (pathname !== '/pdf') {
      return new Response('Not found', { status: 404 });
    }

    const appUrl = env.APP_URL ?? 'https://firmware-wars.pages.dev';
    const printUrl = `${appUrl}/docs/print`;

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    try {
      /* 1 — Navegar a la página de impresión de la app Angular */
      await page.goto(printUrl, { waitUntil: 'networkidle0', timeout: 45_000 });

      /* 2 — Esperar a que el componente Angular señale que todos los
              markdown están cargados y el layout está calculado.
              El componente pone data-pdf-ready en <body> cuando termina. */
      await page.waitForSelector('body[data-pdf-ready]', { timeout: 45_000 });

      /* 3 — Generar PDF A5 con cabecera y pie nativos de Chromium.
              Los <span class="pageNumber"> y <span class="totalPages">
              son sustituidos automáticamente por el motor de impresión. */
      const pdf = await page.pdf({
        format: 'A5',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `
          <div style="
            width: 100%; box-sizing: border-box;
            padding: 0 1.5cm;
            height: 0.85cm;
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
            padding: 0 1.5cm;
            height: 0.85cm;
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
        /* Márgenes: deja espacio para cabecera (0.85 cm) + gap y pie igual */
        margin: { top: '1.5cm', right: '1.5cm', bottom: '1.2cm', left: '1.5cm' },
      });

      return new Response(pdf, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="firmware-wars-manual-v1.pdf"',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Error generando PDF: ${message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    } finally {
      await browser.close();
    }
  },
};
