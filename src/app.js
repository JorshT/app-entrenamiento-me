'use strict';

const path = require('node:path');
const express = require('express');
const { findSpaceByToken, newToken } = require('./db');
const { computeStats, e1rm } = require('./stats');
const { MUSCLES } = require('./catalog');
const D = require('./dates');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Validación ----------

function optInt(v, min, max, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Valor inválido en "${field}"`);
  return Math.round(n);
}

function optNum(v, min, max, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Valor inválido en "${field}"`);
  return Math.round(n * 100) / 100;
}

function str(v, max, field) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw new HttpError(400, `Valor inválido en "${field}"`);
  return v.trim().slice(0, max);
}

function validMuscle(m, field = 'muscle') {
  if (!Object.hasOwn(MUSCLES, m)) throw new HttpError(400, `Grupo muscular inválido en "${field}"`);
  return m;
}

function parseSecondary(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]
    .map((m) => validMuscle(m, 'secondary'))
    .join(',');
}

function parseSession(body, validExerciseIds) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Cuerpo inválido');
  if (!D.isIsoDate(body.date)) throw new HttpError(400, 'Fecha inválida (usa AAAA-MM-DD)');
  const exercises = Array.isArray(body.exercises) ? body.exercises : [];
  if (exercises.length > 60) throw new HttpError(400, 'Demasiados ejercicios');
  return {
    date: body.date,
    title: str(body.title, 120, 'title'),
    duration_min: optInt(body.duration_min, 0, 1440, 'duration_min'),
    rpe: optInt(body.rpe, 1, 10, 'rpe'),
    bodyweight: optNum(body.bodyweight, 0, 500, 'bodyweight'),
    notes: str(body.notes, 4000, 'notes'),
    exercises: exercises.map((ex, i) => {
      const exerciseId = Number(ex && ex.exercise_id);
      if (!validExerciseIds(exerciseId)) throw new HttpError(400, `Ejercicio #${i + 1} no existe`);
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      if (sets.length > 100) throw new HttpError(400, 'Demasiadas series');
      return {
        exercise_id: exerciseId,
        rest_sec: optInt(ex.rest_sec, 0, 3600, 'rest_sec'),
        notes: str(ex.notes, 2000, 'notes'),
        sets: sets.map((s) => ({
          reps: optInt(s && s.reps, 0, 10000, 'reps'),
          weight: optNum(s && s.weight, 0, 2000, 'weight'),
          rir: optInt(s && s.rir, 0, 10, 'rir'),
        })),
      };
    }),
  };
}

// ---------- Acceso a datos ----------

function listExercises(db, spaceId) {
  return db
    .prepare(
      `SELECT e.id, e.name, e.muscle, e.secondary, e.archived,
              (SELECT COUNT(*) FROM session_exercises se WHERE se.exercise_id = e.id) AS uses
         FROM exercises e WHERE e.space_id = ? ORDER BY e.name COLLATE NOCASE`
    )
    .all(spaceId)
    .map((e) => ({ ...e, secondary: e.secondary ? e.secondary.split(',') : [], archived: !!e.archived }));
}

function getSession(db, spaceId, id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND space_id = ?').get(id, spaceId);
  if (!s) return null;
  const exercises = db
    .prepare(
      `SELECT se.id, se.exercise_id, se.rest_sec, se.notes, e.name, e.muscle, e.secondary
         FROM session_exercises se JOIN exercises e ON e.id = se.exercise_id
        WHERE se.session_id = ? ORDER BY se.position`
    )
    .all(id);
  const setsStmt = db.prepare(
    'SELECT reps, weight, rir FROM sets WHERE session_exercise_id = ? ORDER BY position'
  );
  s.exercises = exercises.map((ex) => ({
    exercise_id: ex.exercise_id,
    name: ex.name,
    muscle: ex.muscle,
    secondary: ex.secondary ? ex.secondary.split(',') : [],
    rest_sec: ex.rest_sec,
    notes: ex.notes,
    sets: setsStmt.all(ex.id),
  }));
  return s;
}

function writeSessionChildren(db, sessionId, exercises) {
  db.prepare('DELETE FROM session_exercises WHERE session_id = ?').run(sessionId);
  const insEx = db.prepare(
    'INSERT INTO session_exercises (session_id, exercise_id, position, rest_sec, notes) VALUES (?, ?, ?, ?, ?)'
  );
  const insSet = db.prepare(
    'INSERT INTO sets (session_exercise_id, position, reps, weight, rir) VALUES (?, ?, ?, ?, ?)'
  );
  exercises.forEach((ex, i) => {
    const seId = insEx.run(sessionId, ex.exercise_id, i, ex.rest_sec, ex.notes).lastInsertRowid;
    ex.sets.forEach((s, j) => insSet.run(seId, j, s.reps, s.weight, s.rir));
  });
}

