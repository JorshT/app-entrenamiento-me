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

const isUniqueViolation = (e) => e && e.code === '23505';
const splitList = (s) => (s ? s.split(',') : []);

async function listExercises(q, spaceId) {
  const rows = await q.query(
    `SELECT e.id, e.name, e.muscle, e.secondary, e.archived,
            (SELECT COUNT(*)::int FROM session_exercises se WHERE se.exercise_id = e.id) AS uses
       FROM exercises e WHERE e.space_id = $1 ORDER BY lower(e.name)`,
    [spaceId]
  );
  return rows.map((e) => ({ ...e, secondary: splitList(e.secondary) }));
}

async function getSession(q, spaceId, id) {
  const s = await q.one('SELECT * FROM sessions WHERE id = $1 AND space_id = $2', [id, spaceId]);
  if (!s) return null;
  const exercises = await q.query(
    `SELECT se.id, se.exercise_id, se.rest_sec, se.notes, e.name, e.muscle, e.secondary
       FROM session_exercises se JOIN exercises e ON e.id = se.exercise_id
      WHERE se.session_id = $1 ORDER BY se.position`,
    [id]
  );
  const sets = await q.query(
    `SELECT st.session_exercise_id, st.reps, st.weight, st.rir
       FROM sets st JOIN session_exercises se ON se.id = st.session_exercise_id
      WHERE se.session_id = $1 ORDER BY st.position`,
    [id]
  );
  s.exercises = exercises.map((ex) => ({
    exercise_id: ex.exercise_id,
    name: ex.name,
    muscle: ex.muscle,
    secondary: splitList(ex.secondary),
    rest_sec: ex.rest_sec,
    notes: ex.notes,
    sets: sets.filter((st) => st.session_exercise_id === ex.id).map(({ session_exercise_id, ...st }) => st),
  }));
  return s;
}

// Reemplaza ejercicios y series de una sesión (dentro de una transacción).
async function writeSessionChildren(q, sessionId, exercises) {
  await q.query('DELETE FROM session_exercises WHERE session_id = $1', [sessionId]);
  if (!exercises.length) return;
  const seIds = await q.query(
    `INSERT INTO session_exercises (session_id, exercise_id, position, rest_sec, notes)
     SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[], $5::text[])
     RETURNING id, position`,
    [
      sessionId,
      exercises.map((e) => e.exercise_id),
      exercises.map((_, i) => i),
      exercises.map((e) => e.rest_sec),
      exercises.map((e) => e.notes),
    ]
  );
  const idByPos = new Map(seIds.map((r) => [r.position, r.id]));
  const rows = exercises.flatMap((e, i) => e.sets.map((s, j) => [idByPos.get(i), j, s.reps, s.weight, s.rir]));
  if (!rows.length) return;
  await q.query(
    `INSERT INTO sets (session_exercise_id, position, reps, weight, rir)
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::float8[], $5::int[])`,
    [0, 1, 2, 3, 4].map((k) => rows.map((r) => r[k]))
  );
}

async function exerciseIds(q, spaceId) {
  const rows = await q.query('SELECT id FROM exercises WHERE space_id = $1', [spaceId]);
  return new Set(rows.map((r) => r.id));
}

