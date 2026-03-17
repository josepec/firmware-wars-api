interface Env {
  ASSETS: R2Bucket;
  META: KVNamespace;
  DB: D1Database;
  ADMIN_PASSWORD: string;
}

interface VersionMeta {
  major: number;
  minor: number;
  patch: number;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
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

    /* ── Admin auth helper ──────────────────────────────────── */
    function verifyAdmin(): boolean {
      const token = request.headers.get('X-Admin-Token');
      return !!token && !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
    }

    /* ── POST /api/admin/verify — comprobar contraseña admin ── */
    if (pathname === '/api/admin/verify' && request.method === 'POST') {
      let body: { password: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const valid = !!env.ADMIN_PASSWORD && body.password === env.ADMIN_PASSWORD;
      return new Response(JSON.stringify({ valid, token: valid ? env.ADMIN_PASSWORD : null }), {
        status: valid ? 200 : 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/scenarios — listar escenarios ──────────────── */
    if (pathname === '/api/scenarios' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, title, updated_at FROM scenarios ORDER BY created_at DESC'
      ).all<{ id: string; title: string; updated_at: string }>();
      return new Response(JSON.stringify(rows.results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/scenarios/:id — obtener escenario ──────────── */
    const scenarioMatch = pathname.match(/^\/api\/scenarios\/([a-z0-9]+)$/);
    if (scenarioMatch && request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT id, title, data, created_at, updated_at FROM scenarios WHERE id = ?'
      ).bind(scenarioMatch[1]).first<{ id: string; title: string; data: string; created_at: string; updated_at: string }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Scenario not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ...row, data: JSON.parse(row.data) }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/scenarios — crear escenario (admin) ────────── */
    if (pathname === '/api/scenarios' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { title: string; data: unknown };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!body.title) {
        return new Response(JSON.stringify({ error: 'Missing title' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO scenarios (id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, body.title, JSON.stringify(body.data), now, now).run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PUT /api/scenarios/:id — actualizar escenario (admin) ── */
    if (scenarioMatch && request.method === 'PUT') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { title: string; data: unknown };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        'UPDATE scenarios SET title = ?, data = ?, updated_at = ? WHERE id = ?'
      ).bind(body.title, JSON.stringify(body.data), now, scenarioMatch[1]).run();
      if (!result.meta.changes) {
        return new Response(JSON.stringify({ error: 'Scenario not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── DELETE /api/scenarios/:id — borrar escenario (admin) ── */
    if (scenarioMatch && request.method === 'DELETE') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.DB.prepare('DELETE FROM scenarios WHERE id = ?').bind(scenarioMatch[1]).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
