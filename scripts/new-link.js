'use strict';

// Crea un nuevo espacio (con su propio token) o lista los existentes.
//   npm run new-link -- "Nombre"
//   npm run new-link -- --list

const path = require('node:path');
const { openDb, createSpace } = require('../src/db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const db = openDb(path.join(DATA_DIR, 'entrenamientos.db'));

const arg = process.argv[2];
if (arg === '--list') {
  for (const s of db.prepare('SELECT name, token, created_at FROM spaces ORDER BY id').all()) {
    console.log(`${s.name}  (${s.created_at})\n  ${BASE_URL}/t/${s.token}`);
  }
} else {
  const space = createSpace(db, { name: arg });
  console.log(`Espacio "${space.name}" creado:\n  ${BASE_URL}/t/${space.token}`);
}
