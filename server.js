'use strict';

// Servidor para uso local o en un VPS. En Vercel se usa api/index.js.
//   - Con DATABASE_URL se conecta a Postgres (Supabase).
//   - Sin DATABASE_URL usa un Postgres embebido (PGlite) guardado en ./data.

try { process.loadEnvFile(); } catch { /* sin archivo .env */ }

const path = require('node:path');
const { openDb, createSpace, ensureSpace } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

(async () => {
  const db = await openDb({ dir: process.env.DATA_DIR || path.join(__dirname, 'data', 'pglite') });
  console.log(process.env.DATABASE_URL ? 'Base de datos: Postgres (DATABASE_URL)' : 'Base de datos: local (PGlite en ./data)');

  await ensureSpace(db, process.env.ACCESS_TOKEN);

  // En el primer arranque se crea un espacio y se muestra su enlace.
  const { n } = await db.one('SELECT COUNT(*)::int AS n FROM spaces');
  if (n === 0) {
    const space = await createSpace(db);
    console.log('\n  Se creó tu espacio de entrenamiento. Guarda este enlace (es tu "llave"):');
    console.log(`  ${BASE_URL}/t/${space.token}\n`);
  }

  createApp(db).listen(PORT, () => console.log(`App de entrenamiento escuchando en ${BASE_URL}`));
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
