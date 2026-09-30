'use strict';

const path = require('node:path');
const { openDb, createSpace, findSpaceByToken } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const db = openDb(path.join(DATA_DIR, 'entrenamientos.db'));

// ACCESS_TOKEN permite fijar el enlace desde variables de entorno (útil en hostings).
if (process.env.ACCESS_TOKEN) {
  const token = process.env.ACCESS_TOKEN.trim();
  if (token.length < 16) {
    console.error('ACCESS_TOKEN debe tener al menos 16 caracteres.');
    process.exit(1);
  }
  if (!findSpaceByToken(db, token)) createSpace(db, { token });
}

// En el primer arranque se crea un espacio y se muestra su enlace.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM spaces').get();
if (n === 0) {
  const space = createSpace(db);
  console.log('\n  Se creó tu espacio de entrenamiento. Guarda este enlace (es tu "llave"):');
  console.log(`  ${BASE_URL}/t/${space.token}\n`);
}

createApp(db).listen(PORT, () => {
  console.log(`App de entrenamiento escuchando en ${BASE_URL}`);
});
