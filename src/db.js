'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { DEFAULT_EXERCISES } = require('./catalog');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id          INTEGER PRIMARY KEY,
      token       TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL DEFAULT 'Mis entrenamientos',
      weekly_goal INTEGER NOT NULL DEFAULT 4,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id        INTEGER PRIMARY KEY,
      space_id  INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      muscle    TEXT NOT NULL,
      secondary TEXT NOT NULL DEFAULT '',
      archived  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (space_id, name)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY,
      space_id     INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      duration_min INTEGER,
      rpe          INTEGER,
      bodyweight   REAL,
      notes        TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_space_date ON sessions(space_id, date);

    CREATE TABLE IF NOT EXISTS session_exercises (
      id          INTEGER PRIMARY KEY,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id),
      position    INTEGER NOT NULL,
      rest_sec    INTEGER,
      notes       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS se_session ON session_exercises(session_id);
    CREATE INDEX IF NOT EXISTS se_exercise ON session_exercises(exercise_id);

    CREATE TABLE IF NOT EXISTS sets (
      id                  INTEGER PRIMARY KEY,
      session_exercise_id INTEGER NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
      position            INTEGER NOT NULL,
      reps                INTEGER,
      weight              REAL,
      rir                 INTEGER
    );
    CREATE INDEX IF NOT EXISTS sets_se ON sets(session_exercise_id);
  `);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function createSpace(db, { token = newToken(), name } = {}) {
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO spaces (token, name) VALUES (?, ?)')
      .run(token, name || 'Mis entrenamientos');
    const spaceId = info.lastInsertRowid;
    const insert = db.prepare(
      'INSERT INTO exercises (space_id, name, muscle, secondary) VALUES (?, ?, ?, ?)'
    );
    for (const [exName, muscle, secondary = []] of DEFAULT_EXERCISES) {
      insert.run(spaceId, exName, muscle, secondary.join(','));
    }
    return spaceId;
  });
  const id = tx();
  return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
}

function findSpaceByToken(db, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  return db.prepare('SELECT * FROM spaces WHERE token = ?').get(token) || null;
}

module.exports = { openDb, createSpace, findSpaceByToken, newToken };
