interface Env {
  ASSETS: R2Bucket;
  META: KVNamespace;
}

interface VersionMeta {
  major: number;
  minor: number;
  patch: number;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function versionString(v: VersionMeta): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    /* ── GET /pdf — redirige a la URL versionada ───────────── */
    if (pathname === '/pdf') {
      const meta = await env.META.get<VersionMeta>('version', 'json');

      if (!meta) {
        return new Response(
          'No hay ningún PDF generado todavía. Ejecuta: npm run publish patch',
          { status: 404, headers: CORS_HEADERS },
        );
      }

      const version = versionString(meta);
      return new Response(null, {
        status: 302,
        headers: {
          ...CORS_HEADERS,
          'Location': `/pdf/v${version}`,
          'Cache-Control': 'no-store',
        },
      });
    }

    /* ── GET /pdf/v{version} — sirve un PDF concreto desde R2 ─ */
    const versionMatch = pathname.match(/^\/pdf\/v([\d.]+)$/);
    if (versionMatch) {
      const version = versionMatch[1];
      const object = await env.ASSETS.get(`manual-v${version}.pdf`);

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
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    /* ── GET /pdf/versions — historial de versiones ─────────── */
    if (pathname === '/pdf/versions') {
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

    return new Response('Not found', { status: 404 });
  },
};