async function insertSession(q, spaceId, data) {
  const { id } = await q.one(
    `INSERT INTO sessions (space_id, date, title, duration_min, rpe, bodyweight, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [spaceId, data.date, data.title, data.duration_min, data.rpe, data.bodyweight, data.notes]
  );
  await writeSessionChildren(q, id, data.exercises);
  return id;
}

// ---------- App ----------

// `dbOrGetter` es la base, o una función async que la entrega (en Vercel se conecta en el primer request).
function createApp(dbOrGetter, { serveStatic = true } = {}) {
  const getDb = typeof dbOrGetter === 'function' ? dbOrGetter : async () => dbOrGetter;
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

  // Mantiene activa la base (Supabase gratis pausa proyectos inactivos). Lo llama el cron de Vercel.
  api.get('/health', async (req, res) => {
    const db = await getDb();
    await db.query('SELECT 1');
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });

  api.use('/s/:token', async (req, res, next) => {
    const db = await getDb();
    const space = await findSpaceByToken(db, req.params.token);
    if (!space) return res.status(404).json({ error: 'Enlace no válido' });
    req.db = db;
    req.space = space;
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/s/:token/me', (req, res) => {
    const { id, token, ...rest } = req.space;
    res.json({ ...rest, muscles: MUSCLES });
  });

  api.patch('/s/:token/me', async (req, res) => {
    const name = req.body.name !== undefined ? str(req.body.name, 80, 'name') || 'Mis entrenamientos' : req.space.name;
    const goal = req.body.weekly_goal !== undefined ? optInt(req.body.weekly_goal, 1, 14, 'weekly_goal') : req.space.weekly_goal;
    await req.db.query('UPDATE spaces SET name = $1, weekly_goal = $2 WHERE id = $3', [name, goal || 4, req.space.id]);
    res.json({ ok: true });
  });

  // Genera un token nuevo e invalida el anterior (por si el enlace se filtró).
  api.post('/s/:token/rotate', async (req, res) => {
    const token = newToken();
    await req.db.query('UPDATE spaces SET token = $1 WHERE id = $2', [token, req.space.id]);
    res.json({ token });
  });

  // --- Ejercicios ---
  api.get('/s/:token/exercises', async (req, res) => {
    res.json(await listExercises(req.db, req.space.id));
  });

  api.post('/s/:token/exercises', async (req, res) => {
    const name = str(req.body.name, 80, 'name');
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const muscle = validMuscle(req.body.muscle);
    const secondary = parseSecondary(req.body.secondary);
    try {
      const { id } = await req.db.one(
        'INSERT INTO exercises (space_id, name, muscle, secondary) VALUES ($1, $2, $3, $4) RETURNING id',
        [req.space.id, name, muscle, secondary]
      );
      res.status(201).json({ id, name, muscle, secondary: splitList(secondary), archived: false, uses: 0 });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'Ya existe un ejercicio con ese nombre');
      throw e;
    }
  });

  const findExercise = async (req) => {
    const id = optInt(req.params.id, 1, 2147483647, 'id');
    const ex = await req.db.one('SELECT * FROM exercises WHERE id = $1 AND space_id = $2', [id, req.space.id]);
    if (!ex) throw new HttpError(404, 'Ejercicio no encontrado');
    return ex;
  };

  api.patch('/s/:token/exercises/:id', async (req, res) => {
    const ex = await findExercise(req);
    const name = req.body.name !== undefined ? str(req.body.name, 80, 'name') : ex.name;
    if (!name) throw new HttpError(400, 'El nombre es obligatorio');
    const muscle = req.body.muscle !== undefined ? validMuscle(req.body.muscle) : ex.muscle;
    const secondary = req.body.secondary !== undefined ? parseSecondary(req.body.secondary) : ex.secondary;
    const archived = req.body.archived !== undefined ? !!req.body.archived : ex.archived;
    try {
      await req.db.query('UPDATE exercises SET name = $1, muscle = $2, secondary = $3, archived = $4 WHERE id = $5', [
        name,
        muscle,
        secondary,
        archived,
        ex.id,
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'Ya existe un ejercicio con ese nombre');
      throw e;
    }
    res.json({ ok: true });
  });

  api.delete('/s/:token/exercises/:id', async (req, res) => {
    const ex = await findExercise(req);
    const { n } = await req.db.one('SELECT COUNT(*)::int AS n FROM session_exercises WHERE exercise_id = $1', [ex.id]);
    if (n) {
      // Si tiene historial no se borra: se archiva para no perder datos.
      await req.db.query('UPDATE exercises SET archived = true WHERE id = $1', [ex.id]);
      return res.json({ archived: true });
    }
    await req.db.query('DELETE FROM exercises WHERE id = $1', [ex.id]);
    res.json({ deleted: true });
  });

  api.get('/s/:token/exercises/:id/history', async (req, res) => {
    const ex = await findExercise(req);
    const limit = optInt(req.query.limit, 1, 500, 'limit') || 20;
    const entries = await req.db.query(
      `SELECT se.id, s.id AS session_id, s.date, s.title, se.rest_sec, se.notes
         FROM session_exercises se JOIN sessions s ON s.id = se.session_id
        WHERE se.exercise_id = $1 AND s.space_id = $2
        ORDER BY s.date DESC, s.id DESC LIMIT $3`,
      [ex.id, req.space.id, limit]
    );
    const sets = await req.db.query(
      `SELECT session_exercise_id, reps, weight, rir FROM sets
        WHERE session_exercise_id = ANY($1::int[]) ORDER BY position`,
      [entries.map((e) => e.id)]
    );
    let bestWeight = 0;
    let bestE1rm = 0;
    const history = entries.map(({ id, ...e }) => {
      const mine = sets.filter((s) => s.session_exercise_id === id).map(({ session_exercise_id, ...s }) => s);
      let top = 0;
      let volume = 0;
      for (const s of mine) {
        top = Math.max(top, e1rm(s.weight, s.reps));
        volume += (s.reps || 0) * (s.weight || 0);
        bestWeight = Math.max(bestWeight, s.weight || 0);
      }
      bestE1rm = Math.max(bestE1rm, top);
      return { ...e, sets: mine, e1rm: Math.round(top * 10) / 10, volume: Math.round(volume) };
    });
    res.json({
      exercise: { ...ex, secondary: splitList(ex.secondary) },
      bestWeight,
      bestE1rm: Math.round(bestE1rm * 10) / 10,
      history,
    });
  });

  // --- Sesiones ---
  api.get('/s/:token/sessions', async (req, res) => {
    const from = D.isIsoDate(req.query.from) ? req.query.from : '0001-01-01';
    const to = D.isIsoDate(req.query.to) ? req.query.to : '9999-12-31';
    const limit = optInt(req.query.limit, 1, 1000, 'limit') || 200;
    const sessions = await req.db.query(
      `SELECT s.id, s.date, s.title, s.duration_min, s.rpe, s.notes,
              (SELECT COUNT(*)::int FROM session_exercises se WHERE se.session_id = s.id) AS exercise_count,
              (SELECT COUNT(*)::int FROM sets st JOIN session_exercises se ON se.id = st.session_exercise_id
                WHERE se.session_id = s.id) AS set_count,
              (SELECT string_agg(DISTINCT e.muscle, ',') FROM session_exercises se
                 JOIN exercises e ON e.id = se.exercise_id WHERE se.session_id = s.id) AS muscles
         FROM sessions s
        WHERE s.space_id = $1 AND s.date BETWEEN $2 AND $3
        ORDER BY s.date DESC, s.id DESC LIMIT $4`,
      [req.space.id, from, to, limit]
    );
    res.json(sessions.map((s) => ({ ...s, muscles: splitList(s.muscles) })));
  });

  const sessionId = (req) => optInt(req.params.id, 1, 2147483647, 'id');

  api.get('/s/:token/sessions/:id', async (req, res) => {
    const s = await getSession(req.db, req.space.id, sessionId(req));
    if (!s) throw new HttpError(404, 'Sesión no encontrada');
    res.json(s);
  });

  api.post('/s/:token/sessions', async (req, res) => {
    const ids = await exerciseIds(req.db, req.space.id);
    const data = parseSession(req.body, (id) => ids.has(id));
    const id = await req.db.tx((q) => insertSession(q, req.space.id, data));
    res.status(201).json(await getSession(req.db, req.space.id, id));
  });

  api.put('/s/:token/sessions/:id', async (req, res) => {
    const id = sessionId(req);
    const existing = await req.db.one('SELECT id FROM sessions WHERE id = $1 AND space_id = $2', [id, req.space.id]);
    if (!existing) throw new HttpError(404, 'Sesión no encontrada');
    const ids = await exerciseIds(req.db, req.space.id);
    const data = parseSession(req.body, (x) => ids.has(x));
    await req.db.tx(async (q) => {
      await q.query(
        `UPDATE sessions SET date = $1, title = $2, duration_min = $3, rpe = $4, bodyweight = $5, notes = $6,
                updated_at = now() WHERE id = $7`,
        [data.date, data.title, data.duration_min, data.rpe, data.bodyweight, data.notes, id]
      );
      await writeSessionChildren(q, id, data.exercises);
    });
    res.json(await getSession(req.db, req.space.id, id));
  });

  api.delete('/s/:token/sessions/:id', async (req, res) => {
    const rows = await req.db.query('DELETE FROM sessions WHERE id = $1 AND space_id = $2 RETURNING id', [
      sessionId(req),
      req.space.id,
    ]);
    if (!rows.length) throw new HttpError(404, 'Sesión no encontrada');
    res.json({ deleted: true });
  });

  // --- Estadísticas ---
  api.get('/s/:token/stats', async (req, res) => {
    const period = ['week', 'month', 'year'].includes(req.query.period) ? req.query.period : 'week';
    res.json(await computeStats(req.db, req.space, { period, date: req.query.date, today: req.query.today }));
  });

  api.get('/s/:token/bodyweight', async (req, res) => {
    res.json(
      await req.db.query(
        'SELECT date, bodyweight FROM sessions WHERE space_id = $1 AND bodyweight IS NOT NULL ORDER BY date',
        [req.space.id]
      )
    );
  });

  // --- Respaldo ---
  api.get('/s/:token/export', async (req, res) => {
    const ids = await req.db.query('SELECT id FROM sessions WHERE space_id = $1 ORDER BY date, id', [req.space.id]);
    const sessions = [];
    for (const { id } of ids) {
      const { id: _id, space_id, exercises, ...s } = await getSession(req.db, req.space.id, id);
      sessions.push({ ...s, exercises: exercises.map(({ exercise_id, muscle, secondary, ...e }) => e) });
    }
    res.set('Content-Disposition', `attachment; filename="entrenamientos-${D.todayIso()}.json"`);
    res.json({
      app: 'app-entrenamiento',
      version: 1,
      exported_at: new Date().toISOString(),
      space: { name: req.space.name, weekly_goal: req.space.weekly_goal },
      exercises: (await listExercises(req.db, req.space.id)).map(({ id, uses, ...e }) => e),
      sessions,
    });
  });

  api.post('/s/:token/import', async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.exercises) || !Array.isArray(body.sessions)) {
      throw new HttpError(400, 'Archivo de respaldo inválido');
    }
    const replace = req.query.mode === 'replace';
    const spaceId = req.space.id;
    const imported = await req.db.tx(async (q) => {
      if (replace) await q.query('DELETE FROM sessions WHERE space_id = $1', [spaceId]);
      const byName = new Map((await listExercises(q, spaceId)).map((e) => [e.name.toLowerCase(), e.id]));
      const addExercise = async (name, muscle, secondary, archived) => {
        const { id } = await q.one(
          'INSERT INTO exercises (space_id, name, muscle, secondary, archived) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [spaceId, name, muscle, secondary, archived]
        );
        byName.set(name.toLowerCase(), id);
      };
      for (const e of body.exercises) {
        const name = str(e.name, 80, 'name');
        if (!name || byName.has(name.toLowerCase())) continue;
        const muscle = Object.hasOwn(MUSCLES, e.muscle) ? e.muscle : 'otro';
        const secondary = (Array.isArray(e.secondary) ? e.secondary : []).filter((m) => Object.hasOwn(MUSCLES, m)).join(',');
        await addExercise(name, muscle, secondary, !!e.archived);
      }
      let count = 0;
      for (const s of body.sessions) {
        const exercises = [];
        for (const e of Array.isArray(s.exercises) ? s.exercises : []) {
          const name = str(String(e.name || ''), 80, 'name');
          if (!name) throw new HttpError(400, 'Ejercicio sin nombre en el respaldo');
          if (!byName.has(name.toLowerCase())) await addExercise(name, 'otro', '', false);
          exercises.push({ ...e, exercise_id: byName.get(name.toLowerCase()) });
        }
        const valid = new Set(byName.values());
        await insertSession(q, spaceId, parseSession({ ...s, exercises }, (id) => valid.has(id)));
        count += 1;
      }
      return count;
    });
    res.json({ imported });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

  // --- Frontend (en Vercel lo sirve su CDN; aquí es para uso local) ---
  if (serveStatic) {
    const publicDir = path.join(__dirname, '..', 'public');
    app.use(express.static(publicDir, { index: false }));
    // /t/<token> sirve la SPA; el frontend lee el token de la URL.
    app.get(['/', '/t/:token'], (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
  });

  return app;
}

module.exports = { createApp };
