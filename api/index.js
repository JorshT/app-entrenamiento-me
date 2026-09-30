'use strict';

// Función serverless de Vercel: atiende todas las rutas /api/*.
// Requiere DATABASE_URL (Supabase) y ACCESS_TOKEN en las variables de entorno del proyecto.

const { openDb, ensureSpace } = require('../src/db');
const { createApp } = require('../src/app');

let ready;
function getDb() {
  ready ||= (async () => {
    if (!process.env.DATABASE_URL) throw new Error('Falta la variable DATABASE_URL');
    const db = await openDb();
    await ensureSpace(db, process.env.ACCESS_TOKEN);
    return db;
  })().catch((err) => {
    ready = null; // reintenta en el próximo request
    throw err;
  });
  return ready;
}

const app = createApp(getDb, { serveStatic: false });
module.exports = app;
