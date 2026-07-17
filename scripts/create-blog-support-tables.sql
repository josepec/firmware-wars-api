-- Tablas para Noticias (posts), FAQs y Consultas (contacto).
-- Ejecutar con:
--   npx wrangler d1 execute firmware-wars-lists --remote --file scripts/create-blog-support-tables.sql
--
-- Nota: borrar un post NO borra sus imágenes de R2 (mismo comportamiento que
-- threats); limpieza manual con `wrangler r2 object` si hiciera falta.

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  header_image TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_pub ON posts(published, published_at DESC);

CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_faqs_order ON faqs(published, sort_order);

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_read ON contact_messages(read);
