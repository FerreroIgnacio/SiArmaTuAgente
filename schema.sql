-- Esquema de D1. Aplicar con: npx wrangler d1 execute siarma --remote --file schema.sql
CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, dueno TEXT NOT NULL, datos TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bots_dueno ON bots (dueno);
-- Charla en curso por bot y chat (clave bot:chat); vence a los 10 min sin mensajes y la borra el cron
CREATE TABLE IF NOT EXISTS charlas (clave TEXT PRIMARY KEY, datos TEXT NOT NULL, vence INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS charlas_vence ON charlas (vence);
CREATE TABLE IF NOT EXISTS metricas (bot TEXT PRIMARY KEY, datos TEXT NOT NULL);
-- Cuenta de Google del dueño (refresh token cifrado)
CREATE TABLE IF NOT EXISTS google (sub TEXT PRIMARY KEY, datos TEXT NOT NULL);
-- Versión de las sesiones de cada usuario ("cerrar sesión en todos los dispositivos")
CREATE TABLE IF NOT EXISTS sesiones (sub TEXT PRIMARY KEY, ver INTEGER NOT NULL);
-- API de Meta: registro de conversaciones (7 días), lo que hay que hacer más tarde por chat y mensajes ya procesados
CREATE TABLE IF NOT EXISTS registro (bot TEXT NOT NULL, ts INTEGER NOT NULL, datos TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS registro_bot_ts ON registro (bot, ts);
CREATE TABLE IF NOT EXISTS pendientes (bot TEXT NOT NULL, chat TEXT NOT NULL, nombre TEXT, tipo TEXT NOT NULL, valor TEXT, cuando INTEGER NOT NULL, PRIMARY KEY (bot, chat));
CREATE INDEX IF NOT EXISTS pendientes_cuando ON pendientes (cuando);
CREATE TABLE IF NOT EXISTS meta_vistos (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- Planillas de los agentes (datos de las filas en JSON); opcionalmente sincronizadas con una Sheet del Drive del dueño
CREATE TABLE IF NOT EXISTS planillas (id TEXT PRIMARY KEY, dueno TEXT NOT NULL, datos TEXT NOT NULL, modificada INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS planillas_dueno ON planillas (dueno);
