interface Env {
  ASSETS: R2Bucket;
  META: KVNamespace;
  DB: D1Database;
}

interface VersionMeta {
  major: number;
  minor: number;
  patch: number;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateId(len = 8): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => ID_CHARS[b % ID_CHARS.length]).join('');
}

const MAX_PAYLOAD = 32_000;

function versionString(v: VersionMeta): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    /* ── GET /version — última versión del manual ─────────── */
    if (pathname === '/version') {
      const meta = await env.META.get<VersionMeta>('version', 'json');
      const version = meta ? `v${versionString(meta)}` : null;
      return new Response(JSON.stringify({ version }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

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

    /* ── POST /api/lists — guardar una lista nueva ──────────── */
    if (pathname === '/api/lists' && request.method === 'POST') {
      const contentLength = parseInt(request.headers.get('content-length') ?? '0');
      if (contentLength > MAX_PAYLOAD) {
        return new Response(JSON.stringify({ error: 'Payload too large' }), {
          status: 413,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      let body: { programmer: string; bots: unknown[] };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      if (!body.programmer || !Array.isArray(body.bots) || body.bots.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing programmer or bots' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO lists (id, programmer, data) VALUES (?, ?, ?)'
      ).bind(id, body.programmer, JSON.stringify(body)).run();

      return new Response(JSON.stringify({ id }), {
        status: 201,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/lists/:id — recuperar una lista ─────────── */
    const listMatch = pathname.match(/^\/api\/lists\/([a-z0-9]+)$/);
    if (listMatch && request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT data, created_at FROM lists WHERE id = ?'
      ).bind(listMatch[1]).first<{ data: string; created_at: string }>();

      if (!row) {
        return new Response(JSON.stringify({ error: 'List not found' }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        id: listMatch[1],
        ...JSON.parse(row.data),
        created_at: row.created_at,
      }), {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400, immutable',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
