'use strict';

// Utilidades de fechas en formato 'YYYY-MM-DD' (sin zona horaria).
// Las semanas empiezan el lunes.

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = parse(s);
  return toIso(d) === s;
}

function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIso(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

function diffDays(a, b) {
  return Math.round((parse(b) - parse(a)) / 86400000);
}

function startOfWeek(s) {
  const dow = (parse(s).getUTCDay() + 6) % 7; // lunes = 0
  return addDays(s, -dow);
}

function startOfMonth(s) {
  return s.slice(0, 8) + '01';
}

function endOfMonth(s) {
  const d = parse(startOfMonth(s));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return toIso(d);
}

function addMonths(s, n) {
  const d = parse(startOfMonth(s));
  d.setUTCMonth(d.getUTCMonth() + n);
  return toIso(d);
}

function todayIso() {
  const now = new Date();
  return toIso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

// Devuelve el rango de un período ('week' | 'month' | 'year') que contiene `date`.
function periodRange(period, date) {
  switch (period) {
    case 'week': {
      const from = startOfWeek(date);
      return { from, to: addDays(from, 6) };
    }
    case 'month':
      return { from: startOfMonth(date), to: endOfMonth(date) };
    case 'year': {
      const y = date.slice(0, 4);
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    default:
      throw new Error('Período inválido');
  }
}

function shiftPeriod(period, date, n) {
  if (period === 'week') return addDays(startOfWeek(date), 7 * n);
  if (period === 'month') return addMonths(date, n);
  if (period === 'year') return `${Number(date.slice(0, 4)) + n}-01-01`;
  throw new Error('Período inválido');
}

module.exports = {
  isIsoDate,
  addDays,
  diffDays,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  addMonths,
  todayIso,
  periodRange,
  shiftPeriod,
};
