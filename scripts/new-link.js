'use strict';

// Crea un nuevo espacio (con su propio token) o lista los existentes.
// Usa DATABASE_URL si está definida (p. ej. en .env), si no la base local.
//   npm run new-link -- "Nombre"
//   npm run new-link -- --list

try { process.loadEnvFile(); } catch { /* sin archivo .env */ }

const path = require('node:path');
const { openDb, createSpace } = require('../src/db');

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

(async () => {
  const db = await openDb({ dir: process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'pglite') });
  const arg = process.argv[2];
  if (arg === '--list') {
    for (const s of await db.query('SELECT name, token, created_at, is_admin, disabled FROM spaces ORDER BY id')) {
      const tags = [s.is_admin && 'administrador', s.disabled && 'suspendido'].filter(Boolean).join(', ');
      console.log(`${s.name}  (${s.created_at.toISOString().slice(0, 10)})${tags ? `  [${tags}]` : ''}\n  ${BASE_URL}/t/${s.token}`);
    }
  } else {
    const space = await createSpace(db, { name: arg });
    console.log(`Espacio "${space.name}" creado:\n  ${BASE_URL}/t/${space.token}`);
  }
  await db.close();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
