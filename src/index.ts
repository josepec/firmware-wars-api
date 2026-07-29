import { EmailMessage } from 'cloudflare:email';

interface Env {
  ASSETS: R2Bucket;
  META: KVNamespace;
  DB: D1Database;
  ADMIN_PASSWORD: string;
  /** Binding send_email de Email Routing (aviso de consultas). Opcional:
   *  sin él (p. ej. wrangler dev) las consultas se guardan igual sin aviso. */
  SEND_EMAIL?: SendEmail;
  /** Remitente (dirección del dominio de la zona) y destino verificado. */
  CONTACT_EMAIL_FROM?: string;
  CONTACT_EMAIL_TO?: string;
}

interface VersionMeta {
  major: number;
  minor: number;
  patch: number;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateId(len = 8): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => ID_CHARS[b % ID_CHARS.length]).join('');
}

const MAX_PAYLOAD = 32_000;

/** Codifica una cabecera en RFC 2047 si lleva caracteres no ASCII.
 *  Sin esto, un alias con tilde (o el asunto) rompe el mensaje. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  return `=?UTF-8?B?${b64}?=`;
}

/** Base64 del cuerpo en UTF-8, partido en líneas de 76 caracteres. */
function encodeBody(text: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Aviso por email de una consulta nueva (Email Routing send_email).
 *  Nunca lanza: sin binding/vars o con error, la consulta ya está guardada.
 *
 *  OJO con el MIME: Cloudflare valida el mensaje contra RFC 5322 y lo
 *  rechaza si le falta `Message-ID` o `Date`. El cuerpo va en base64
 *  porque el texto es UTF-8 y un 8bit sin declarar también lo tumba. */
async function sendContactEmail(env: Env, name: string, email: string | null, message: string): Promise<void> {
  if (!env.SEND_EMAIL || !env.CONTACT_EMAIL_FROM || !env.CONTACT_EMAIL_TO) {
    console.warn('[contact] Aviso omitido: falta SEND_EMAIL, CONTACT_EMAIL_FROM o CONTACT_EMAIL_TO');
    return;
  }
  try {
    const dominio = env.CONTACT_EMAIL_FROM.split('@')[1] ?? 'josepec.eu';
    const cuerpo = [
      `Alias: ${name}`,
      `Canal de respuesta: ${email ?? '(no indicado)'}`,
      '',
      message,
      '',
      '— Enviado desde /soporte · gestion en /admin/messages',
    ].join('\r\n');

    const raw = [
      `From: Firmware Wars Helpdesk <${env.CONTACT_EMAIL_FROM}>`,
      `To: ${env.CONTACT_EMAIL_TO}`,
      `Message-ID: <${crypto.randomUUID()}@${dominio}>`,
      `Date: ${new Date().toUTCString()}`,
      `Subject: ${encodeHeader(`[Firmware Wars] Consulta de ${name}`.slice(0, 120))}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(cuerpo),
    ].join('\r\n');

    await env.SEND_EMAIL.send(new EmailMessage(env.CONTACT_EMAIL_FROM, env.CONTACT_EMAIL_TO, raw));
    console.log('[contact] Aviso enviado a', env.CONTACT_EMAIL_TO);
  } catch (e) {
    // Sigue siendo best-effort — la consulta ya está en D1 —, pero ahora
    // el motivo queda en el log (`npx wrangler tail`) en vez de perderse.
    console.error('[contact] Fallo al enviar el aviso:', e instanceof Error ? e.message : e);
  }
}

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

    /* ── GET /campaign-pdf — redirige a la URL versionada ───── */
    if (pathname === '/campaign-pdf') {
      const meta = await env.META.get<VersionMeta>('campaign-version', 'json');
      if (!meta) {
        return new Response(
          'No hay ningún PDF de campaña generado todavía. Ejecuta: npm run publish-campaign patch',
          { status: 404, headers: CORS_HEADERS },
        );
      }
      const version = versionString(meta);
      return new Response(null, {
        status: 302,
        headers: { ...CORS_HEADERS, 'Location': `/campaign-pdf/v${version}`, 'Cache-Control': 'no-store' },
      });
    }

    /* ── GET /campaign-pdf/v{version} — sirve PDF desde R2 ─── */
    const campaignPdfMatch = pathname.match(/^\/campaign-pdf\/v([\d.]+)$/);
    if (campaignPdfMatch) {
      const version = campaignPdfMatch[1];
      const object = await env.ASSETS.get(`campaign-v${version}.pdf`);
      if (!object) {
        return new Response(`PDF campaña v${version} no encontrado.`, { status: 404, headers: CORS_HEADERS });
      }
      return new Response(object.body, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="firmware-wars-campaign-v${version}.pdf"`,
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

    /* ══ NOTICIAS (posts) ══════════════════════════════════════ */

    /* ── GET /api/posts — listado (público: publicados; admin: todos) ── */
    if (pathname === '/api/posts' && request.method === 'GET') {
      const isAdmin = verifyAdmin();
      const sql = isAdmin
        ? 'SELECT id, slug, title, header_image, published, published_at, created_at, updated_at FROM posts ORDER BY COALESCE(published_at, created_at) DESC'
        : 'SELECT id, slug, title, header_image, published_at FROM posts WHERE published = 1 ORDER BY published_at DESC';
      const rows = await env.DB.prepare(sql).all();
      return new Response(JSON.stringify(rows.results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/posts/:slug — detalle (borradores solo admin) ── */
    const postMatch = pathname.match(/^\/api\/posts\/([a-z0-9-]+)$/);
    if (postMatch && request.method === 'GET') {
      const isAdmin = verifyAdmin();
      // El editor admin carga por id; el público por slug — se aceptan ambos
      const row = await env.DB.prepare(
        'SELECT id, slug, title, content, header_image, published, published_at, created_at, updated_at FROM posts WHERE slug = ? OR id = ?'
      ).bind(postMatch[1], postMatch[1]).first();
      if (!row || (!isAdmin && !(row as { published: number }).published)) {
        return new Response(JSON.stringify({ error: 'Post not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(row), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/posts · PUT/DELETE /api/posts/:id (admin) ── */
    if ((pathname === '/api/posts' && request.method === 'POST')
        || (postMatch && (request.method === 'PUT' || request.method === 'DELETE'))) {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postMatch![1]).run();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { slug: string; title: string; content: string; headerImage?: string | null; published?: boolean };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const slug = (body.slug ?? '').trim();
      const title = (body.title ?? '').trim();
      const content = body.content ?? '';
      if (!title || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80 || content.length > 64_000) {
        return new Response(JSON.stringify({ error: 'Invalid post: title requerido, slug [a-z0-9-] ≤80, content ≤64KB' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const editId = request.method === 'PUT' ? postMatch![1] : null;
      const dup = await env.DB.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?')
        .bind(slug, editId ?? '').first();
      if (dup) {
        return new Response(JSON.stringify({ error: 'slug_exists' }), {
          status: 409, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const now = new Date().toISOString();
      const published = body.published ? 1 : 0;
      if (editId) {
        const prev = await env.DB.prepare('SELECT published_at FROM posts WHERE id = ?')
          .bind(editId).first<{ published_at: string | null }>();
        if (!prev) {
          return new Response(JSON.stringify({ error: 'Post not found' }), {
            status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        const publishedAt = published && !prev.published_at ? now : prev.published_at;
        await env.DB.prepare(
          'UPDATE posts SET slug = ?, title = ?, content = ?, header_image = ?, published = ?, published_at = ?, updated_at = ? WHERE id = ?'
        ).bind(slug, title, content, body.headerImage ?? null, published, publishedAt, now, editId).run();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO posts (id, slug, title, content, header_image, published, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, slug, title, content, body.headerImage ?? null, published, published ? now : null, now, now).run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ══ FAQS ══════════════════════════════════════════════════ */

    /* ── GET /api/faqs — listado (público: publicadas; admin: todas) ── */
    if (pathname === '/api/faqs' && request.method === 'GET') {
      const sql = verifyAdmin()
        ? 'SELECT id, question, answer, sort_order, published FROM faqs ORDER BY sort_order ASC, created_at ASC'
        : 'SELECT id, question, answer, sort_order FROM faqs WHERE published = 1 ORDER BY sort_order ASC, created_at ASC';
      const rows = await env.DB.prepare(sql).all();
      return new Response(JSON.stringify(rows.results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/faqs · PUT/DELETE /api/faqs/:id (admin) ───── */
    const faqMatch = pathname.match(/^\/api\/faqs\/([a-z0-9]+)$/);
    if ((pathname === '/api/faqs' && request.method === 'POST')
        || (faqMatch && (request.method === 'PUT' || request.method === 'DELETE'))) {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM faqs WHERE id = ?').bind(faqMatch![1]).run();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { question: string; answer: string; sortOrder?: number; published?: boolean };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const question = (body.question ?? '').trim();
      const answer = body.answer ?? '';
      const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder! : 0;
      if (!question || question.length > 300 || answer.length > 16_000) {
        return new Response(JSON.stringify({ error: 'Invalid FAQ: question requerida ≤300, answer ≤16KB' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const now = new Date().toISOString();
      if (faqMatch && request.method === 'PUT') {
        const result = await env.DB.prepare(
          'UPDATE faqs SET question = ?, answer = ?, sort_order = ?, published = ?, updated_at = ? WHERE id = ?'
        ).bind(question, answer, sortOrder, body.published ? 1 : 0, now, faqMatch[1]).run();
        if (!result.meta.changes) {
          return new Response(JSON.stringify({ error: 'FAQ not found' }), {
            status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO faqs (id, question, answer, sort_order, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, question, answer, sortOrder, body.published ? 1 : 0, now, now).run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ══ CONSULTAS (contacto) ══════════════════════════════════ */

    /* ── POST /api/contact — enviar consulta (PÚBLICO) ────────── */
    if (pathname === '/api/contact' && request.method === 'POST') {
      const len = parseInt(request.headers.get('content-length') ?? '0', 10);
      if (len > 8_000) {
        return new Response(JSON.stringify({ error: 'Payload too large' }), {
          status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { name?: string; email?: string; message?: string; website?: string };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      // Honeypot: los bots rellenan el campo oculto — éxito falso sin guardar
      if (body.website) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const name = (body.name ?? '').trim();
      const email = (body.email ?? '').trim();
      const message = (body.message ?? '').trim();
      const emailOk = email === '' || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120);
      if (!name || name.length > 80 || !emailOk || message.length < 10 || message.length > 2_000) {
        return new Response(JSON.stringify({ error: 'Invalid: name 1-80, email opcional válido, message 10-2000' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      // Rate limit: 5 consultas/hora por IP (contador KV con TTL)
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const rlKey = `contact:${ip}`;
      const count = parseInt((await env.META.get(rlKey)) ?? '0', 10);
      if (count >= 5) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.META.put(rlKey, String(count + 1), { expirationTtl: 3600 });
      const id = generateId();
      await env.DB.prepare(
        'INSERT INTO contact_messages (id, name, email, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)'
      ).bind(id, name, email || null, message, new Date().toISOString()).run();
      await sendContactEmail(env, name, email || null, message);
      return new Response(JSON.stringify({ ok: true }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/contact — bandeja (admin) ───────────────────── */
    if (pathname === '/api/contact' && request.method === 'GET') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const rows = await env.DB.prepare(
        'SELECT id, name, email, message, read, created_at FROM contact_messages ORDER BY created_at DESC'
      ).all<{ read: number }>();
      const unread = rows.results.filter(r => !r.read).length;
      return new Response(JSON.stringify({ messages: rows.results, unread }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PUT /api/contact/:id/read · DELETE /api/contact/:id (admin) ── */
    const contactReadMatch = pathname.match(/^\/api\/contact\/([a-z0-9]+)\/read$/);
    const contactMatch = pathname.match(/^\/api\/contact\/([a-z0-9]+)$/);
    if ((contactReadMatch && request.method === 'PUT') || (contactMatch && request.method === 'DELETE')) {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (contactReadMatch) {
        let body: { read?: boolean };
        try { body = await request.json(); } catch { body = {}; }
        await env.DB.prepare('UPDATE contact_messages SET read = ? WHERE id = ?')
          .bind(body.read === false ? 0 : 1, contactReadMatch[1]).run();
      } else {
        await env.DB.prepare('DELETE FROM contact_messages WHERE id = ?').bind(contactMatch![1]).run();
      }
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
      const requestedPrefix = new URL(request.url).searchParams.get('prefix') ?? 'threats';
      const prefix = ['threats', 'blog'].includes(requestedPrefix) ? requestedPrefix : 'threats';
      const key = `${prefix}/${timestamp}-${random}.${ext}`;

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

    /* ── GET /api/battles — listar reports (admin) ──────────── */
    if (pathname === '/api/battles' && request.method === 'GET') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const rows = await env.DB.prepare(
        `SELECT id, title, status, winner, player1_alias, player2_alias, created_at,
                COALESCE(mode, 'pvp') AS mode,
                (CASE WHEN events LIKE '%"kind":"debug_enabled"%' THEN 1 ELSE 0 END) AS is_debug
         FROM battle_reports ORDER BY created_at DESC`
      ).all<{ id: string; title: string; status: string; winner: number | null; player1_alias: string; player2_alias: string; created_at: string; mode: string; is_debug: number }>();
      const results = rows.results.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        winner: r.winner,
        player1Alias: r.player1_alias,
        player2Alias: r.player2_alias,
        createdAt: r.created_at,
        isDebug: r.is_debug === 1,
        mode: r.mode,
      }));
      return new Response(JSON.stringify(results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── GET /api/battles/stats — balance stats (admin) ───────── */
    if (pathname === '/api/battles/stats' && request.method === 'GET') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const modeFilter = new URL(request.url).searchParams.get('mode');
      const filterByMode = modeFilter !== null && ['pvp', 'pvc', 'cvc'].includes(modeFilter);
      const statRows = await env.DB.prepare(
        `SELECT initial_snapshot, events, winner FROM battle_reports
         WHERE status = 'finished'
           AND events NOT LIKE '%"kind":"debug_enabled"%'
           ${filterByMode ? `AND COALESCE(mode, 'pvp') = ?` : ''}`
      ).bind(...(filterByMode ? [modeFilter] : [])).all<{ initial_snapshot: string; events: string; winner: number | null }>();
      const modeRows = await env.DB.prepare(
        `SELECT COALESCE(mode, 'pvp') AS m, COUNT(*) AS c FROM battle_reports
         WHERE status = 'finished'
           AND events NOT LIKE '%"kind":"debug_enabled"%'
         GROUP BY m`
      ).all<{ m: string; c: number }>();
      const byMode: Record<string, number> = { pvp: 0, pvc: 0, cvc: 0 };
      for (const r of modeRows.results) byMode[r.m] = r.c;
      type FmtKey = '1v1' | '2v2';
      interface Acc {
        count: number; totalRounds: number;
        winP1: number; winP2: number; draw: number;
        roundDist: number[]; deathsByRound: number[];
        firstDeathByRound: number[];
        damageSumByRound: number[]; damageCountByRound: number[];
        bugsAddedByRound: number[];
      }
      const MAX = 10;
      const mk = (): Acc => ({
        count: 0, totalRounds: 0, winP1: 0, winP2: 0, draw: 0,
        roundDist: Array(MAX).fill(0), deathsByRound: Array(MAX).fill(0),
        firstDeathByRound: Array(MAX).fill(0),
        damageSumByRound: Array(MAX).fill(0), damageCountByRound: Array(MAX).fill(0),
        bugsAddedByRound: Array(MAX).fill(0),
      });
      const acc: Record<FmtKey, Acc> = { '1v1': mk(), '2v2': mk() };
      for (const row of statRows.results) {
        let snap: { bots: unknown[] };
        let evs: Array<{ turn: number; phase: string; kind: string; payload: Record<string, unknown> }>;
        try { snap = JSON.parse(row.initial_snapshot); evs = JSON.parse(row.events); } catch { continue; }
        const fmt: FmtKey = (snap.bots?.length ?? 2) <= 2 ? '1v1' : '2v2';
        const a = acc[fmt];
        a.count++;
        if (row.winner === 1) a.winP1++; else if (row.winner === 2) a.winP2++; else a.draw++;
        const rounds = evs.filter(e => e.kind === 'round_ended').length;
        a.totalRounds += rounds;
        if (rounds >= 1 && rounds <= MAX) a.roundDist[rounds - 1]++;
        let fd: number | null = null;
        for (const ev of evs) {
          if (ev.phase !== 'run') continue;
          const r = ev.turn; if (r < 1 || r > MAX) continue;
          if (ev.kind === 'destroyed') {
            a.deathsByRound[r - 1]++;
            if (fd === null || r < fd) fd = r;
          } else if (ev.kind === 'attack_hit') {
            const dmg = ev.payload['damage'];
            if (typeof dmg === 'number' && dmg > 0) {
              a.damageSumByRound[r - 1] += dmg; a.damageCountByRound[r - 1]++;
            }
          } else if (ev.kind === 'bug_added') {
            a.bugsAddedByRound[r - 1]++;
          }
        }
        if (fd !== null) a.firstDeathByRound[fd - 1]++;
      }
      const trim = (arr: number[]) => {
        let i = arr.length - 1; while (i > 0 && arr[i] === 0) i--; return arr.slice(0, i + 1);
      };
      const finalize = (a: Acc) => ({
        count: a.count,
        avgRounds: a.count > 0 ? Math.round(a.totalRounds / a.count * 10) / 10 : 0,
        winP1: a.winP1, winP2: a.winP2, draw: a.draw,
        roundDist: trim(a.roundDist),
        deathsByRound: trim(a.deathsByRound),
        firstDeathByRound: trim(a.firstDeathByRound),
        avgDamageByRound: trim(a.damageSumByRound.map((s, i) => {
          const c = a.damageCountByRound[i]; return c > 0 ? Math.round(s / c * 10) / 10 : 0;
        })),
        bugsAddedByRound: trim(a.bugsAddedByRound),
      });
      return new Response(JSON.stringify({
        total: statRows.results.length,
        byMode,
        '1v1': finalize(acc['1v1']),
        '2v2': finalize(acc['2v2']),
      }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    /* ── GET /api/battles/:id — obtener report completo (admin) ── */
    const battleMatch = pathname.match(/^\/api\/battles\/([a-z0-9]+)$/);
    if (battleMatch && request.method === 'GET') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const row = await env.DB.prepare(
        `SELECT id, title, scenario_id, list1_id, list2_id, player1_alias, player2_alias,
                status, winner, COALESCE(mode, 'pvp') AS mode,
                initial_snapshot, events, final_state, created_at, updated_at
         FROM battle_reports WHERE id = ?`
      ).bind(battleMatch[1]).first<{
        id: string; title: string; scenario_id: string | null; list1_id: string; list2_id: string;
        player1_alias: string; player2_alias: string; status: string; winner: number | null;
        mode: string; initial_snapshot: string; events: string; final_state: string | null;
        created_at: string; updated_at: string;
      }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Battle not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: row.id,
        title: row.title,
        scenarioId: row.scenario_id,
        list1Id: row.list1_id,
        list2Id: row.list2_id,
        player1Alias: row.player1_alias,
        player2Alias: row.player2_alias,
        status: row.status,
        winner: row.winner,
        mode: row.mode,
        initialSnapshot: JSON.parse(row.initial_snapshot),
        events: JSON.parse(row.events),
        finalState: row.final_state ? JSON.parse(row.final_state) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/battles — crear report (admin) ──────────── */
    if (pathname === '/api/battles' && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: {
        title: string; scenarioId?: string | null; list1Id: string; list2Id: string;
        player1Alias: string; player2Alias: string; initialSnapshot: unknown;
        mode?: string;
      };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!body.title || !body.list1Id || !body.list2Id || !body.initialSnapshot) {
        return new Response(JSON.stringify({ error: 'Missing fields' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const mode = ['pvp', 'pvc', 'cvc'].includes(body.mode ?? '') ? body.mode! : 'pvp';
      const id = generateId();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO battle_reports
         (id, title, scenario_id, list1_id, list2_id, player1_alias, player2_alias,
          status, winner, mode, initial_snapshot, events, final_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?, ?, '[]', NULL, ?, ?)`
      ).bind(
        id, body.title, body.scenarioId ?? null, body.list1Id, body.list2Id,
        body.player1Alias ?? '', body.player2Alias ?? '', mode,
        JSON.stringify(body.initialSnapshot), now, now,
      ).run();
      return new Response(JSON.stringify({ id }), {
        status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PATCH /api/battles/:id/events — append-only (admin) ── */
    const battleEventsMatch = pathname.match(/^\/api\/battles\/([a-z0-9]+)\/events$/);
    if (battleEventsMatch && request.method === 'PATCH') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { events: unknown[] };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (!Array.isArray(body.events)) {
        return new Response(JSON.stringify({ error: 'events must be an array' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const row = await env.DB.prepare(
        'SELECT events FROM battle_reports WHERE id = ?'
      ).bind(battleEventsMatch[1]).first<{ events: string }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Battle not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const existing = JSON.parse(row.events) as unknown[];
      const merged = [...existing, ...body.events];
      const now = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE battle_reports SET events = ?, updated_at = ? WHERE id = ?'
      ).bind(JSON.stringify(merged), now, battleEventsMatch[1]).run();
      return new Response(JSON.stringify({ ok: true, count: merged.length }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── POST /api/battles/:id/events/truncate — Debug rewind (admin) ── */
    const battleTruncateMatch = pathname.match(/^\/api\/battles\/([a-z0-9]+)\/events\/truncate$/);
    if (battleTruncateMatch && request.method === 'POST') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { keepFirst: number };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (typeof body.keepFirst !== 'number' || body.keepFirst < 0) {
        return new Response(JSON.stringify({ error: 'keepFirst must be a non-negative number' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const row = await env.DB.prepare(
        'SELECT events FROM battle_reports WHERE id = ?'
      ).bind(battleTruncateMatch[1]).first<{ events: string }>();
      if (!row) {
        return new Response(JSON.stringify({ error: 'Battle not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const existing = JSON.parse(row.events) as unknown[];
      const truncated = existing.slice(0, body.keepFirst);
      const now = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE battle_reports SET events = ?, updated_at = ? WHERE id = ?'
      ).bind(JSON.stringify(truncated), now, battleTruncateMatch[1]).run();
      return new Response(JSON.stringify({ ok: true, count: truncated.length }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── PATCH /api/battles/:id/finish — cerrar partida (admin) ── */
    const battleFinishMatch = pathname.match(/^\/api\/battles\/([a-z0-9]+)\/finish$/);
    if (battleFinishMatch && request.method === 'PATCH') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      let body: { winner: 1 | 2 | null; finalState: unknown };
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        `UPDATE battle_reports SET status = 'finished', winner = ?, final_state = ?, updated_at = ?
         WHERE id = ?`
      ).bind(
        body.winner ?? null,
        body.finalState ? JSON.stringify(body.finalState) : null,
        now,
        battleFinishMatch[1],
      ).run();
      if (!result.meta.changes) {
        return new Response(JSON.stringify({ error: 'Battle not found' }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    /* ── DELETE /api/battles/:id — borrar report (admin) ──── */
    if (battleMatch && request.method === 'DELETE') {
      if (!verifyAdmin()) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      await env.DB.prepare('DELETE FROM battle_reports WHERE id = ?').bind(battleMatch[1]).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
