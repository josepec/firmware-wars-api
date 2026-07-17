-- Añade la columna `mode` (pvp | pvc | cvc) a battle_reports.
-- NULL = partida anterior a la función = pvp (se lee con COALESCE(mode,'pvp')).
-- Ejecutar con:
--   npx wrangler d1 execute <DB_NAME> --remote --file scripts/add-mode-column.sql
-- (Sustituir <DB_NAME> por el nombre del binding definido en wrangler.jsonc).

ALTER TABLE battle_reports ADD COLUMN mode TEXT;
