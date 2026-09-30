'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_EXERCISES } = require('./catalog');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const DATE_OID = 1082;

// Interfaz común para Postgres (Supabase) y PGlite (local/pruebas):
//   db.query(sql, params) -> filas
//   db.one(sql, params)   -> primera fila o null
//   db.tx(async (q) => …) -> ejecuta en una transacción; q tiene query/one
function wrap(queryFn) {
  const q = {
    query: async (sql, params = []) => (await queryFn(sql, params)).rows,
    one: async (sql, params = []) => (await queryFn(sql, params)).rows[0] || null,
  };
  return q;
}

// Postgres real, p. ej. Supabase. DATABASE_URL = cadena de conexión.
function connectPg(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(DATE_OID, (v) => v); // fechas como 'YYYY-MM-DD'
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10000,
  });
  const db = wrap((sql, params) => pool.query(sql, params));
  db.exec = (sql) => pool.query(sql);
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap((sql, params) => client.query(sql, params)));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  return db;
}

// Postgres embebido (sin instalar nada). dir = carpeta de datos, o undefined = en memoria.
async function connectPglite(dir) {
  const { PGlite } = require('@electric-sql/pglite');
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite({ dataDir: dir, parsers: { [DATE_OID]: (v) => v } });
  await pg.waitReady;
  let chain = Promise.resolve();
  // PGlite tiene una sola conexión: serializamos las transacciones.
  const db = wrap((sql, params) => pg.query(sql, params));
  db.exec = (sql) => pg.exec(sql);
  db.tx = (fn) => {
    const run = chain.then(() => pg.transaction((tx) => fn(wrap((sql, params) => tx.query(sql, params)))));
    chain = run.catch(() => {});
    return run;
  };
  db.close = () => pg.close();
  return db;
}

async function openDb({ url = process.env.DATABASE_URL, dir } = {}) {
  const db = url ? connectPg(url) : await connectPglite(dir);
  await db.exec(SCHEMA);
  return db;
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createSpace(db, { token = newToken(), name } = {}) {
  return db.tx(async (q) => {
    // El primer espacio que se crea es el del administrador.
    const space = await q.one(
      `INSERT INTO spaces (token, name, is_admin)
       VALUES ($1, $2, NOT EXISTS (SELECT 1 FROM spaces WHERE is_admin)) RETURNING *`,
      [token, name || 'Mis entrenamientos']
    );
    const names = DEFAULT_EXERCISES.map((e) => e[0]);
    const muscles = DEFAULT_EXERCISES.map((e) => e[1]);
    const secondary = DEFAULT_EXERCISES.map((e) => (e[2] || []).join(','));
    await q.query(
      `INSERT INTO exercises (space_id, name, muscle, secondary)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[])`,
      [space.id, names, muscles, secondary]
    );
    return space;
  });
}

async function findSpaceByToken(db, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  return db.one('SELECT * FROM spaces WHERE token = $1', [token]);
}

// Crea el espacio de ACCESS_TOKEN solo si la base está vacía (primer despliegue).
// Así, tras "Generar enlace nuevo" el token viejo deja de funcionar y no se recrea.
async function ensureSpace(db, token) {
  if (!token) return null;
  token = token.trim();
  if (token.length < 16) throw new Error('ACCESS_TOKEN debe tener al menos 16 caracteres.');
  const existing = await findSpaceByToken(db, token);
  if (existing) return existing;
  const { n } = await db.one('SELECT COUNT(*)::int AS n FROM spaces');
  if (n > 0) return null;
  try {
    return await createSpace(db, { token });
  } catch (e) {
    if (e.code === '23505') return findSpaceByToken(db, token); // otra instancia lo creó
    throw e;
  }
}

module.exports = { openDb, createSpace, findSpaceByToken, ensureSpace, newToken };
