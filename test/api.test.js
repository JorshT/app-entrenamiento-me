'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, createSpace, ensureSpace } = require('../src/db');
const { createApp } = require('../src/app');

// Con TEST_DATABASE_URL las pruebas corren contra un Postgres real; si no, contra PGlite en memoria.
async function setup(t) {
  const db = await openDb({ url: process.env.TEST_DATABASE_URL || '' });
  const space = await createSpace(db);
  const server = createApp(db).listen(0);
  t.after(async () => {
    server.close();
    await db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body, token = space.token) => {
    const res = await fetch(`${base}/api/s/${token}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { db, space, server, base, api };
}

test('rechaza tokens inválidos', async (t) => {
  const { api } = await setup(t);
  const r = await api('GET', '/me', null, 'x'.repeat(32));
  assert.equal(r.status, 404);
});

test('flujo completo: sesión, historial y estadísticas', async (t) => {
  const { api, base, space } = await setup(t);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const page = await fetch(`${base}/t/${space.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const exercises = (await api('GET', '/exercises')).body;
  const bench = exercises.find((e) => e.name === 'Press banca');
  const squat = exercises.find((e) => e.name === 'Sentadilla');
  assert.ok(bench && squat);

  const old = await api('POST', '/sessions', {
    date: '2026-09-21',
    exercises: [{ exercise_id: bench.id, sets: [{ reps: 8, weight: 60 }] }],
  });
  assert.equal(old.status, 201);

  const created = await api('POST', '/sessions', {
    date: '2026-09-29',
    title: 'Empuje + pierna',
    duration_min: 70,
    rpe: 8,
    notes: 'Buen día',
    exercises: [
      { exercise_id: bench.id, rest_sec: 120, notes: 'codos cerrados', sets: [{ reps: 8, weight: 65 }, { reps: 8, weight: 65 }, { reps: 6, weight: 67.5 }] },
      { exercise_id: squat.id, rest_sec: 180, sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.exercises[0].sets.length, 3);
  assert.equal(created.body.exercises[0].rest_sec, 120);

  const bad = await api('POST', '/sessions', { date: '2026-02-30', exercises: [] });
  assert.equal(bad.status, 400);

  const stats = (await api('GET', '/stats?period=week&date=2026-09-30&today=2026-09-30')).body;
  assert.equal(stats.from, '2026-09-28');
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.sets, 5);
  assert.equal(stats.totals.minutes, 70);
  const chest = stats.muscles.find((m) => m.muscle === 'pecho');
  assert.equal(chest.sets, 3);
  const triceps = stats.muscles.find((m) => m.muscle === 'triceps');
  assert.equal(triceps.secondarySets, 3);
  assert.equal(triceps.effective, 1.5);
  assert.equal(stats.previous.sessions, 1);
  assert.equal(stats.records.length, 1);
  assert.equal(stats.records[0].name, 'Press banca');
  assert.equal(stats.allTime.sessions, 2);
  assert.equal(stats.allTime.weekStreak, 2);

  const year = (await api('GET', '/stats?period=year&date=2026-09-30&today=2026-09-30')).body;
  assert.equal(year.buckets.length, 12);
  assert.equal(year.buckets[8].sessions, 2);

  const month = (await api('GET', '/stats?period=month&date=2026-09-30&today=2026-09-30')).body;
  assert.equal(month.totals.sessions, 2);

  const hist = (await api('GET', `/exercises/${bench.id}/history`)).body;
  assert.equal(hist.history.length, 2);
  assert.equal(hist.bestWeight, 67.5);

  const id = created.body.id;
  const upd = await api('PUT', `/sessions/${id}`, { ...created.body, exercises: [{ exercise_id: squat.id, sets: [{ reps: 3, weight: 110 }] }] });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.exercises.length, 1);

  // Un ejercicio con historial se archiva en vez de borrarse.
  const del = await api('DELETE', `/exercises/${squat.id}`);
  assert.deepEqual(del.body, { archived: true });

  const exp = (await api('GET', '/export')).body;
  assert.equal(exp.sessions.length, 2);
  const imp = await api('POST', '/import?mode=replace', exp);
  assert.deepEqual(imp.body, { imported: 2 });
  assert.equal((await api('GET', '/sessions')).body.length, 2);

  const rotated = (await api('POST', '/rotate')).body.token;
  assert.equal((await api('GET', '/me')).status, 404);
  assert.equal((await api('GET', '/me', null, rotated)).status, 200);
});

test('sesión en vivo: se crea vacía, se autoguarda y se termina', async (t) => {
  const { api } = await setup(t);
  const bench = (await api('GET', '/exercises')).body.find((e) => e.name === 'Press banca');

  assert.equal((await api('GET', '/sessions/active')).body, null);
  const created = await api('POST', '/sessions', { date: '2026-09-30', title: 'Torso', in_progress: true, exercises: [] });
  assert.equal(created.status, 201);
  assert.equal(created.body.in_progress, true);
  const id = created.body.id;

  const active = (await api('GET', '/sessions/active')).body;
  assert.equal(active.id, id);

  // El autoguardado reenvía la sesión completa varias veces: no debe duplicar series.
  const body = { ...created.body, exercises: [{ exercise_id: bench.id, rest_sec: 90, sets: [{ reps: 8, weight: 60 }] }] };
  await api('PUT', `/sessions/${id}`, body);
  body.exercises[0].sets.push({ reps: 8, weight: 62.5, rir: 1 });
  const saved = await api('PUT', `/sessions/${id}`, body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.exercises.length, 1);
  assert.equal(saved.body.exercises[0].sets.length, 2);
  assert.equal(saved.body.in_progress, true);

  const list = (await api('GET', '/sessions')).body;
  assert.equal(list[0].in_progress, true);
  assert.equal(list[0].set_count, 2);

  const done = await api('PUT', `/sessions/${id}`, { ...body, in_progress: false, duration_min: 55 });
  assert.equal(done.body.in_progress, false);
  assert.equal((await api('GET', '/sessions/active')).body, null);
});

test('administración de usuarios: crear, enlace nuevo, suspender y eliminar', async (t) => {
  const { api, db } = await setup(t);
  const me = (await api('GET', '/me')).body;
  assert.equal(me.is_admin, true);

  const created = await api('POST', '/admin/users', { name: 'Ana' });
  assert.equal(created.status, 201);
  const ana = created.body;
  assert.equal(ana.is_admin, false);
  const asAna = (method, path, body, token = ana.token) => api(method, path, body, token);

  const anaMe = (await asAna('GET', '/me')).body;
  assert.equal(anaMe.name, 'Ana');
  assert.equal(anaMe.is_admin, false);
  assert.ok((await asAna('GET', '/exercises')).body.length > 0, 'se precarga el catálogo');

  // Ana no administra ni cambia su propio enlace.
  assert.equal((await asAna('GET', '/admin/users')).status, 403);
  assert.equal((await asAna('POST', '/rotate')).status, 403);

  const ex = (await asAna('GET', '/exercises')).body[0];
  await asAna('POST', '/sessions', { date: '2026-09-29', exercises: [{ exercise_id: ex.id, sets: [{ reps: 5, weight: 20 }] }] });
  const users = (await api('GET', '/admin/users?today=2026-09-30')).body;
  assert.equal(users.length, 2);
  assert.equal(users[0].is_admin, true);
  const row = users.find((u) => u.id === ana.id);
  assert.equal(row.sessions, 1);
  assert.equal(row.week, 1);
  assert.equal(row.last_date, '2026-09-29');

  const rotated = (await api('POST', `/admin/users/${ana.id}/rotate`)).body.token;
  assert.equal((await asAna('GET', '/me')).status, 404);
  assert.equal((await asAna('GET', '/me', null, rotated)).status, 200);

  await api('PATCH', `/admin/users/${ana.id}`, { disabled: true, name: 'Ana María' });
  const suspended = await asAna('GET', '/me', null, rotated);
  assert.equal(suspended.status, 403);
  await api('PATCH', `/admin/users/${ana.id}`, { disabled: false });
  assert.equal((await asAna('GET', '/me', null, rotated)).body.name, 'Ana María');

  assert.equal((await api('PATCH', `/admin/users/${users[0].id}`, { disabled: true })).status, 400);
  assert.equal((await api('DELETE', `/admin/users/${users[0].id}`)).status, 400);
  assert.equal((await api('DELETE', '/admin/users/999999')).status, 404);

  assert.deepEqual((await api('DELETE', `/admin/users/${ana.id}`)).body, { deleted: true });
  assert.equal((await asAna('GET', '/me', null, rotated)).status, 404);
  const left = await db.one('SELECT (SELECT COUNT(*)::int FROM sessions WHERE space_id = $1) AS s, (SELECT COUNT(*)::int FROM exercises WHERE space_id = $1) AS e', [ana.id]);
  assert.deepEqual(left, { s: 0, e: 0 });
});

test('los espacios están aislados entre sí', async (t) => {
  const { api, db } = await setup(t);
  const other = await createSpace(db);
  const ex = (await api('GET', '/exercises')).body[0];
  const s = (await api('POST', '/sessions', { date: '2026-09-30', exercises: [{ exercise_id: ex.id, sets: [{ reps: 1 }] }] })).body;
  assert.equal((await api('GET', `/sessions/${s.id}`, null, other.token)).status, 404);
  const cross = await api('POST', '/sessions', { date: '2026-09-30', exercises: [{ exercise_id: ex.id, sets: [] }] }, other.token);
  assert.equal(cross.status, 400);
});

test('ACCESS_TOKEN solo crea el espacio si la base está vacía', async () => {
  const db = await openDb({ url: '' });
  const token = 'token-de-prueba-123456789';
  const first = await ensureSpace(db, token);
  assert.equal(first.token, token);
  assert.equal((await ensureSpace(db, token)).id, first.id);
  await db.query('UPDATE spaces SET token = $1 WHERE id = $2', ['otro-token-rotado-123456789', first.id]);
  assert.equal(await ensureSpace(db, token), null);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM spaces')).n, 1);
  await db.close();
});
