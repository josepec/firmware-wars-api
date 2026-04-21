-- Tabla para Battle Reports del simulador de partidas.
-- Ejecutar con:
--   npx wrangler d1 execute <DB_NAME> --remote --file scripts/create-battle-reports-table.sql
-- (Sustituir <DB_NAME> por el nombre del binding definido en wrangler.jsonc).

CREATE TABLE IF NOT EXISTS battle_reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scenario_id TEXT,
  list1_id TEXT NOT NULL,
  list2_id TEXT NOT NULL,
  player1_alias TEXT NOT NULL,
  player2_alias TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  winner INTEGER,
  initial_snapshot TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  final_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_battle_reports_created ON battle_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_battle_reports_status ON battle_reports(status);
