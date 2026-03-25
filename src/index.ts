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
          'Cache-Control': 'public, max-age=3600',
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

    /* ── GET /scenarios-pdf — redirige a la URL versionada ──── */
    if (pathname === '/scenarios-pdf') {
      const meta = await env.META.get<VersionMeta>('scenarios-version', 'json');
      if (!meta) {
        return new Response(
          'No hay ningún PDF de escenarios generado todavía. Ejecuta: npm run publish-scenarios patch',
          { status: 404, headers: CORS_HEADERS },
        );
      }
      const version = versionString(meta);
      return new Response(null, {
        status: 302,
        headers: { ...CORS_HEADERS, 'Location': `/scenarios-pdf/v${version}`, 'Cache-Control': 'no-store' },
      });
    }

    /* ── GET /scenarios-pdf/v{version} — sirve PDF desde R2 ── */
    const scenariosPdfMatch = pathname.match(/^\/scenarios-pdf\/v([\d.]+)$/);
    if (scenariosPdfMatch) {
      const version = scenariosPdfMatch[1];
      const object = await env.ASSETS.get(`scenarios-v${version}.pdf`);
      if (!object) {
        return new Response(`PDF escenarios v${version} no encontrado.`, { status: 404, headers: CORS_HEADERS });
      }
      return new Response(object.body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="firmware-wars-scenarios-v${version}.pdf"`,
          'Cache-Control': 'public, max-age=3600',
        },
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
      const full = new URL(request.url).searchParams.has('full');
      const sql = full
        ? 'SELECT id, title, data, updated_at FROM scenarios ORDER BY json_extract(data, \'$.numeroEscenario\') ASC'
        : 'SELECT id, title, updated_at FROM scenarios ORDER BY json_extract(data, \'$.numeroEscenario\') ASC';
      const rows = await env.DB.prepare(sql).all();
      const results = full
        ? rows.results.map((r: any) => ({ ...r, data: r.data ? JSON.parse(r.data) : {} }))
        : rows.results;
      return new Response(JSON.stringify(results), {
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
      let body: { title: string; data: any };
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
      // Validate unique numeroEscenario
      const numEsc = body.data?.numeroEscenario;
      if (numEsc != null) {
        const all = await env.DB.prepare('SELECT id, data FROM scenarios').all<{ id: string; data: string }>();
        const dup = all.results.find(r => {
          try { return JSON.parse(r.data)?.numeroEscenario === numEsc; } catch { return false; }
        });
        if (dup) {
          return new Response(JSON.stringify({ error: `El número de escenario ${numEsc < 10 ? '0' + numEsc : numEsc} ya está en uso.` }), {
            status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
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
      let body: { title: string; data: any };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      // Validate unique numeroEscenario (exclude self)
      const numEsc = body.data?.numeroEscenario;
      if (numEsc != null) {
        const all = await env.DB.prepare('SELECT id, data FROM scenarios WHERE id != ?').bind(scenarioMatch[1]).all<{ id: string; data: string }>();
        const dup = all.results.find(r => {
          try { return JSON.parse(r.data)?.numeroEscenario === numEsc; } catch { return false; }
        });
        if (dup) {
          return new Response(JSON.stringify({ error: `El número de escenario ${numEsc < 10 ? '0' + numEsc : numEsc} ya está en uso.` }), {
            status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
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

    /* ── GET /api/hex-types — listar tipos de hex compartidos ── */
    if (pathname === '/api/hex-types' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, name, color, border_color, properties, created_at FROM hex_types ORDER BY created_at ASC'
      ).all<{ id: string; name: string; color: string; border_color: string; properties: string; created_at: string }>();
      const results = rows.results.map(r => ({
        ...r,
        borderColor: r.border_color,
        properties: r.properties ?? '',
      }));
      return new Response(JSON.stringify(results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/hex-types — crear tipo de hex (admin) ──────── */
    if (pathname === '/api/hex-types' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { name: string; color: string; borderColor: string; properties?: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!body.name || !body.color || !body.borderColor) {
        return new Response(JSON.stringify({ error: 'Missing fields' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO hex_types (id, name, color, border_color, properties) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, body.name, body.color, body.borderColor, body.properties ?? '').run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PUT /api/hex-types/:id — actualizar tipo (admin) ──────── */
    const hexTypeMatch = pathname.match(/^\/api\/hex-types\/([a-z0-9]+)$/);
    if (hexTypeMatch && request.method === 'PUT') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { name: string; color: string; borderColor: string; properties?: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const result = await env.DB.prepare(
        'UPDATE hex_types SET name = ?, color = ?, border_color = ?, properties = ? WHERE id = ?'
      ).bind(body.name, body.color, body.borderColor, body.properties ?? '', hexTypeMatch[1]).run();
      if (!result.meta.changes) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── DELETE /api/hex-types/:id — borrar tipo (admin) ────────── */
    if (hexTypeMatch && request.method === 'DELETE') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.DB.prepare('DELETE FROM hex_types WHERE id = ?').bind(hexTypeMatch[1]).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/functions — JSON array listo para usar en docs ── */
    if (pathname === '/api/functions' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT id, func_name, func_type, version, range, damage, energy, cost, effects
         FROM functions ORDER BY version ASC, func_name ASC`
      ).all<{ id: string; func_name: string; func_type: string | null; version: string; range: string; damage: string; energy: string; cost: string; effects: string }>();
      const attack = rows.results.filter(r => (r.func_type ?? 'attack') === 'attack').map(r => ({
        'Función': '`' + r.func_name + '`',
        'V.~': r.version,
        'Rango~': r.range,
        'Daño~': r.damage,
        'Energía~': r.energy,
        'Coste~': r.cost ? r.cost + '◈' : '—',
        'Efectos': r.effects,
      }));
      const passive = rows.results.filter(r => r.func_type === 'passive').map(r => ({
        'Función': '`' + r.func_name + '`',
        'Efectos': r.effects,
      }));
      return new Response(JSON.stringify({ attack, passive }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/functions/admin — lista con ids para admin ───── */
    if (pathname === '/api/functions/admin' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, func_name, func_type, version, range, damage, energy, cost, effects FROM functions ORDER BY func_type ASC, version ASC, func_name ASC'
      ).all<{ id: string; func_name: string; func_type: string | null; version: string; range: string; damage: string; energy: string; cost: string; effects: string }>();
      const results = rows.results.map(r => ({ ...r, func_type: r.func_type ?? 'attack' }));
      return new Response(JSON.stringify(results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/functions/:id — obtener función ───────────────── */
    const funcMatch = pathname.match(/^\/api\/functions\/([a-zA-Z0-9]+)$/);
    if (funcMatch && request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT id, func_name, func_type, version, range, damage, energy, cost, effects FROM functions WHERE id = ?'
      ).bind(funcMatch[1]).first<{ id: string; func_name: string; func_type: string | null; version: string; range: string; damage: string; energy: string; cost: string; effects: string }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Function not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ...row, func_type: row.func_type ?? 'attack' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/functions — crear función (admin) ───────────── */
    if (pathname === '/api/functions' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { func_name: string; func_type?: string; version: string; range: string; damage: string; energy: string; cost: string; effects: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!body.func_name) {
        return new Response(JSON.stringify({ error: 'Missing func_name' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO functions (id, func_name, func_type, version, range, damage, energy, cost, effects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, body.func_name, body.func_type ?? 'attack', body.version ?? '', body.range ?? '', body.damage ?? '', body.energy ?? '', body.cost ?? '', body.effects ?? '').run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PUT /api/functions/:id — actualizar función (admin) ───── */
    if (funcMatch && request.method === 'PUT') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { func_name: string; func_type?: string; version: string; range: string; damage: string; energy: string; cost: string; effects: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const result = await env.DB.prepare(
        'UPDATE functions SET func_name = ?, func_type = ?, version = ?, range = ?, damage = ?, energy = ?, cost = ?, effects = ? WHERE id = ?'
      ).bind(body.func_name, body.func_type ?? 'attack', body.version ?? '', body.range ?? '', body.damage ?? '', body.energy ?? '', body.cost ?? '', body.effects ?? '', funcMatch[1]).run();
      if (!result.meta.changes) {
        return new Response(JSON.stringify({ error: 'Function not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── DELETE /api/functions/:id — borrar función (admin) ───── */
    if (funcMatch && request.method === 'DELETE') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.DB.prepare('DELETE FROM functions WHERE id = ?').bind(funcMatch[1]).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/upload — subir archivo a R2 (admin) ───────── */
    if (pathname === '/api/upload' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const contentType = request.headers.get('Content-Type') ?? '';
      let fileBytes: ArrayBuffer;
      let mimeType: string;
      let ext: string;

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        if (!file) {
          return new Response(JSON.stringify({ error: 'No file provided' }), {
            status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        fileBytes = await file.arrayBuffer();
        mimeType = file.type || 'application/octet-stream';
        const nameParts = file.name.split('.');
        ext = nameParts.length > 1 ? nameParts.pop()! : 'bin';
      } else {
        fileBytes = await request.arrayBuffer();
        mimeType = contentType || 'application/octet-stream';
        const mimeToExt: Record<string, string> = {
          'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
          'image/gif': 'gif', 'image/svg+xml': 'svg',
        };
        ext = mimeToExt[mimeType] ?? 'bin';
      }

      if (fileBytes.byteLength > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'File too large (max 5MB)' }), {
          status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const timestamp = Date.now();
      const random = generateId(6);
      const key = `threats/${timestamp}-${random}.${ext}`;

      await env.ASSETS.put(key, fileBytes, {
        httpMetadata: { contentType: mimeType },
      });

      return new Response(JSON.stringify({ key, url: `/api/files/${key}` }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/files/* — servir archivos desde R2 ──────────── */
    const filesMatch = pathname.match(/^\/api\/files\/(.+)$/);
    if (filesMatch && request.method === 'GET') {
      const key = decodeURIComponent(filesMatch[1]);
      const object = await env.ASSETS.get(key);
      if (!object) {
        return new Response('File not found', {
          status: 404, headers: CORS_HEADERS,
        });
      }
      return new Response(object.body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    /* ── GET /api/threats — listar amenazas ─────────────────── */
    if (pathname === '/api/threats' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, name, description, data, updated_at FROM threats ORDER BY name ASC'
      ).all<{ id: string; name: string; description: string; data: string; updated_at: string }>();
      const results = rows.results.map(r => ({
        ...r,
        data: r.data ? JSON.parse(r.data) : {},
      }));
      return new Response(JSON.stringify(results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/threats/:id — obtener amenaza ────────────── */
    const threatMatch = pathname.match(/^\/api\/threats\/([a-zA-Z0-9]+)$/);
    if (threatMatch && request.method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT id, name, description, data, created_at, updated_at FROM threats WHERE id = ?'
      ).bind(threatMatch[1]).first<{ id: string; name: string; description: string; data: string; created_at: string; updated_at: string }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Threat not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ...row, data: JSON.parse(row.data) }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/threats — crear amenaza (admin) ──────────── */
    if (pathname === '/api/threats' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { name: string; description: string; data: unknown };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!body.name) {
        return new Response(JSON.stringify({ error: 'Missing name' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO threats (id, name, description, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, body.name, body.description ?? '', JSON.stringify(body.data ?? {}), now, now).run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PUT /api/threats/:id — actualizar amenaza (admin) ──── */
    if (threatMatch && request.method === 'PUT') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { name: string; description: string; data: unknown };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        'UPDATE threats SET name = ?, description = ?, data = ?, updated_at = ? WHERE id = ?'
      ).bind(body.name, body.description ?? '', JSON.stringify(body.data ?? {}), now, threatMatch[1]).run();
      if (!result.meta.changes) {
        return new Response(JSON.stringify({ error: 'Threat not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── DELETE /api/threats/:id — borrar amenaza (admin) ──── */
    if (threatMatch && request.method === 'DELETE') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.DB.prepare('DELETE FROM threats WHERE id = ?').bind(threatMatch[1]).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