function exerciseIdChecker(db, spaceId) {
  const ids = new Set(
    db.prepare('SELECT id FROM exercises WHERE space_id = ?').all(spaceId).map((r) => r.id)
  );
  return (id) => ids.has(id);
}

// ---------- App ----------

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // El token viaja en la URL: evitamos que se filtre por Referer o buscadores.
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  const api = express.Router();

  api.use('/s/:token', (req, res, next) => {
    const space = findSpaceByToken(db, req.params.token);
    if (!space) return res.status(404).json({ error: 'Enlace no válido' });
    req.space = space;
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/s/:token/me', (req, res) => {
    const { id, token, ...rest } = req.space;
    res.json({ ...rest, muscles: MUSCLES });
  });

  api.patch('/s/:token/me', (req, res) => {
    const name = req.body.name !== undefined ? str(req.body.name, 80, 'name') || 'Mis entrenamientos' : req.space.name;
    const goal = req.body.weekly_goal !== undefined ? optInt(req.body.weekly_goal, 1, 14, 'weekly_goal') : req.space.weekly_goal;
    db.prepare('UPDATE spaces SET name = ?, weekly_goal = ? WHERE id = ?').run(name, goal || 4, req.space.id);
    res.json({ ok: true });
  });

  // Genera un token nuevo e invalida el anterior (por si el enlace se filtró).
  api.post('/s/:token/rotate', (req, res) => {
    const token = newToken();
    db.prepare('UPDATE spaces SET token = ? WHERE id = ?').run(token, req.space.id);
    res.json({ token });
  });

  // --- Ejercicios ---
  api.get('/s/:token/exercises', (req, res) => {
    res.json(listExercises(db, req.space.id));
  });

  api.post('/s/:token/exercises', (req, res) => {
    const name = str(req.body.name, 80, 'name');
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const muscle = validMuscle(req.body.muscle);
    const secondary = parseSecondary(req.body.secondary);
    try {
      const info = db
        .prepare('INSERT INTO exercises (space_id, name, muscle, secondary) VALUES (?, ?, ?, ?)')
        .run(req.space.id, name, muscle, secondary);
      res.status(201).json({ id: Number(info.lastInsertRowid), name, muscle, secondary: secondary ? secondary.split(',') : [], archived: false, uses: 0 });
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'Ya existe un ejercicio con ese nombre');
      throw e;
    }
  });

  api.patch('/s/:token/exercises/:id', (req, res) => {
    const ex = db.prepare('SELECT * FROM exercises WHERE id = ? AND space_id = ?').get(req.params.id, req.space.id);
    if (!ex) throw new HttpError(404, 'Ejercicio no encontrado');
    const name = req.body.name !== undefined ? str(req.body.name, 80, 'name') : ex.name;
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const muscle = req.body.muscle !== undefined ? validMuscle(req.body.muscle) : ex.muscle;
    const secondary = req.body.secondary !== undefined ? parseSecondary(req.body.secondary) : ex.secondary;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : ex.archived;
    try {
      db.prepare('UPDATE exercises SET name = ?, muscle = ?, secondary = ?, archived = ? WHERE id = ?').run(
        name,
        muscle,
        secondary,
        archived,
        ex.id
      );
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'Ya existe un ejercicio con ese nombre');
      throw e;
    }
    res.json({ ok: true });
  });

  api.delete('/s/:token/exercises/:id', (req, res) => {
    const ex = db.prepare('SELECT id FROM exercises WHERE id = ? AND space_id = ?').get(req.params.id, req.space.id);
    if (!ex) throw new HttpError(404, 'Ejercicio no encontrado');
    const used = db.prepare('SELECT COUNT(*) AS n FROM session_exercises WHERE exercise_id = ?').get(ex.id).n;
    if (used) {
      // Si tiene historial no se borra: se archiva para no perder datos.
      db.prepare('UPDATE exercises SET archived = 1 WHERE id = ?').run(ex.id);
      return res.json({ archived: true });
    }
    db.prepare('DELETE FROM exercises WHERE id = ?').run(ex.id);
    res.json({ deleted: true });
  });

  api.get('/s/:token/exercises/:id/history', (req, res) => {
    const ex = db.prepare('SELECT * FROM exercises WHERE id = ? AND space_id = ?').get(req.params.id, req.space.id);
    if (!ex) throw new HttpError(404, 'Ejercicio no encontrado');
    const limit = optInt(req.query.limit, 1, 500, 'limit') || 20;
    const entries = db
      .prepare(
        `SELECT se.id, s.id AS session_id, s.date, s.title, se.rest_sec, se.notes
           FROM session_exercises se JOIN sessions s ON s.id = se.session_id
          WHERE se.exercise_id = ? AND s.space_id = ?
          ORDER BY s.date DESC, s.id DESC LIMIT ?`
      )
      .all(ex.id, req.space.id, limit);
    const setsStmt = db.prepare('SELECT reps, weight, rir FROM sets WHERE session_exercise_id = ? ORDER BY position');
    let bestWeight = 0;
    let bestE1rm = 0;
    const history = entries.map(({ id, ...e }) => {
      const sets = setsStmt.all(id);
      let top = 0;
      let volume = 0;
      for (const s of sets) {
        top = Math.max(top, e1rm(s.weight, s.reps));
        volume += (s.reps || 0) * (s.weight || 0);
        bestWeight = Math.max(bestWeight, s.weight || 0);
      }
      bestE1rm = Math.max(bestE1rm, top);
      return { ...e, sets, e1rm: Math.round(top * 10) / 10, volume: Math.round(volume) };
    });
    res.json({
      exercise: { ...ex, secondary: ex.secondary ? ex.secondary.split(',') : [] },
      bestWeight,
      bestE1rm: Math.round(bestE1rm * 10) / 10,
      history,
    });
  });

  // --- Sesiones ---
  api.get('/s/:token/sessions', (req, res) => {
    const from = D.isIsoDate(req.query.from) ? req.query.from : '0000-01-01';
    const to = D.isIsoDate(req.query.to) ? req.query.to : '9999-12-31';
    const limit = optInt(req.query.limit, 1, 1000, 'limit') || 200;
    const sessions = db
      .prepare(
        `SELECT s.id, s.date, s.title, s.duration_min, s.rpe, s.notes,
                (SELECT COUNT(*) FROM session_exercises se WHERE se.session_id = s.id) AS exercise_count,
                (SELECT COUNT(*) FROM sets st JOIN session_exercises se ON se.id = st.session_exercise_id
                  WHERE se.session_id = s.id) AS set_count,
                (SELECT GROUP_CONCAT(DISTINCT e.muscle) FROM session_exercises se
                   JOIN exercises e ON e.id = se.exercise_id WHERE se.session_id = s.id) AS muscles
           FROM sessions s
          WHERE s.space_id = ? AND s.date BETWEEN ? AND ?
          ORDER BY s.date DESC, s.id DESC LIMIT ?`
      )
      .all(req.space.id, from, to, limit)
      .map((s) => ({ ...s, muscles: s.muscles ? s.muscles.split(',') : [] }));
    res.json(sessions);
  });

  api.get('/s/:token/sessions/:id', (req, res) => {
    const s = getSession(db, req.space.id, req.params.id);
    if (!s) throw new HttpError(404, 'Sesión no encontrada');
    res.json(s);
  });

  api.post('/s/:token/sessions', (req, res) => {
    const data = parseSession(req.body, exerciseIdChecker(db, req.space.id));
    const id = db.transaction(() => {
      const sid = db
        .prepare(
          `INSERT INTO sessions (space_id, date, title, duration_min, rpe, bodyweight, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.space.id, data.date, data.title, data.duration_min, data.rpe, data.bodyweight, data.notes)
        .lastInsertRowid;
      writeSessionChildren(db, sid, data.exercises);
      return sid;
    })();
    res.status(201).json(getSession(db, req.space.id, id));
  });

  api.put('/s/:token/sessions/:id', (req, res) => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ? AND space_id = ?').get(req.params.id, req.space.id);
    if (!existing) throw new HttpError(404, 'Sesión no encontrada');
    const data = parseSession(req.body, exerciseIdChecker(db, req.space.id));
    db.transaction(() => {
      db.prepare(
        `UPDATE sessions SET date = ?, title = ?, duration_min = ?, rpe = ?, bodyweight = ?, notes = ?,
                updated_at = datetime('now') WHERE id = ?`
      ).run(data.date, data.title, data.duration_min, data.rpe, data.bodyweight, data.notes, existing.id);
      writeSessionChildren(db, existing.id, data.exercises);
    })();
    res.json(getSession(db, req.space.id, existing.id));
  });

  api.delete('/s/:token/sessions/:id', (req, res) => {
    const info = db.prepare('DELETE FROM sessions WHERE id = ? AND space_id = ?').run(req.params.id, req.space.id);
    if (!info.changes) throw new HttpError(404, 'Sesión no encontrada');
    res.json({ deleted: true });
  });

  // --- Estadísticas ---
  api.get('/s/:token/stats', (req, res) => {
    const period = ['week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'week';
    res.json(computeStats(db, req.space, { period, date: req.query.date, today: req.query.today }));
  });

  api.get('/s/:token/bodyweight', (req, res) => {
    res.json(
      db
        .prepare('SELECT date, bodyweight FROM sessions WHERE space_id = ? AND bodyweight IS NOT NULL ORDER BY date')
        .all(req.space.id)
    );
  });

  // --- Respaldo ---
  api.get('/s/:token/export', (req, res) => {
    const ids = db.prepare('SELECT id FROM sessions WHERE space_id = ? ORDER BY date, id').all(req.space.id);
    const payload = {
      app: 'app-entrenamiento',
      version: 1,
      exported_at: new Date().toISOString(),
      space: { name: req.space.name, weekly_goal: req.space.weekly_goal },
      exercises: listExercises(db, req.space.id).map(({ id, uses, ...e }) => e),
      sessions: ids.map(({ id }) => {
        const { id: _id, space_id, exercises, ...s } = getSession(db, req.space.id, id);
        return {
          ...s,
          exercises: exercises.map(({ exercise_id, muscle, secondary, ...e }) => e),
        };
      }),
    };
    res.set('Content-Disposition', `attachment; filename="entrenamientos-${D.todayIso()}.json"`);
    res.json(payload);
  });

  api.post('/s/:token/import', (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.exercises) || !Array.isArray(body.sessions)) {
      throw new HttpError(400, 'Archivo de respaldo inválido');
    }
    const replace = req.query.mode === 'replace';
    const spaceId = req.space.id;
    const result = db.transaction(() => {
      if (replace) db.prepare('DELETE FROM sessions WHERE space_id = ?').run(spaceId);
      const byName = new Map(listExercises(db, spaceId).map((e) => [e.name.toLowerCase(), e.id]));
      const insEx = db.prepare('INSERT INTO exercises (space_id, name, muscle, secondary, archived) VALUES (?, ?, ?, ?, ?)');
      for (const e of body.exercises) {
        const name = str(e.name, 80, 'name');
        if (!name || byName.has(name.toLowerCase())) continue;
        const muscle = Object.hasOwn(MUSCLES, e.muscle) ? e.muscle : 'otro';
        const secondary = (Array.isArray(e.secondary) ? e.secondary : []).filter((m) => Object.hasOwn(MUSCLES, m)).join(',');
        byName.set(name.toLowerCase(), Number(insEx.run(spaceId, name, muscle, secondary, e.archived ? 1 : 0).lastInsertRowid));
      }
      const insSession = db.prepare(
        `INSERT INTO sessions (space_id, date, title, duration_min, rpe, bodyweight, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      let count = 0;
      for (const s of body.sessions) {
        const exercises = (Array.isArray(s.exercises) ? s.exercises : []).map((e) => {
          const key = String(e.name || '').trim().toLowerCase();
          if (!byName.has(key)) {
            byName.set(key, Number(insEx.run(spaceId, String(e.name).trim().slice(0, 80), 'otro', '', 0).lastInsertRowid));
          }
          return { ...e, exercise_id: byName.get(key) };
        });
        const validIds = new Set(byName.values());
        const data = parseSession({ ...s, exercises }, (id) => validIds.has(id));
        const sid = insSession.run(spaceId, data.date, data.title, data.duration_min, data.rpe, data.bodyweight, data.notes).lastInsertRowid;
        writeSessionChildren(db, sid, data.exercises);
        count += 1;
      }
      return count;
    })();
    res.json({ imported: result });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

  // --- Frontend ---
  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/vendor/chart.js', express.static(path.join(require.resolve('chart.js'), '..', '..', 'dist')));
  app.use(express.static(publicDir, { index: false }));
  // /t/<token> y cualquier otra ruta sirven la SPA; el frontend lee el token de la URL.
  app.get(['/', '/t/:token'], (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
  });

  return app;
}

module.exports = { createApp };
