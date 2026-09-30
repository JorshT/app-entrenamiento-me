'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, createSpace } = require('../src/db');
const { createApp } = require('../src/app');

function setup() {
  const db = openDb(':memory:');
  const space = createSpace(db);
  const server = createApp(db).listen(0);
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
  const { server, api } = setup();
  t.after(() => server.close());
  const r = await api('GET', '/me', null, 'x'.repeat(32));
  assert.equal(r.status, 404);
});

test('flujo completo: sesión, historial y estadísticas', async (t) => {
  const { server, api, base, space } = setup();
  t.after(() => server.close());

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

test('los espacios están aislados entre sí', async (t) => {
  const { server, api, db } = setup();
  t.after(() => server.close());
  const other = createSpace(db);
  const ex = (await api('GET', '/exercises')).body[0];
  const s = (await api('POST', '/sessions', { date: '2026-09-30', exercises: [{ exercise_id: ex.id, sets: [{ reps: 1 }] }] })).body;
  assert.equal((await api('GET', `/sessions/${s.id}`, null, other.token)).status, 404);
  const cross = await api('POST', '/sessions', { date: '2026-09-30', exercises: [{ exercise_id: ex.id, sets: [] }] }, other.token);
  assert.equal(cross.status, 400);
});
