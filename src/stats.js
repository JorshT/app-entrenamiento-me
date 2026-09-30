'use strict';

const D = require('./dates');
const { MUSCLES } = require('./catalog');

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// 1RM estimado (Epley). Solo es razonable para series de hasta ~12 reps.
function e1rm(weight, reps) {
  if (!weight || !reps || reps < 1 || reps > 12) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

function splitSecondary(s) {
  return s ? s.split(',').filter(Boolean) : [];
}

// Carga todas las series (una fila por serie; ejercicios sin series dan una fila con set_id null).
function loadRows(db, spaceId, from, to) {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.date, s.duration_min, s.rpe,
              se.id AS se_id, e.id AS exercise_id, e.name AS exercise, e.muscle, e.secondary,
              st.id AS set_id, st.reps, st.weight
         FROM sessions s
         LEFT JOIN session_exercises se ON se.session_id = s.id
         LEFT JOIN exercises e ON e.id = se.exercise_id
         LEFT JOIN sets st ON st.session_exercise_id = se.id
        WHERE s.space_id = ? AND s.date BETWEEN ? AND ?
        ORDER BY s.date, s.id, se.position, st.position`
    )
    .all(spaceId, from, to);
}

function emptyTotals() {
  return { sessions: 0, days: 0, minutes: 0, sets: 0, reps: 0, volume: 0, avgRpe: null, exercises: 0 };
}

function computeTotals(rows) {
  const t = emptyTotals();
  const sessions = new Map();
  const days = new Set();
  const exercises = new Set();
  for (const r of rows) {
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, r);
    days.add(r.date);
    if (r.exercise_id) exercises.add(r.exercise_id);
    if (r.set_id) {
      t.sets += 1;
      t.reps += r.reps || 0;
      t.volume += (r.reps || 0) * (r.weight || 0);
    }
  }
  t.sessions = sessions.size;
  t.days = days.size;
  t.exercises = exercises.size;
  let rpeSum = 0;
  let rpeN = 0;
  for (const s of sessions.values()) {
    t.minutes += s.duration_min || 0;
    if (s.rpe) {
      rpeSum += s.rpe;
      rpeN += 1;
    }
  }
  t.avgRpe = rpeN ? Math.round((rpeSum / rpeN) * 10) / 10 : null;
  t.volume = Math.round(t.volume);
  return t;
}

// Buckets para el gráfico de evolución: días (semana), semanas (mes) o meses (año).
function buildBuckets(period, from, to) {
  const buckets = [];
  if (period === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = D.addDays(from, i);
      buckets.push({ key: d, label: `${DAYS[i]} ${Number(d.slice(8))}`, from: d, to: d });
    }
  } else if (period === 'month') {
    let w = D.startOfWeek(from);
    while (w <= to) {
      const wFrom = w < from ? from : w;
      const wEnd = D.addDays(w, 6);
      const wTo = wEnd > to ? to : wEnd;
      buckets.push({ key: w, label: `${Number(wFrom.slice(8))}-${Number(wTo.slice(8))}`, from: wFrom, to: wTo });
      w = D.addDays(w, 7);
    }
  } else {
    for (let m = 0; m < 12; m++) {
      const mFrom = `${from.slice(0, 4)}-${String(m + 1).padStart(2, '0')}-01`;
      buckets.push({ key: mFrom, label: MONTHS[m], from: mFrom, to: D.endOfMonth(mFrom) });
    }
  }
  return buckets.map((b) => ({ ...b, sessions: 0, sets: 0, volume: 0, minutes: 0, muscles: {} }));
}

function periodLabel(period, from) {
  if (period === 'week') {
    const to = D.addDays(from, 6);
    return `Semana del ${Number(from.slice(8))} ${MONTHS[Number(from.slice(5, 7)) - 1]} al ${Number(
      to.slice(8)
    )} ${MONTHS[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`;
  }
  if (period === 'month') {
    const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return `${names[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  }
  return from.slice(0, 4);
}

// Semanas "transcurridas" del período, para promedios semanales (no cuenta el futuro).
function elapsedWeeks(from, to, today) {
  const end = today < to ? today : to;
  if (end < from) return 1;
  return Math.max(1, (D.diffDays(from, end) + 1) / 7);
}

function weekStreak(db, spaceId, today) {
  const weeks = new Set(
    db
      .prepare('SELECT DISTINCT date FROM sessions WHERE space_id = ?')
      .all(spaceId)
      .map((r) => D.startOfWeek(r.date))
  );
  let w = D.startOfWeek(today);
  // Si esta semana aún no entrenas, la racha se cuenta desde la semana pasada.
  if (!weeks.has(w)) w = D.addDays(w, -7);
  let streak = 0;
  while (weeks.has(w)) {
    streak += 1;
    w = D.addDays(w, -7);
  }
  return streak;
}

function allTime(db, spaceId, today) {
  const row = db
    .prepare(
      `SELECT MIN(date) AS first, MAX(date) AS last, COUNT(*) AS sessions,
              COALESCE(SUM(duration_min), 0) AS minutes
         FROM sessions WHERE space_id = ?`
    )
    .get(spaceId);
  const sets = db
    .prepare(
      `SELECT COUNT(st.id) AS sets, COALESCE(SUM(st.reps * st.weight), 0) AS volume
         FROM sets st
         JOIN session_exercises se ON se.id = st.session_exercise_id
         JOIN sessions s ON s.id = se.session_id
        WHERE s.space_id = ?`
    )
    .get(spaceId);
  return {
    first: row.first,
    last: row.last,
    sessions: row.sessions,
    minutes: row.minutes,
    sets: sets.sets,
    volume: Math.round(sets.volume),
    daysSinceFirst: row.first ? D.diffDays(row.first, today) + 1 : 0,
    daysSinceLast: row.last ? D.diffDays(row.last, today) : null,
    weekStreak: weekStreak(db, spaceId, today),
  };
}

// Mejores marcas previas al período, por ejercicio.
function bestBefore(db, spaceId, before) {
  const rows = db
    .prepare(
      `SELECT se.exercise_id, st.reps, st.weight
         FROM sets st
         JOIN session_exercises se ON se.id = st.session_exercise_id
         JOIN sessions s ON s.id = se.session_id
        WHERE s.space_id = ? AND s.date < ? AND st.weight > 0 AND st.reps > 0`
    )
    .all(spaceId, before);
  const best = new Map();
  for (const r of rows) {
    const b = best.get(r.exercise_id) || { weight: 0, e1rm: 0 };
    b.weight = Math.max(b.weight, r.weight);
    b.e1rm = Math.max(b.e1rm, e1rm(r.weight, r.reps));
    best.set(r.exercise_id, b);
  }
  return best;
}

function computeStats(db, space, { period = 'week', date, today }) {
  today = D.isIsoDate(today) ? today : D.todayIso();
  date = D.isIsoDate(date) ? date : today;
  const { from, to } = D.periodRange(period, date);
  const prev = D.periodRange(period, D.shiftPeriod(period, date, -1));

  const rows = loadRows(db, space.id, from, to);
  const totals = computeTotals(rows);
  const previous = computeTotals(loadRows(db, space.id, prev.from, prev.to));
  const weeks = elapsedWeeks(from, to, today);

  const buckets = buildBuckets(period, from, to);
  const bucketFor = (date) => buckets.find((b) => date >= b.from && date <= b.to);

  const muscles = {};
  const exercises = new Map();
  const seenSessionInBucket = new Set();
  const trainedDays = {};

  for (const r of rows) {
    const b = bucketFor(r.date);
    trainedDays[r.date] = (trainedDays[r.date] || 0) + (r.set_id ? 1 : 0);
    if (b && !seenSessionInBucket.has(r.session_id)) {
      seenSessionInBucket.add(r.session_id);
      b.sessions += 1;
      b.minutes += r.duration_min || 0;
    }
    if (!r.set_id) continue;

    const vol = (r.reps || 0) * (r.weight || 0);
    const m = (muscles[r.muscle] ||= { muscle: r.muscle, sets: 0, secondarySets: 0, reps: 0, volume: 0 });
    m.sets += 1;
    m.reps += r.reps || 0;
    m.volume += vol;
    for (const sec of splitSecondary(r.secondary)) {
      (muscles[sec] ||= { muscle: sec, sets: 0, secondarySets: 0, reps: 0, volume: 0 }).secondarySets += 1;
    }

    if (b) {
      b.sets += 1;
      b.volume += vol;
      b.muscles[r.muscle] = (b.muscles[r.muscle] || 0) + 1;
    }

    const ex = exercises.get(r.exercise_id) || {
      id: r.exercise_id,
      name: r.exercise,
      muscle: r.muscle,
      sets: 0,
      reps: 0,
      volume: 0,
      sessions: new Set(),
      bestWeight: 0,
      bestE1rm: 0,
    };
    ex.sets += 1;
    ex.reps += r.reps || 0;
    ex.volume += vol;
    ex.sessions.add(r.session_id);
    ex.bestWeight = Math.max(ex.bestWeight, r.weight || 0);
    ex.bestE1rm = Math.max(ex.bestE1rm, e1rm(r.weight, r.reps));
    exercises.set(r.exercise_id, ex);
  }

  const muscleList = Object.values(muscles)
    .map((m) => ({
      ...m,
      label: MUSCLES[m.muscle] || m.muscle,
      volume: Math.round(m.volume),
      // Series "efectivas": directas + la mitad de las indirectas.
      effective: m.sets + m.secondarySets * 0.5,
      perWeek: Math.round((m.sets / weeks) * 10) / 10,
      effectivePerWeek: Math.round(((m.sets + m.secondarySets * 0.5) / weeks) * 10) / 10,
    }))
    .sort((a, b) => b.effective - a.effective);

  const before = bestBefore(db, space.id, from);
  const exerciseList = [...exercises.values()].map((e) => ({
    ...e,
    sessions: e.sessions.size,
    volume: Math.round(e.volume),
    bestE1rm: Math.round(e.bestE1rm * 10) / 10,
  }));
  const records = exerciseList
    .filter((e) => {
      const b = before.get(e.id);
      return b && (e.bestWeight > b.weight || e.bestE1rm > Math.round(b.e1rm * 10) / 10);
    })
    .map((e) => {
      const b = before.get(e.id);
      return {
        id: e.id,
        name: e.name,
        weight: e.bestWeight,
        prevWeight: b.weight,
        e1rm: e.bestE1rm,
        prevE1rm: Math.round(b.e1rm * 10) / 10,
      };
    });

  return {
    period,
    from,
    to,
    label: periodLabel(period, from),
    prevDate: D.shiftPeriod(period, date, -1),
    nextDate: D.shiftPeriod(period, date, 1),
    isCurrent: today >= from && today <= to,
    weeks: Math.round(weeks * 10) / 10,
    weeklyGoal: space.weekly_goal,
    totals,
    previous,
    muscles: muscleList,
    buckets: buckets.map(({ key, label, sessions, sets, volume, minutes, muscles }) => ({
      key,
      label,
      sessions,
      sets,
      volume: Math.round(volume),
      minutes,
      muscles,
    })),
    trainedDays,
    topExercises: exerciseList.sort((a, b) => b.sets - a.sets).slice(0, 10),
    records,
    allTime: allTime(db, space.id, today),
  };
}

module.exports = { computeStats, e1rm };
