(() => {
  'use strict';

  // ================= Utilidades =================
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const view = $('#view');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => toIso(new Date());
  const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return toIso(d); };
  const startOfWeek = (s) => addDays(s, -((parseIso(s).getDay() + 6) % 7));
  const diffDays = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);
  const fmtDate = (s, opts = { day: 'numeric', month: 'short' }) => parseIso(s).toLocaleDateString('es', opts);
  const fmtNum = (n, d = 0) => Number(n || 0).toLocaleString('es', { maximumFractionDigits: d });
  const fmtMin = (m) => {
    m = Math.round(m || 0);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h >= 100) return `${fmtNum(h)} h`;
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  };
  const fmtKg = (kg) => (kg >= 10000 ? `${fmtNum(kg / 1000, 1)} t` : `${fmtNum(kg)} kg`);
  const numOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // "2×8 @ 65 kg, 1×6 @ 67,5 kg"
  function fmtSets(sets) {
    const groups = [];
    for (const s of sets) {
      const last = groups[groups.length - 1];
      if (last && last.reps === s.reps && last.weight === s.weight) last.n += 1;
      else groups.push({ reps: s.reps, weight: s.weight, n: 1 });
    }
    return groups
      .map((g) => `${g.n}×${g.reps ?? '–'}${g.weight ? ` @ ${fmtNum(g.weight, 2)} kg` : ''}`)
      .join(', ');
  }

  // "8 × 62,5 kg"
  const fmtSet = (s) => `${s.reps ?? '–'}${s.weight ? ` × ${fmtNum(s.weight, 2)} kg` : ' reps'}`;

  // ---------- Comparación con la vez anterior ----------
  // Misma fórmula que src/stats.js.
  const e1rm = (w, r) => (!w || !r || r < 1 || r > 12 ? 0 : r === 1 ? w : w * (1 + r / 30));

  // Compara una serie con la de la misma posición la vez anterior: 'up' | 'same' | 'down' | 'new'.
  function compareSet(s, prev) {
    if (!prev) return 'new';
    const w = numOrNull(s.weight) || 0, r = numOrNull(s.reps) || 0;
    const pw = numOrNull(prev.weight) || 0, pr = numOrNull(prev.reps) || 0;
    if (w === pw && r === pr) return 'same';
    if (w > pw || (w === pw && r > pr) || e1rm(w, r) > e1rm(pw, pr)) return 'up';
    return 'down';
  }

  // "+2,5 kg" / "+2 reps" / "−1 rep"
  function setDelta(s, prev) {
    const dw = (numOrNull(s.weight) || 0) - (numOrNull(prev.weight) || 0);
    const dr = (numOrNull(s.reps) || 0) - (numOrNull(prev.reps) || 0);
    const sign = (n) => (n > 0 ? '+' : '−');
    if (dw) return `${sign(dw)}${fmtNum(Math.abs(dw), 2)} kg`;
    if (dr) return `${sign(dr)}${Math.abs(dr)} rep${Math.abs(dr) === 1 ? '' : 's'}`;
    return 'igual';
  }

  function setsSummary(sets) {
    let best = 0, volume = 0, reps = 0;
    for (const s of sets) {
      const w = numOrNull(s.weight) || 0, r = numOrNull(s.reps) || 0;
      best = Math.max(best, e1rm(w, r));
      volume += w * r;
      reps += r;
    }
    return { best, volume, reps };
  }

  // ¿Superaste la vez anterior? Por 1RM estimado, por volumen (kg × reps) o, sin kilos, por reps totales.
  function beatLast(sets, last) {
    if (!last || !last.sets.length || !sets.length) return false;
    const a = setsSummary(sets), b = setsSummary(last.sets);
    return a.best > b.best || a.volume > b.volume || (!a.volume && !b.volume && a.reps > b.reps);
  }

  // Cuerpo que aceptan POST/PUT /sessions.
  function sessionPayload(draft) {
    return {
      date: draft.date,
      title: draft.title,
      duration_min: numOrNull(draft.duration_min),
      rpe: numOrNull(draft.rpe),
      bodyweight: numOrNull(draft.bodyweight),
      notes: draft.notes,
      in_progress: !!draft.in_progress,
      exercises: draft.exercises.map((ex) => ({
        exercise_id: ex.exercise_id,
        rest_sec: numOrNull(ex.rest_sec),
        notes: ex.notes,
        sets: ex.sets
          .map((s) => ({ reps: numOrNull(s.reps), weight: numOrNull(s.weight), rir: numOrNull(s.rir) }))
          .filter((s) => s.reps !== null || s.weight !== null),
      })),
    };
  }

  const liveBanner = (s) => (s ? `
    <a class="live-banner" href="#/en-vivo/${s.id}">
      <span><i class="dot"></i>Entrenamiento en curso${s.title ? ` · ${esc(s.title)}` : ''}</span>
      <strong>Continuar →</strong>
    </a>` : '');

  // ================= Token / acceso =================
  const TOKEN_KEY = 'entrenos:token';
  const match = location.pathname.match(/^\/t\/([A-Za-z0-9_-]{16,128})\/?$/);
  const token = match ? match[1] : null;

  if (!token) {
    const saved = store.get(TOKEN_KEY);
    if (saved) {
      location.replace(`/t/${saved}${location.hash}`);
      return;
    }
    renderLanding();
    return;
  }
  store.set(TOKEN_KEY, token);

  // reason: undefined (sin enlace) | 'invalid' | 'suspended'
  function renderLanding(reason) {
    $('#nav').hidden = true;
    view.innerHTML = `
      <div class="landing card">
        <img src="/icon.svg" alt="">
        <h1>Mis Entrenamientos</h1>
        ${{
          invalid: '<p>Este enlace no es válido o fue reemplazado por uno nuevo. Pídele tu enlace actual a quien te lo dio.</p>',
          suspended: '<p>Tu acceso está suspendido. Habla con quien te dio el enlace.</p>',
        }[reason] || '<p>Esta app no usa usuario ni contraseña: se entra con tu <strong>enlace único</strong> (termina en <code>/t/…</code>).</p>'}
        <p class="small">Abre tu enlace desde el celular o el computador y quedará recordado en ese dispositivo.
        Si administras el servidor, puedes crear uno con <code>npm run new-link</code>.</p>
      </div>`;
  }

  // ================= API =================
  async function api(method, path, body) {
    const res = await fetch(`/api/s/${token}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ================= Estado global =================
  const state = {
    me: null,
    muscles: {},
    exercises: [],
    exById: new Map(),
    period: store.get('entrenos:period') || 'week',
    date: todayIso(),
    metric: 'sets',
    charts: [],
    dirty: false,
    lastHash: location.hash,
  };

  const MUSCLE_COLORS = {
    pecho: '#f97316', espalda: '#3b82f6', hombros: '#a855f7', trapecio: '#8b5cf6', biceps: '#ec4899',
    triceps: '#f43f5e', antebrazos: '#fb7185', abdomen: '#eab308', lumbar: '#ca8a04', gluteos: '#14b8a6',
    cuadriceps: '#22c55e', isquios: '#10b981', aductores: '#06b6d4', pantorrillas: '#0ea5e9', cardio: '#94a3b8', otro: '#64748b',
  };
  const muscleLabel = (m) => state.muscles[m] || m;

  async function loadExercises() {
    state.exercises = await api('GET', '/exercises');
    state.exById = new Map(state.exercises.map((e) => [e.id, e]));
  }

  // ================= UI: toast, modal, temporizador =================
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' error' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2500);
  }

  const modal = $('#modal');
  function openModal(html) {
    modal.innerHTML = html;
    modal.showModal();
    $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => modal.close()));
    return modal;
  }
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  const timer = { end: 0, handle: null, total: 0 };
  const timerEl = $('#timer');
  function startTimer(seconds) {
    timer.end = Date.now() + seconds * 1000;
    timerEl.hidden = false;
    document.body.classList.add('timer-on');
    timerEl.classList.remove('done');
    clearInterval(timer.handle);
    timer.handle = setInterval(tickTimer, 250);
    tickTimer();
  }
  function tickTimer() {
    const left = Math.round((timer.end - Date.now()) / 1000);
    const v = Math.max(0, left);
    $('#timer-value').textContent = `${Math.floor(v / 60)}:${pad(v % 60)}`;
    if (left <= 0 && !timerEl.classList.contains('done')) {
      timerEl.classList.add('done');
      $('#timer-value').textContent = '¡Ya!';
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      beep();
    }
    if (left < -15) stopTimer();
  }
  function stopTimer() { clearInterval(timer.handle); timerEl.hidden = true; document.body.classList.remove('timer-on'); }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); o.stop(ctx.currentTime + 0.35);
    } catch { /* sin audio */ }
  }
  timerEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-timer]');
    if (!b) return;
    if (b.dataset.timer === 'stop') return stopTimer();
    timer.end += Number(b.dataset.timer) * 1000;
    timerEl.classList.remove('done');
    tickTimer();
  });

  // ================= Router =================
  const routes = [
    [/^#\/resumen$/, () => viewSummary()],
    [/^#\/sesiones$/, () => viewSessions()],
    [/^#\/sesion\/nueva$/, () => viewStartLive()],
    [/^#\/sesion\/(?:manual|nueva)(?:\?copia=(\d+))?$/, (m) => viewEditor(null, m[1] ? Number(m[1]) : null)],
    [/^#\/sesion\/(\d+)$/, (m) => viewEditor(Number(m[1]))],
    [/^#\/en-vivo\/(\d+)$/, (m) => viewLive(Number(m[1]))],
    [/^#\/ejercicios$/, () => viewExercises()],
    [/^#\/ejercicio\/(\d+)$/, (m) => viewExercise(Number(m[1]))],
    [/^#\/ajustes$/, () => viewSettings()],
    [/^#\/usuarios$/, () => viewUsers()],
  ];

  let skipNextHash = false;
  async function route() {
    if (skipNextHash) { skipNextHash = false; return; }
    if (state.dirty && !confirm('Tienes cambios sin guardar. ¿Salir de todos modos?')) {
      skipNextHash = true;
      location.hash = state.lastHash;
      return;
    }
    state.dirty = false;
    state.lastHash = location.hash;
    const hash = location.hash || '#/resumen';
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    const found = routes.find(([re]) => re.test(hash));
    if (!found) { location.replace('#/resumen'); return; }
    const section = { 'en-vivo': 'sesion', usuarios: 'ajustes' }[hash.split(/[/?]/)[1]] || hash.split(/[/?]/)[1];
    state.onOnline = null;
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === section));
    view.innerHTML = '<p class="muted">Cargando…</p>';
    window.scrollTo(0, 0);
    try {
      await found[1](hash.match(found[0]));
    } catch (err) {
      console.error(err);
      view.innerHTML = `<div class="empty"><p>No se pudo cargar: ${esc(err.message)}</p>
        <button class="btn ghost" onclick="location.reload()">Reintentar</button></div>`;
    }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => state.onOnline && state.onOnline());
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ================= Vista: Resumen =================
  function delta(cur, prev, label) {
    if (!prev && !cur) return '<span class="delta">—</span>';
    if (!prev) return `<span class="delta up">nuevo vs ${label}</span>`;
    const pct = Math.round(((cur - prev) / prev) * 100);
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    return `<span class="delta ${cls}">${pct > 0 ? '▲' : pct < 0 ? '▼' : '='} ${Math.abs(pct)}% vs ${label}</span>`;
  }

  async function viewSummary() {
    const [s, active] = await Promise.all([
      api('GET', `/stats?period=${state.period}&date=${state.date}&today=${todayIso()}`),
      api('GET', '/sessions/active').catch(() => null),
    ]);
    const prevLabel = { week: 'sem. ant.', month: 'mes ant.', year: 'año ant.' }[s.period];
    const t = s.totals;
    const goal = s.period === 'week' ? s.weeklyGoal : Math.round(s.weeklyGoal * s.weeks);
    const goalPct = goal ? Math.min(100, Math.round((t.sessions / goal) * 100)) : 0;
    const perWeekLabel = s.period === 'week' ? 'esta semana' : `promedio semanal (${fmtNum(s.weeks, 1)} sem.)`;

    view.innerHTML = `
      ${liveBanner(active)}
      <div class="period-bar">
        <div class="segmented" role="tablist">
          ${['week', 'month', 'year'].map((p) => `<button data-period="${p}" class="${p === s.period ? 'active' : ''}">${{ week: 'Semana', month: 'Mes', year: 'Año' }[p]}</button>`).join('')}
        </div>
        <div class="period-nav">
          <button class="btn ghost icon" data-go="${s.prevDate}" aria-label="Anterior">‹</button>
          <strong>${esc(s.label)}</strong>
          <button class="btn ghost icon" data-go="${s.nextDate}" aria-label="Siguiente">›</button>
        </div>
        ${s.isCurrent ? '' : '<button class="btn ghost small" data-go="today">Hoy</button>'}
      </div>

      <div class="stack">
        <div class="kpis">
          <div class="kpi"><div class="label">Sesiones</div>
            <div class="value">${t.sessions}<small> / ${goal}</small></div>
            <div class="progress"><span style="width:${goalPct}%"></span></div>
            ${delta(t.sessions, s.previous.sessions, prevLabel)}</div>
          <div class="kpi"><div class="label">Tiempo</div><div class="value">${fmtMin(t.minutes)}</div>
            <span class="delta">${t.sessions ? `${fmtMin(t.minutes / t.sessions)} por sesión` : '—'}</span></div>
          <div class="kpi"><div class="label">Series</div><div class="value">${fmtNum(t.sets)}</div>${delta(t.sets, s.previous.sets, prevLabel)}</div>
          <div class="kpi"><div class="label">Repeticiones</div><div class="value">${fmtNum(t.reps)}</div>${delta(t.reps, s.previous.reps, prevLabel)}</div>
          <div class="kpi"><div class="label">Volumen</div><div class="value">${fmtKg(t.volume)}</div>${delta(t.volume, s.previous.volume, prevLabel)}</div>
          <div class="kpi"><div class="label">Esfuerzo medio</div><div class="value">${t.avgRpe ?? '—'}<small>${t.avgRpe ? ' RPE' : ''}</small></div>
            <span class="delta">${t.exercises} ejercicios distintos</span></div>
        </div>

        <div class="grid-2">
          <section class="card">
            <h2>Series por grupo muscular <small>${perWeekLabel}</small></h2>
            ${renderMuscles(s)}
          </section>
          <section class="card">
            <h2>Evolución
              <span class="segmented" id="metric">
                ${[['sets', 'Series'], ['volume', 'Kg'], ['sessions', 'Sesiones'], ['minutes', 'Min']].map(([k, l]) => `<button data-metric="${k}" class="${k === state.metric ? 'active' : ''}">${l}</button>`).join('')}
              </span>
            </h2>
            <div class="chart-box"><canvas id="chart-evo"></canvas></div>
          </section>
        </div>

        <div class="grid-2">
          <section class="card">
            <h2>Constancia <small>${t.days} día${t.days === 1 ? '' : 's'} entrenado${t.days === 1 ? '' : 's'}</small></h2>
            ${renderHeatmap(s)}
          </section>
          <section class="card">
            <h2>Desde que empezaste</h2>
            ${renderAllTime(s.allTime)}
          </section>
        </div>

        <div class="grid-2">
          <section class="card">
            <h2>Ejercicios más trabajados</h2>
            ${renderTopExercises(s.topExercises)}
          </section>
          <section class="card">
            <h2>Récords del período <small>vs. todo lo anterior</small></h2>
            ${renderRecords(s.records)}
          </section>
        </div>

        <section class="card" id="bw-card" hidden>
          <h2>Peso corporal</h2>
          <div class="chart-box"><canvas id="chart-bw"></canvas></div>
        </section>
      </div>`;

    $$('[data-period]').forEach((b) => b.addEventListener('click', () => {
      state.period = b.dataset.period;
      store.set('entrenos:period', state.period);
      route();
    }));
    $$('[data-go]').forEach((b) => b.addEventListener('click', () => {
      state.date = b.dataset.go === 'today' ? todayIso() : b.dataset.go;
      route();
    }));
    $$('[data-metric]').forEach((b) => b.addEventListener('click', () => {
      state.metric = b.dataset.metric;
      $$('[data-metric]').forEach((x) => x.classList.toggle('active', x === b));
      drawEvolution(s);
    }));

    drawEvolution(s);
    drawBodyweight();
  }

  function renderMuscles(s) {
    const weeks = s.weeks;
    const rows = s.muscles.filter((m) => m.sets || m.secondarySets);
    if (!rows.length) return '<p class="muted">Aún no hay series registradas en este período.</p>';
    const direct = (m) => m.sets / weeks;
    const indirect = (m) => (m.secondarySets * 0.5) / weeks;
    const max = Math.max(22, ...rows.map((m) => direct(m) + indirect(m)));
    const pct = (v) => `${(v / max) * 100}%`;
    const untrained = Object.keys(state.muscles)
      .filter((k) => !['cardio', 'otro'].includes(k) && !s.muscles.some((m) => m.muscle === k && m.sets))
      .map(muscleLabel);
    const low = rows
      .filter((m) => !['cardio', 'otro'].includes(m.muscle) && m.sets && m.effectivePerWeek < 10)
      .map((m) => m.label);
    return `
      <div class="muscle-list">
        ${rows.map((m) => `
          <div class="muscle-row">
            <span>${esc(m.label)}</span>
            <div class="bar" title="${fmtNum(direct(m), 1)} directas + ${fmtNum(m.secondarySets / weeks, 1)} indirectas por semana">
              <span class="zone" style="left:${pct(10)};width:${pct(10)}"></span>
              <span class="direct" style="width:${pct(direct(m))};background:${MUSCLE_COLORS[m.muscle] || ''}"></span>
              <span class="indirect" style="left:${pct(direct(m))};width:${pct(indirect(m))};background:${MUSCLE_COLORS[m.muscle] || ''}55"></span>
            </div>
            <span class="val">${fmtNum(direct(m), 1)}${m.secondarySets ? `<small>+${fmtNum(m.secondarySets / weeks, 1)} indir.</small>` : ''}
              ${s.period !== 'week' ? `<small>${m.sets} en total</small>` : ''}</span>
          </div>`).join('')}
      </div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>Series directas</span>
        <span><i style="background:color-mix(in srgb,var(--accent) 35%,transparent)"></i>Indirectas (cuentan ½)</span>
        <span><i style="background:color-mix(in srgb,var(--ok) 25%,transparent);border:1px dashed var(--ok)"></i>Rango típico 10–20/sem.</span>
      </div>
      ${low.length && !s.isCurrent ? `<p class="hint warn" style="margin-top:12px">Por debajo de 10 series efectivas/semana: ${esc(low.join(', '))}.</p>` : ''}
      ${untrained.length ? `<p class="hint" style="margin-top:12px">Sin series directas: ${esc(untrained.join(', '))}.</p>` : ''}`;
  }

  function renderHeatmap(s) {
    const today = todayIso();
    const level = (d) => {
      if (!(d in s.trainedDays)) return '';
      const n = s.trainedDays[d];
      return n > 20 ? 'l3' : n > 10 ? 'l2' : 'l1';
    };
    const cell = (d, text = '') => `<div class="d ${level(d)} ${d === today ? 'today' : ''}" title="${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}${d in s.trainedDays ? ` · ${s.trainedDays[d]} series` : ''}">${text}</div>`;
    const heads = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((h) => `<div class="h">${h}</div>`).join('');
    if (s.period === 'year') {
      let d = startOfWeek(s.from);
      let cells = '';
      while (d <= s.to) {
        cells += d < s.from ? '<div class="d out"></div>' : cell(d);
        d = addDays(d, 1);
      }
      return `<div class="heat year">${cells}</div>
        <div class="legend"><span>Menos</span><span><i style="background:var(--surface-2)"></i><i style="background:color-mix(in srgb,var(--accent) 35%,var(--surface-2))"></i><i style="background:color-mix(in srgb,var(--accent) 65%,var(--surface-2))"></i><i style="background:var(--accent)"></i></span><span>Más series</span></div>`;
    }
    let d = startOfWeek(s.from);
    let cells = '';
    while (d <= s.to) {
      cells += d < s.from ? '<div class="d out"></div>' : cell(d, Number(d.slice(8)));
      d = addDays(d, 1);
    }
    return `<div class="heat cal">${heads}${cells}</div>`;
  }

  function renderAllTime(a) {
    if (!a.sessions) return '<p class="muted">Registra tu primera sesión para ver tu historial.</p>';
    const last = a.daysSinceLast === 0 ? 'hoy' : a.daysSinceLast === 1 ? 'ayer' : `hace ${a.daysSinceLast} días`;
    return `
      <p style="margin-top:0">Entrenando desde el <strong>${fmtDate(a.first, { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
        · ${fmtNum(a.daysSinceFirst)} días (${fmtNum(a.daysSinceFirst / 7, 1)} semanas)</p>
      <div class="stat-line">
        <div><strong>${fmtNum(a.sessions)}</strong><span>sesiones</span></div>
        <div><strong>${fmtMin(a.minutes)}</strong><span>entrenando</span></div>
        <div><strong>${fmtNum(a.sets)}</strong><span>series</span></div>
        <div><strong>${fmtKg(a.volume)}</strong><span>levantados</span></div>
        <div><strong>${a.weekStreak}</strong><span>semana${a.weekStreak === 1 ? '' : 's'} seguidas</span></div>
        <div><strong>${fmtNum(a.sessions / Math.max(1, a.daysSinceFirst / 7), 1)}</strong><span>sesiones/semana</span></div>
        <div><strong>${last}</strong><span>último entreno</span></div>
      </div>`;
  }

  function renderTopExercises(list) {
    if (!list.length) return '<p class="muted">Sin datos en este período.</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr><th>Ejercicio</th><th class="n">Series</th><th class="n">Reps</th><th class="n">Máx.</th><th class="n">1RM est.</th></tr></thead>
      <tbody>${list.map((e) => `<tr>
        <td><a href="#/ejercicio/${e.id}">${esc(e.name)}</a><br><span class="chip">${esc(muscleLabel(e.muscle))}</span></td>
        <td class="n">${e.sets}</td><td class="n">${fmtNum(e.reps)}</td>
        <td class="n">${e.bestWeight ? `${fmtNum(e.bestWeight, 2)} kg` : '—'}</td>
        <td class="n">${e.bestE1rm ? `${fmtNum(e.bestE1rm, 1)} kg` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderRecords(list) {
    if (!list.length) return '<p class="muted">Ningún récord nuevo en este período. ¡A por ello!</p>';
    return `<div class="table-wrap"><table class="list">
      <thead><tr><th>Ejercicio</th><th class="n">Peso máx.</th><th class="n">1RM est.</th></tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td><a href="#/ejercicio/${r.id}">🏆 ${esc(r.name)}</a></td>
        <td class="n">${fmtNum(r.weight, 2)} kg<br><span class="muted small">antes ${fmtNum(r.prevWeight, 2)}</span></td>
        <td class="n">${fmtNum(r.e1rm, 1)} kg<br><span class="muted small">antes ${fmtNum(r.prevE1rm, 1)}</span></td></tr>`).join('')}</tbody></table></div>`;
  }

  function chartDefaults() {
    const cs = getComputedStyle(document.documentElement);
    return { text: cs.getPropertyValue('--muted').trim(), grid: cs.getPropertyValue('--border').trim(), accent: cs.getPropertyValue('--accent').trim() };
  }

  function makeChart(canvas, config) {
    if (!window.Chart || !canvas) return null;
    const existing = window.Chart.getChart(canvas);
    if (existing) {
      existing.destroy();
      state.charts = state.charts.filter((c) => c !== existing);
    }
    const c = new window.Chart(canvas, config);
    state.charts.push(c);
    return c;
  }

  function drawEvolution(s) {
    const { text, grid, accent } = chartDefaults();
    const labels = s.buckets.map((b) => b.label);
    let datasets;
    if (state.metric === 'sets') {
      const muscles = [...new Set(s.buckets.flatMap((b) => Object.keys(b.muscles)))];
      datasets = muscles.map((m) => ({
        label: muscleLabel(m),
        data: s.buckets.map((b) => b.muscles[m] || 0),
        backgroundColor: MUSCLE_COLORS[m] || accent,
        borderRadius: 3,
        stack: 'sets',
      }));
      if (!datasets.length) datasets = [{ label: 'Series', data: s.buckets.map(() => 0), backgroundColor: accent }];
    } else {
      const names = { volume: 'Volumen (kg)', sessions: 'Sesiones', minutes: 'Minutos' };
      datasets = [{ label: names[state.metric], data: s.buckets.map((b) => b[state.metric]), backgroundColor: accent, borderRadius: 4 }];
    }
    makeChart($('#chart-evo'), {
      type: 'bar',
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: state.metric === 'sets' && datasets.length > 1, position: 'bottom', labels: { color: text, boxWidth: 10, font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { stacked: true, ticks: { color: text }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: text, precision: 0 }, grid: { color: grid } },
        },
      },
    });
  }

  async function drawBodyweight() {
    const data = await api('GET', '/bodyweight');
    if (data.length < 2) return;
    $('#bw-card').hidden = false;
    const { text, grid, accent } = chartDefaults();
    makeChart($('#chart-bw'), {
      type: 'line',
      data: {
        labels: data.map((d) => fmtDate(d.date, { day: 'numeric', month: 'short', year: '2-digit' })),
        datasets: [{ label: 'kg', data: data.map((d) => d.bodyweight), borderColor: accent, backgroundColor: accent, tension: 0.3, pointRadius: 3 }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: text, maxTicksLimit: 8 }, grid: { display: false } }, y: { ticks: { color: text }, grid: { color: grid } } },
      },
    });
  }

  // ================= Vista: Sesiones =================
  async function viewSessions() {
    const sessions = await api('GET', '/sessions?limit=1000');
    const filterMuscle = store.get('entrenos:filter') || '';
    const render = (muscle) => {
      const list = muscle ? sessions.filter((s) => s.muscles.includes(muscle)) : sessions;
      const groups = new Map();
      for (const s of list) {
        const w = startOfWeek(s.date);
        if (!groups.has(w)) groups.set(w, []);
        groups.get(w).push(s);
      }
      const thisWeek = startOfWeek(todayIso());
      $('#session-groups').innerHTML = list.length
        ? [...groups].map(([w, items]) => `
          <section class="week-group">
            <header>
              <strong>${w === thisWeek ? 'Esta semana' : w === addDays(thisWeek, -7) ? 'Semana pasada' : `Semana del ${fmtDate(w)} ${w.slice(0, 4) !== thisWeek.slice(0, 4) ? w.slice(0, 4) : ''}`}</strong>
              <span>${items.length} sesión${items.length === 1 ? '' : 'es'} · ${items.reduce((a, s) => a + s.set_count, 0)} series · ${fmtMin(items.reduce((a, s) => a + (s.duration_min || 0), 0))}</span>
            </header>
            ${items.map(sessionItem).join('')}
          </section>`).join('')
        : `<div class="empty"><p>${muscle ? 'No hay sesiones con ese grupo muscular.' : 'Todavía no registras ninguna sesión.'}</p>
            <a class="btn" href="#/sesion/nueva">Registrar sesión</a></div>`;
    };

    view.innerHTML = `
      <div class="page-head">
        <h1>Sesiones</h1>
        <div class="row">
          <select id="filter-muscle" aria-label="Filtrar por grupo muscular" style="width:auto">
            <option value="">Todos los grupos</option>
            ${Object.entries(state.muscles).map(([k, v]) => `<option value="${k}" ${k === filterMuscle ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <a class="btn ghost" href="#/sesion/manual">Registrar pasada</a>
          <a class="btn" href="#/sesion/nueva">+ Nueva</a>
        </div>
      </div>
      ${liveBanner(sessions.find((s) => s.in_progress))}
      <div id="session-groups"></div>`;
    $('#filter-muscle').addEventListener('change', (e) => {
      store.set('entrenos:filter', e.target.value);
      render(e.target.value);
    });
    render(filterMuscle);
  }

  function sessionItem(s) {
    const d = parseIso(s.date);
    return `
      <a class="session-item" href="#/${s.in_progress ? 'en-vivo' : 'sesion'}/${s.id}">
        <div class="date"><span>${d.toLocaleDateString('es', { weekday: 'short' })}</span><b>${d.getDate()}</b><span>${d.toLocaleDateString('es', { month: 'short' })}</span></div>
        <div style="min-width:0">
          <div class="title">${esc(s.title || 'Entrenamiento')}${s.in_progress ? ' <span class="chip live">En curso</span>' : ''}</div>
          <div class="chips">${s.muscles.map((m) => `<span class="chip">${esc(muscleLabel(m))}</span>`).join('')}</div>
          ${s.notes ? `<div class="muted small" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.notes)}</div>` : ''}
        </div>
        <div class="meta">${s.exercise_count} ejerc.<br>${s.set_count} series${s.duration_min ? `<br>${fmtMin(s.duration_min)}` : ''}${s.rpe ? `<br>RPE ${s.rpe}` : ''}</div>
      </a>`;
  }

  // ================= Vista: Editor de sesión =================
  const DRAFT_KEY = `entrenos:draft:${token}`;
  const lastCache = new Map();

  async function lastTime(exerciseId, excludeSessionId) {
    const key = `${exerciseId}:${excludeSessionId || ''}`;
    if (!lastCache.has(key)) {
      lastCache.set(key, api('GET', `/exercises/${exerciseId}/history?limit=3`).then((h) =>
        h.history.find((x) => x.session_id !== excludeSessionId) || null
      ));
    }
    return lastCache.get(key);
  }

  async function viewEditor(id, copyFrom) {
    lastCache.clear();
    let draft;
    let restored = false;
    if (id) {
      draft = await api('GET', `/sessions/${id}`);
      if (draft.in_progress) { location.replace(`#/en-vivo/${id}`); return; }
    } else if (copyFrom) {
      const src = await api('GET', `/sessions/${copyFrom}`);
      draft = { ...src, id: undefined, date: todayIso(), notes: '', duration_min: null, rpe: null, bodyweight: null };
    } else {
      const saved = store.get(DRAFT_KEY);
      if (saved) {
        try { draft = JSON.parse(saved); restored = true; } catch { /* borrador corrupto */ }
      }
      draft ||= { date: todayIso(), title: '', duration_min: null, rpe: null, bodyweight: null, notes: '', exercises: [] };
    }
    draft.exercises = draft.exercises.map((e) => ({
      exercise_id: e.exercise_id, rest_sec: e.rest_sec, notes: e.notes || '',
      sets: e.sets.map((s) => ({ reps: s.reps, weight: s.weight, rir: s.rir })),
    }));
    state.dirty = !!copyFrom;

    const persist = () => {
      state.dirty = true;
      if (!id) store.set(DRAFT_KEY, JSON.stringify(draft));
    };

    view.innerHTML = `
      <div class="page-head">
        <h1>${id ? 'Editar sesión' : 'Registrar sesión'}</h1>
        <div class="row">
          ${id ? `<a class="btn ghost small" href="#/sesion/manual?copia=${id}">Repetir sesión</a>` : ''}
          ${restored ? '<button class="btn ghost small" id="discard">Descartar borrador</button>' : ''}
        </div>
      </div>
      ${restored ? '<p class="hint">Se recuperó un borrador sin guardar.</p><br>' : ''}
      <form id="editor" autocomplete="off">
        <section class="card">
          <div class="fields">
            <label class="field">Fecha<input type="date" data-f="date" value="${esc(draft.date)}" required></label>
            <label class="field">Duración (min)<input inputmode="numeric" data-f="duration_min" value="${esc(draft.duration_min ?? '')}" placeholder="60"></label>
            <label class="field full">Nombre / enfoque<input data-f="title" value="${esc(draft.title)}" placeholder="Ej.: Torso, Pierna, Push…" maxlength="120"></label>
            <label class="field">Esfuerzo (RPE 1-10)<select data-f="rpe"><option value="">—</option>${[...Array(10)].map((_, i) => `<option ${Number(draft.rpe) === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
            <label class="field">Peso corporal (kg)<input inputmode="decimal" data-f="bodyweight" value="${esc(draft.bodyweight ?? '')}" placeholder="opcional"></label>
            <label class="field full">Comentarios de la sesión<textarea data-f="notes" maxlength="4000" placeholder="Cómo te sentiste, sueño, molestias…">${esc(draft.notes)}</textarea></label>
          </div>
        </section>
        <h2 style="margin:20px 2px 10px">Ejercicios</h2>
        <div id="ex-list"></div>
        <button type="button" class="btn ghost" id="add-ex" style="width:100%;margin-top:12px">+ Agregar ejercicio</button>
        <div class="save-bar">
          ${id ? '<button type="button" class="btn danger" id="delete">Eliminar</button><span class="spacer"></span>' : ''}
          <a class="btn ghost" href="#/sesiones">Cancelar</a>
          <button type="submit" class="btn">Guardar sesión</button>
        </div>
      </form>`;

    const form = $('#editor');
    const exList = $('#ex-list');

    const renderExercises = () => {
      if (!draft.exercises.length) {
        exList.innerHTML = '<p class="muted card">Agrega los ejercicios que hiciste. Se sugieren las series de la última vez.</p>';
        return;
      }
      exList.innerHTML = draft.exercises.map((ex, i) => {
        const info = state.exById.get(ex.exercise_id) || { name: '¿?', muscle: 'otro', secondary: [] };
        return `
          <div class="ex-card" data-i="${i}">
            <div class="ex-head">
              <div class="name">
                <strong>${i + 1}. ${esc(info.name)}</strong>
                <div class="chips"><span class="chip main">${esc(muscleLabel(info.muscle))}</span>${info.secondary.map((m) => `<span class="chip">${esc(muscleLabel(m))}</span>`).join('')}</div>
              </div>
              <button type="button" class="btn ghost icon" data-act="up" data-i="${i}" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn ghost icon" data-act="down" data-i="${i}" aria-label="Bajar" ${i === draft.exercises.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn ghost icon" data-act="remove-ex" data-i="${i}" aria-label="Quitar ejercicio">✕</button>
            </div>
            <div class="ex-last" id="last-${i}"></div>
            <table class="sets">
              <thead><tr><th>#</th><th>Reps</th><th>Kg</th><th class="rir">RIR</th><th></th></tr></thead>
              <tbody>${ex.sets.map((s, j) => `
                <tr>
                  <td>${j + 1}</td>
                  <td><input inputmode="numeric" data-i="${i}" data-j="${j}" data-f="reps" value="${esc(s.reps ?? '')}" aria-label="Repeticiones serie ${j + 1}"></td>
                  <td><input inputmode="decimal" data-i="${i}" data-j="${j}" data-f="weight" value="${esc(s.weight ?? '')}" aria-label="Kilos serie ${j + 1}"></td>
                  <td class="rir"><input inputmode="numeric" data-i="${i}" data-j="${j}" data-f="rir" value="${esc(s.rir ?? '')}" placeholder="–" aria-label="Repeticiones en reserva serie ${j + 1}"></td>
                  <td><button type="button" class="btn ghost icon" data-act="remove-set" data-i="${i}" data-j="${j}" aria-label="Quitar serie">−</button></td>
                </tr>`).join('')}
              </tbody>
            </table>
            <div class="ex-foot">
              <div class="row">
                <button type="button" class="btn ghost small" data-act="add-set" data-i="${i}">+ Serie</button>
                <span class="spacer"></span>
                <label class="field" style="max-width:130px">Descanso (seg)<input inputmode="numeric" data-i="${i}" data-f="rest_sec" value="${esc(ex.rest_sec ?? '')}" placeholder="90"></label>
                <button type="button" class="btn ghost small" data-act="timer" data-i="${i}" title="Iniciar temporizador de descanso" style="align-self:flex-end">⏱</button>
              </div>
              <label class="field">Comentarios del ejercicio<input data-i="${i}" data-f="notes" value="${esc(ex.notes)}" placeholder="Técnica, sensaciones, ajustes de máquina…" maxlength="2000"></label>
            </div>
          </div>`;
      }).join('');
      draft.exercises.forEach(async (ex, i) => {
        const last = await lastTime(ex.exercise_id, id);
        const el = $(`#last-${i}`);
        if (el && last) {
          el.textContent = `Última vez (${fmtDate(last.date)}): ${fmtSets(last.sets) || 'sin series'}${last.rest_sec ? ` · descanso ${last.rest_sec}s` : ''}${last.notes ? ` · “${last.notes}”` : ''}`;
          if (beatLast(ex.sets, last)) el.insertAdjacentHTML('beforeend', ' <span class="beat">🏆 Superada</span>');
        }
      });
    };
    renderExercises();

    form.addEventListener('input', (e) => {
      const el = e.target;
      const f = el.dataset.f;
      if (!f) return;
      if (el.dataset.j !== undefined) {
        draft.exercises[el.dataset.i].sets[el.dataset.j][f] = el.value;
      } else if (el.dataset.i !== undefined) {
        draft.exercises[el.dataset.i][f] = el.value;
      } else {
        draft[f] = el.value;
      }
      persist();
    });

    form.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.dataset.i);
      const ex = draft.exercises[i];
      switch (b.dataset.act) {
        case 'add-set': {
          const last = ex.sets[ex.sets.length - 1];
          ex.sets.push(last ? { ...last } : { reps: '', weight: '', rir: '' });
          break;
        }
        case 'remove-set':
          ex.sets.splice(Number(b.dataset.j), 1);
          break;
        case 'remove-ex':
          if (ex.sets.some((s) => s.reps || s.weight) && !confirm('¿Quitar este ejercicio y sus series?')) return;
          draft.exercises.splice(i, 1);
          break;
        case 'up':
          [draft.exercises[i - 1], draft.exercises[i]] = [draft.exercises[i], draft.exercises[i - 1]];
          break;
        case 'down':
          [draft.exercises[i + 1], draft.exercises[i]] = [draft.exercises[i], draft.exercises[i + 1]];
          break;
        case 'timer':
          startTimer(numOrNull(ex.rest_sec) || 90);
          return;
        default:
          return;
      }
      persist();
      renderExercises();
      if (b.dataset.act === 'add-set') {
        const inputs = $$(`.ex-card[data-i="${i}"] input[data-f="reps"]`);
        inputs[inputs.length - 1]?.focus();
      }
    });

    $('#add-ex').addEventListener('click', () => pickExercise(async (exercise) => {
      const last = await lastTime(exercise.id, id).catch(() => null);
      draft.exercises.push({
        exercise_id: exercise.id,
        rest_sec: last ? last.rest_sec : null,
        notes: '',
        sets: last && last.sets.length
          ? last.sets.map((s) => ({ reps: s.reps, weight: s.weight, rir: s.rir }))
          : [{ reps: '', weight: '', rir: '' }],
      });
      persist();
      renderExercises();
      exList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

    $('#discard')?.addEventListener('click', () => {
      if (!confirm('¿Descartar el borrador?')) return;
      store.del(DRAFT_KEY);
      state.dirty = false;
      route();
    });

    $('#delete')?.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta sesión? No se puede deshacer.')) return;
      await api('DELETE', `/sessions/${id}`);
      state.dirty = false;
      toast('Sesión eliminada');
      location.hash = '#/sesiones';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = sessionPayload(draft);
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await api(id ? 'PUT' : 'POST', id ? `/sessions/${id}` : '/sessions', payload);
        if (!id) store.del(DRAFT_KEY);
        state.dirty = false;
        toast('Sesión guardada ✔');
        location.hash = '#/sesiones';
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  }

  // ================= Vista: Entrenamiento en vivo =================
  // Se anota a medida que entrenas: agregas un ejercicio, confirmas cada serie y todo se guarda solo.
  const liveKey = (id) => `entrenos:live:${token}:${id}`;

  async function viewStartLive() {
    const active = await api('GET', '/sessions/active');
    if (active) { location.replace(`#/en-vivo/${active.id}`); return; }
    view.innerHTML = `
      <div class="page-head"><h1>Nuevo entrenamiento</h1></div>
      <form id="start" class="card stack" autocomplete="off">
        <p class="muted" style="margin:0">Empieza ahora y ve anotando cada ejercicio y serie a medida que la haces.
          Verás lo que hiciste la vez anterior para superarlo. Se guarda solo.</p>
        <label class="field">Nombre / enfoque (opcional)<input name="title" placeholder="Ej.: Torso, Pierna, Push…" maxlength="120"></label>
        <button class="btn" type="submit">Empezar entrenamiento</button>
      </form>
      <p class="muted small" style="margin-top:16px">¿Quieres registrar un entrenamiento que ya hiciste? <a href="#/sesion/manual">Registrar sesión pasada</a></p>`;
    $('#start').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const title = new FormData(e.target).get('title').trim();
        const s = await api('POST', '/sessions', { date: todayIso(), title, in_progress: true, exercises: [] });
        location.hash = `#/en-vivo/${s.id}`;
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  }

  async function viewLive(id) {
    lastCache.clear();
    const server = await api('GET', `/sessions/${id}`);
    if (!server.in_progress) { location.replace(`#/sesion/${id}`); return; }
    let draft = server;
    let pendingLocal = false;
    try {
      const local = JSON.parse(store.get(liveKey(id)) || 'null');
      // Cambios que no alcanzaron a subir (sin conexión, pestaña cerrada…).
      if (local && local.pending && local.draft) { draft = local.draft; pendingLocal = true; }
    } catch { /* copia local corrupta */ }
    draft.in_progress = true;
    draft.exercises = draft.exercises.map((e) => ({
      exercise_id: e.exercise_id, rest_sec: e.rest_sec, notes: e.notes || '',
      sets: e.sets.map((s) => ({ reps: s.reps, weight: s.weight, rir: s.rir })),
    }));

    // Última vez de cada ejercicio (objetivo a superar).
    const lasts = new Map();
    await Promise.all(draft.exercises.map(async (ex) => {
      lasts.set(ex.exercise_id, await lastTime(ex.exercise_id, id).catch(() => null));
    }));

    let open = draft.exercises[draft.exercises.length - 1] || null; // ejercicio expandido
    const nextVals = new WeakMap(); // lo escrito en "siguiente serie", por ejercicio

    // ---------- Autoguardado ----------
    const saver = { timer: null, current: null, again: false, closed: false };
    const setStatus = (text, cls = '') => {
      const el = $('#save-state');
      if (el) { el.textContent = text; el.className = cls; }
    };
    const flush = async () => {
      clearTimeout(saver.timer);
      if (saver.closed) return;
      if (saver.current) { saver.again = true; return saver.current; }
      saver.current = (async () => {
        try {
          await api('PUT', `/sessions/${id}`, sessionPayload(draft));
          if (!saver.again) {
            store.del(liveKey(id));
            setStatus('Guardado ✓', 'ok');
          }
        } catch (err) {
          setStatus(err.status ? `No se guardó: ${err.message}` : 'Sin conexión · se reintentará', 'warn');
        }
      })();
      await saver.current;
      saver.current = null;
      if (saver.again) { saver.again = false; await flush(); }
    };
    const save = (now = false) => {
      if (saver.closed) return;
      store.set(liveKey(id), JSON.stringify({ pending: true, draft }));
      setStatus('Guardando…');
      clearTimeout(saver.timer);
      saver.timer = setTimeout(flush, now ? 0 : 800);
    };
    const stopSaving = async () => {
      saver.closed = true;
      saver.again = false;
      clearTimeout(saver.timer);
      await saver.current;
    };
    state.onOnline = () => { if (store.get(liveKey(id))) flush(); };

    const started = new Date(draft.created_at);
    view.innerHTML = `
      <div class="live-head">
        <div class="live-title">
          <input data-f="title" value="${esc(draft.title)}" placeholder="Entrenamiento de hoy" maxlength="120" aria-label="Nombre del entrenamiento">
          <div class="muted small">Empezaste ${started.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })} · <span id="save-state">Guardado ✓</span></div>
        </div>
        <button type="button" class="btn" id="finish">Terminar</button>
      </div>
      <div id="live-list"></div>
      <button type="button" class="btn ghost live-add" id="add-ex">+ Agregar ejercicio</button>`;
    const list = $('#live-list');

    // Siguiente serie: la de la vez anterior (objetivo), sin bajar del peso que ya usaste hoy.
    const nextDefaults = (ex) => {
      const target = lasts.get(ex.exercise_id)?.sets[ex.sets.length];
      const prev = ex.sets[ex.sets.length - 1];
      const src = target || prev || {};
      const weight = target && prev && (prev.weight || 0) > (target.weight || 0) ? prev.weight : src.weight;
      return { reps: src.reps ?? '', weight: weight ?? '', rir: '' };
    };
    const nextOf = (ex) => nextVals.get(ex) || nextDefaults(ex);

    const cmpLabel = (s, prev) => {
      const c = compareSet(s, prev);
      if (c === 'new') return '<span></span>';
      return `<span class="cmp ${c}">${{ up: '↑', same: '=', down: '↓' }[c]} ${c === 'same' ? '' : setDelta(s, prev)}</span>`;
    };

    const stepper = (f, label, value, step, mode) => `
      <div class="stepper">
        <span>${label}</span>
        <div>
          <button type="button" class="btn ghost icon" data-act="step" data-f="${f}" data-d="-${step}" aria-label="Menos ${label}">−</button>
          <input inputmode="${mode}" data-next="${f}" value="${esc(value)}" aria-label="${label}">
          <button type="button" class="btn ghost icon" data-act="step" data-f="${f}" data-d="${step}" aria-label="Más ${label}">+</button>
        </div>
      </div>`;

    const render = () => {
      if (!draft.exercises.length) {
        list.innerHTML = `<div class="card empty" style="padding:24px 16px">
          <p style="margin:0">Agrega el ejercicio que vas a hacer y anota cada serie al terminarla.</p></div>`;
        return;
      }
      list.innerHTML = draft.exercises.map((ex, i) => {
        const info = state.exById.get(ex.exercise_id) || { name: '¿?', muscle: 'otro', secondary: [] };
        const last = lasts.get(ex.exercise_id);
        const beat = beatLast(ex.sets, last);
        if (ex !== open) {
          return `
            <button type="button" class="ex-card live-ex collapsed" data-act="open" data-i="${i}">
              <strong>${i + 1}. ${esc(info.name)}</strong>
              ${beat ? '<span class="beat">🏆</span>' : ''}
              <span class="muted small">${ex.sets.length ? esc(fmtSets(ex.sets)) : 'sin series'}</span>
            </button>`;
        }
        const next = nextOf(ex);
        const target = last?.sets[ex.sets.length];
        return `
          <div class="ex-card live-ex" data-i="${i}">
            <div class="ex-head">
              <div class="name">
                <strong>${i + 1}. ${esc(info.name)}</strong>
                <div class="chips"><span class="chip main">${esc(muscleLabel(info.muscle))}</span>${info.secondary.map((m) => `<span class="chip">${esc(muscleLabel(m))}</span>`).join('')}</div>
              </div>
              <button type="button" class="btn ghost icon" data-act="remove-ex" data-i="${i}" aria-label="Quitar ejercicio">✕</button>
            </div>
            <div class="ex-last">${last
              ? `Última vez (${fmtDate(last.date)}): ${esc(fmtSets(last.sets) || 'sin series')}${last.notes ? ` · “${esc(last.notes)}”` : ''}`
              : 'Primera vez que registras este ejercicio.'}</div>
            ${beat ? '<div class="beat big">🏆 Superaste la vez anterior</div>' : ''}
            ${ex.sets.length ? `<ol class="done-sets">${ex.sets.map((s, j) => `
              <li>
                <span class="n">${j + 1}</span>
                <span class="v">${esc(fmtSet(s))}${s.rir !== null && s.rir !== '' && s.rir !== undefined ? ` <small class="muted">RIR ${esc(s.rir)}</small>` : ''}</span>
                ${cmpLabel(s, last?.sets[j])}
                <button type="button" class="btn ghost icon" data-act="edit-set" data-i="${i}" data-j="${j}" aria-label="Editar serie ${j + 1}">✎</button>
              </li>`).join('')}</ol>` : ''}
            <div class="next-set" data-i="${i}">
              <div class="next-label">Serie ${ex.sets.length + 1}${target ? ` · a superar: <strong>${esc(fmtSet(target))}</strong>` : ''}</div>
              <div class="steppers">
                ${stepper('reps', 'Reps', next.reps, 1, 'numeric')}
                ${stepper('weight', 'Kg', next.weight, 2.5, 'decimal')}
                <label class="stepper rir"><span>RIR</span><input inputmode="numeric" data-next="rir" value="${esc(next.rir)}" placeholder="–" aria-label="Repeticiones en reserva"></label>
              </div>
              <button type="button" class="btn done-btn" data-act="done" data-i="${i}">✓ Serie hecha</button>
            </div>
            <details class="live-more">
              <summary>Descanso ${ex.rest_sec ? `${esc(ex.rest_sec)}s` : '90s'} · comentarios${ex.notes ? ' ✎' : ''}</summary>
              <div class="row" style="flex-wrap:nowrap;align-items:flex-end">
                <label class="field" style="max-width:130px">Descanso (seg)<input inputmode="numeric" data-i="${i}" data-f="rest_sec" value="${esc(ex.rest_sec ?? '')}" placeholder="90"></label>
                <button type="button" class="btn ghost small" data-act="timer" data-i="${i}" title="Iniciar descanso">⏱ Descanso</button>
              </div>
              <label class="field">Comentarios del ejercicio<input data-i="${i}" data-f="notes" value="${esc(ex.notes)}" placeholder="Técnica, sensaciones, ajustes de máquina…" maxlength="2000"></label>
            </details>
          </div>`;
      }).join('');
    };
    render();
    if (pendingLocal) save(true);

    $('.live-title input').addEventListener('input', (e) => { draft.title = e.target.value; save(); });

    list.addEventListener('input', (e) => {
      const el = e.target;
      const card = el.closest('[data-i]');
      const ex = card && draft.exercises[card.dataset.i];
      if (!ex) return;
      if (el.dataset.next) {
        nextVals.set(ex, { ...nextOf(ex), [el.dataset.next]: el.value });
      } else if (el.dataset.f) {
        ex[el.dataset.f] = el.value;
        save();
      }
    });

    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.closest('[data-i]').dataset.i);
      const ex = draft.exercises[i];
      const last = lasts.get(ex.exercise_id);
      switch (b.dataset.act) {
        case 'open':
          open = ex;
          render();
          $(`.live-ex[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        case 'step': {
          const cur = nextOf(ex);
          const v = Math.max(0, Math.round(((numOrNull(cur[b.dataset.f]) || 0) + Number(b.dataset.d)) * 100) / 100);
          nextVals.set(ex, { ...cur, [b.dataset.f]: v });
          $(`.next-set input[data-next="${b.dataset.f}"]`, list).value = v;
          return;
        }
        case 'done': {
          const v = nextOf(ex);
          const set = { reps: numOrNull(v.reps), weight: numOrNull(v.weight), rir: numOrNull(v.rir) };
          if (set.reps === null && set.weight === null) { toast('Anota las reps o los kilos', true); return; }
          const prev = last?.sets[ex.sets.length];
          const wasBeaten = beatLast(ex.sets, last);
          ex.sets.push(set);
          nextVals.delete(ex);
          if (!wasBeaten && beatLast(ex.sets, last)) toast('🏆 ¡Superaste la vez anterior!');
          else if (compareSet(set, prev) === 'up') toast(`↑ ${setDelta(set, prev)} vs la vez anterior`);
          startTimer(numOrNull(ex.rest_sec) || 90);
          save(true);
          render();
          return;
        }
        case 'edit-set':
          editLiveSet(ex, Number(b.dataset.j), () => { save(true); render(); });
          return;
        case 'remove-ex':
          if (ex.sets.length && !confirm('¿Quitar este ejercicio y sus series?')) return;
          draft.exercises.splice(i, 1);
          if (open === ex) open = draft.exercises[draft.exercises.length - 1] || null;
          save(true);
          render();
          return;
        case 'timer':
          startTimer(numOrNull(ex.rest_sec) || 90);
          return;
        default:
      }
    });

    $('#add-ex').addEventListener('click', () => pickExercise(async (exercise) => {
      const last = await lastTime(exercise.id, id).catch(() => null);
      lasts.set(exercise.id, last);
      const ex = { exercise_id: exercise.id, rest_sec: last ? last.rest_sec : null, notes: '', sets: [] };
      draft.exercises.push(ex);
      open = ex;
      save(true);
      render();
      list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    $('#finish').addEventListener('click', () => {
      const withSets = draft.exercises.filter((ex) => ex.sets.length);
      const compared = withSets.filter((ex) => lasts.get(ex.exercise_id)?.sets.length);
      const beaten = compared.filter((ex) => beatLast(ex.sets, lasts.get(ex.exercise_id)));
      const minutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      const nSets = withSets.reduce((a, ex) => a + ex.sets.length, 0);
      const m = openModal(`
        <form method="dialog" id="finish-form" autocomplete="off">
          <div class="modal-head"><h2>Terminar entrenamiento</h2><button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
          <div class="modal-body">
            <p style="margin:0">${withSets.length} ejercicio${withSets.length === 1 ? '' : 's'} · ${nSets} serie${nSets === 1 ? '' : 's'}${compared.length ? `<br>🏆 Superaste la vez anterior en <strong>${beaten.length} de ${compared.length}</strong> ejercicio${compared.length === 1 ? '' : 's'}` : ''}</p>
            ${withSets.length ? '' : '<p class="hint warn">No anotaste ninguna serie. Puedes descartar este entrenamiento.</p>'}
            <div class="fields">
              <label class="field">Duración (min)<input inputmode="numeric" name="duration_min" value="${minutes}"></label>
              <label class="field">Esfuerzo (RPE 1-10)<select name="rpe"><option value="">—</option>${[...Array(10)].map((_, i) => `<option>${i + 1}</option>`).join('')}</select></label>
              <label class="field full">Peso corporal (kg)<input inputmode="decimal" name="bodyweight" value="${esc(draft.bodyweight ?? '')}" placeholder="opcional"></label>
              <label class="field full">Comentarios de la sesión<textarea name="notes" maxlength="4000" placeholder="Cómo te sentiste, sueño, molestias…">${esc(draft.notes)}</textarea></label>
            </div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn danger" id="discard-live">Descartar</button>
            <span class="spacer"></span>
            <button type="button" class="btn ghost" data-close>Seguir</button>
            <button type="submit" class="btn">Guardar</button>
          </div>
        </form>`);
      $('#discard-live', m).addEventListener('click', async () => {
        if (!confirm('¿Descartar este entrenamiento? Se borran todas sus series.')) return;
        await stopSaving();
        try {
          await api('DELETE', `/sessions/${id}`);
        } catch (err) {
          if (err.status !== 404) { saver.closed = false; toast(err.message, true); return; }
        }
        store.del(liveKey(id));
        m.close();
        toast('Entrenamiento descartado');
        location.hash = '#/sesiones';
      });
      $('#finish-form', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const btn = e.target.querySelector('[type=submit]');
        btn.disabled = true;
        await stopSaving(); // que un guardado pendiente no vuelva a marcarla "en curso"
        const final = { ...draft, in_progress: false, duration_min: fd.get('duration_min'), rpe: fd.get('rpe'), bodyweight: fd.get('bodyweight'), notes: fd.get('notes') };
        try {
          await api('PUT', `/sessions/${id}`, sessionPayload(final));
          store.del(liveKey(id));
          stopTimer();
          m.close();
          toast(beaten.length ? `Entrenamiento guardado ✔ · 🏆 ${beaten.length} de ${compared.length}` : 'Entrenamiento guardado ✔');
          location.hash = '#/sesiones';
        } catch (err) {
          saver.closed = false;
          toast(err.status ? err.message : 'Sin conexión. Inténtalo de nuevo.', true);
          btn.disabled = false;
        }
      });
    });
  }

  // Editar o borrar una serie ya anotada en vivo.
  function editLiveSet(ex, j, onDone) {
    const s = ex.sets[j];
    const m = openModal(`
      <form method="dialog" id="set-form" autocomplete="off">
        <div class="modal-head"><h2>Serie ${j + 1}</h2><button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
        <div class="modal-body">
          <div class="fields">
            <label class="field">Reps<input inputmode="numeric" name="reps" value="${esc(s.reps ?? '')}"></label>
            <label class="field">Kg<input inputmode="decimal" name="weight" value="${esc(s.weight ?? '')}"></label>
            <label class="field">RIR<input inputmode="numeric" name="rir" value="${esc(s.rir ?? '')}" placeholder="–"></label>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn danger" id="del-set">Borrar</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">Guardar</button>
        </div>
      </form>`);
    $('#del-set', m).addEventListener('click', () => {
      ex.sets.splice(j, 1);
      m.close();
      onDone();
    });
    $('#set-form', m).addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const set = { reps: numOrNull(fd.get('reps')), weight: numOrNull(fd.get('weight')), rir: numOrNull(fd.get('rir')) };
      if (set.reps === null && set.weight === null) { toast('Anota las reps o los kilos', true); return; }
      ex.sets[j] = set;
      m.close();
      onDone();
    });
  }

  // Selector de ejercicio (con búsqueda y creación rápida).
  function pickExercise(onPick) {
    const recent = [...state.exercises].filter((e) => !e.archived);
    openModal(`
      <div class="modal-head"><h2>Agregar ejercicio</h2><button class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
      <div class="modal-body">
        <input id="pick-q" placeholder="Buscar ejercicio…" autofocus>
        <select id="pick-m"><option value="">Todos los grupos</option>${Object.entries(state.muscles).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <div class="pick-list" id="pick-list"></div>
        <button class="btn ghost" id="pick-new">+ Crear ejercicio nuevo</button>
      </div>`);
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const draw = () => {
      const q = norm($('#pick-q').value.trim());
      const m = $('#pick-m').value;
      const list = recent
        .filter((e) => (!q || norm(e.name).includes(q)) && (!m || e.muscle === m || e.secondary.includes(m)))
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, 'es'));
      $('#pick-list').innerHTML = list.length
        ? list.map((e) => `<button type="button" data-id="${e.id}"><span>${esc(e.name)}</span><span class="chip">${esc(muscleLabel(e.muscle))}</span></button>`).join('')
        : '<p class="muted">Sin resultados. Puedes crearlo abajo.</p>';
    };
    draw();
    $('#pick-q').addEventListener('input', draw);
    $('#pick-m').addEventListener('change', draw);
    $('#pick-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      modal.close();
      onPick(state.exById.get(Number(b.dataset.id)));
    });
    $('#pick-new').addEventListener('click', () => editExercise(null, onPick, { name: $('#pick-q').value.trim(), muscle: $('#pick-m').value }));
  }

  // Formulario crear/editar ejercicio.
  function editExercise(ex, onSaved, defaults = {}) {
    const data = ex || { name: defaults.name || '', muscle: defaults.muscle || 'pecho', secondary: [] };
    openModal(`
      <form method="dialog" id="ex-form">
        <div class="modal-head"><h2>${ex ? 'Editar ejercicio' : 'Nuevo ejercicio'}</h2><button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
        <div class="modal-body">
          <label class="field">Nombre<input name="name" value="${esc(data.name)}" required maxlength="80"></label>
          <label class="field">Grupo muscular principal
            <select name="muscle">${Object.entries(state.muscles).map(([k, v]) => `<option value="${k}" ${k === data.muscle ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          </label>
          <div class="field">Grupos secundarios (cuentan como ½ serie)
            <div class="checks">${Object.entries(state.muscles).map(([k, v]) => `<label><input type="checkbox" name="secondary" value="${k}" ${data.secondary.includes(k) ? 'checked' : ''}>${esc(v)}</label>`).join('')}</div>
          </div>
        </div>
        <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
      </form>`);
    $('#ex-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), muscle: fd.get('muscle'), secondary: fd.getAll('secondary').filter((m) => m !== fd.get('muscle')) };
      try {
        let saved;
        if (ex) {
          await api('PATCH', `/exercises/${ex.id}`, body);
          saved = { ...ex, ...body };
        } else {
          saved = await api('POST', '/exercises', body);
        }
        await loadExercises();
        modal.close();
        toast('Ejercicio guardado');
        onSaved && onSaved(state.exById.get(saved.id) || saved);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ================= Vista: Ejercicios =================
  async function viewExercises() {
    await loadExercises();
    let showArchived = false;
    view.innerHTML = `
      <div class="page-head">
        <h1>Ejercicios</h1>
        <button class="btn" id="new-ex">+ Nuevo</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <input id="ex-q" placeholder="Buscar…" style="flex:1;min-width:160px">
        <label class="row small muted" style="flex-wrap:nowrap"><input type="checkbox" id="ex-arch" style="width:auto;min-height:0"> Archivados</label>
      </div>
      <div id="ex-groups"></div>`;
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const draw = () => {
      const q = norm($('#ex-q').value.trim());
      const list = state.exercises.filter((e) => (showArchived || !e.archived) && (!q || norm(e.name).includes(q)));
      $('#ex-groups').innerHTML = Object.entries(state.muscles).map(([k, label]) => {
        const items = list.filter((e) => e.muscle === k);
        if (!items.length) return '';
        return `<h3 class="group-title">${esc(label)} · ${items.length}</h3><div class="ex-list">${items.map((e) => `
          <a class="ex-row ${e.archived ? 'archived' : ''}" href="#/ejercicio/${e.id}">
            <span class="name">${esc(e.name)}${e.secondary.length ? `<br><span class="muted small">+ ${esc(e.secondary.map(muscleLabel).join(', '))}</span>` : ''}</span>
            <span class="muted small">${e.uses ? `${e.uses} ${e.uses === 1 ? 'vez' : 'veces'}` : ''}${e.archived ? ' · archivado' : ''}</span>
          </a>`).join('')}</div>`;
      }).join('') || '<p class="muted">Sin resultados.</p>';
    };
    draw();
    $('#ex-q').addEventListener('input', draw);
    $('#ex-arch').addEventListener('change', (e) => { showArchived = e.target.checked; draw(); });
    $('#new-ex').addEventListener('click', () => editExercise(null, draw));
  }

  async function viewExercise(exId) {
    const [h] = await Promise.all([api('GET', `/exercises/${exId}/history?limit=500`), loadExercises()]);
    const ex = state.exById.get(exId);
    const hist = h.history;
    view.innerHTML = `
      <div class="page-head">
        <div>
          <a href="#/ejercicios" class="muted small">‹ Ejercicios</a>
          <h1>${esc(ex.name)}</h1>
          <div class="chips" style="margin-top:6px"><span class="chip main">${esc(muscleLabel(ex.muscle))}</span>${ex.secondary.map((m) => `<span class="chip">${esc(muscleLabel(m))}</span>`).join('')}</div>
        </div>
        <div class="row">
          <button class="btn ghost small" id="edit">Editar</button>
          <button class="btn ghost small" id="archive">${ex.archived ? 'Restaurar' : hist.length ? 'Archivar' : 'Eliminar'}</button>
        </div>
      </div>
      <div class="stack">
        <div class="kpis">
          <div class="kpi"><div class="label">Sesiones</div><div class="value">${hist.length}</div></div>
          <div class="kpi"><div class="label">Peso máximo</div><div class="value">${h.bestWeight ? `${fmtNum(h.bestWeight, 2)}<small> kg</small>` : '—'}</div></div>
          <div class="kpi"><div class="label">1RM estimado</div><div class="value">${h.bestE1rm ? `${fmtNum(h.bestE1rm, 1)}<small> kg</small>` : '—'}</div></div>
          <div class="kpi"><div class="label">Última vez</div><div class="value" style="font-size:1.1rem">${hist[0] ? fmtDate(hist[0].date, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</div></div>
        </div>
        ${hist.length > 1 ? '<section class="card"><h2>Progreso <small>1RM estimado (Epley) y volumen</small></h2><div class="chart-box"><canvas id="chart-ex"></canvas></div></section>' : ''}
        <section class="card">
          <h2>Historial</h2>
          ${hist.length ? `<div class="table-wrap"><table class="list">
            <thead><tr><th>Fecha</th><th>Series</th><th class="n">Volumen</th></tr></thead>
            <tbody>${hist.map((x) => `<tr>
              <td><a href="#/sesion/${x.session_id}">${fmtDate(x.date, { day: 'numeric', month: 'short', year: '2-digit' })}</a>${x.title ? `<br><span class="muted small">${esc(x.title)}</span>` : ''}</td>
              <td>${esc(fmtSets(x.sets)) || '—'}${x.rest_sec ? `<br><span class="muted small">descanso ${x.rest_sec}s</span>` : ''}${x.notes ? `<br><span class="muted small">${esc(x.notes)}</span>` : ''}</td>
              <td class="n">${x.volume ? fmtKg(x.volume) : '—'}</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="muted">Aún no has registrado este ejercicio.</p>'}
        </section>
      </div>`;

    $('#edit').addEventListener('click', () => editExercise(ex, () => route()));
    $('#archive').addEventListener('click', async () => {
      if (ex.archived) {
        await api('PATCH', `/exercises/${ex.id}`, { archived: false });
        toast('Ejercicio restaurado');
        return route();
      }
      if (!confirm(hist.length ? '¿Archivar? Se oculta de la lista pero conserva su historial.' : '¿Eliminar este ejercicio?')) return;
      const r = await api('DELETE', `/exercises/${ex.id}`);
      toast(r.archived ? 'Ejercicio archivado' : 'Ejercicio eliminado');
      location.hash = '#/ejercicios';
    });

    if (hist.length > 1) {
      const chron = [...hist].reverse();
      const { text, grid, accent } = chartDefaults();
      makeChart($('#chart-ex'), {
        data: {
          labels: chron.map((x) => fmtDate(x.date, { day: 'numeric', month: 'short' })),
          datasets: [
            { type: 'line', label: '1RM est. (kg)', data: chron.map((x) => x.e1rm || null), borderColor: accent, backgroundColor: accent, tension: 0.3, yAxisID: 'y', spanGaps: true },
            { type: 'bar', label: 'Volumen (kg)', data: chron.map((x) => x.volume), backgroundColor: `${MUSCLE_COLORS[ex.muscle] || accent}66`, yAxisID: 'y2', borderRadius: 3 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: text, boxWidth: 10 } }, tooltip: { mode: 'index', intersect: false } },
          scales: {
            x: { ticks: { color: text, maxTicksLimit: 10 }, grid: { display: false } },
            y: { position: 'left', ticks: { color: text }, grid: { color: grid } },
            y2: { position: 'right', beginAtZero: true, ticks: { color: text }, grid: { display: false } },
          },
        },
      });
    }
  }

  // ================= Vista: Ajustes =================
  async function viewSettings() {
    const link = `${location.origin}/t/${token}`;
    view.innerHTML = `
      <div class="page-head"><h1>Ajustes</h1></div>
      <div class="stack">
        <section class="card">
          <h2>General</h2>
          <form id="settings" class="fields">
            <label class="field full">Nombre del espacio<input name="name" value="${esc(state.me.name)}" maxlength="80"></label>
            <label class="field">Meta de sesiones por semana<input name="weekly_goal" inputmode="numeric" value="${state.me.weekly_goal}"></label>
            <div class="field" style="align-self:end"><button class="btn" type="submit">Guardar</button></div>
          </form>
        </section>

        <section class="card">
          <h2>Tu enlace de acceso</h2>
          <p class="muted small" style="margin-top:0">Es la llave de tus datos: quien lo tenga puede verlos y editarlos. Guárdalo en favoritos o
            agrégalo a la pantalla de inicio del celular (menú del navegador → “Agregar a pantalla de inicio”).</p>
          <div class="link-box"><input readonly value="${esc(link)}" id="link"><button class="btn ghost" id="copy">Copiar</button></div>
          ${state.me.is_admin
            ? `<p class="muted small">Si crees que alguien más lo tiene, genera uno nuevo: el anterior dejará de funcionar en todos tus dispositivos.</p>
               <button class="btn danger" id="rotate">Generar enlace nuevo</button>`
            : '<p class="muted small">Si perdiste tu enlace o crees que alguien más lo tiene, pide uno nuevo a quien te lo dio.</p>'}
        </section>

        ${state.me.is_admin ? `
        <section class="card">
          <h2>Usuarios</h2>
          <p class="muted small" style="margin-top:0">Crea enlaces para otras personas: cada una tiene sus propios datos.
            Si alguien pierde su enlace, desde aquí le generas uno nuevo.</p>
          <a class="btn" href="#/usuarios">Administrar usuarios →</a>
        </section>` : ''}

        <section class="card">
          <h2>Respaldo</h2>
          <p class="muted small" style="margin-top:0">Descarga todos tus datos en un archivo JSON o restaura uno anterior.</p>
          <div class="row">
            <button class="btn ghost" id="export">Descargar respaldo</button>
            <label class="btn ghost">Importar…<input type="file" id="import" accept="application/json,.json" hidden></label>
          </div>
        </section>

        <section class="card">
          <h2>Este dispositivo</h2>
          <p class="muted small" style="margin-top:0">Deja de recordar el enlace en este navegador (no borra tus datos).</p>
          <button class="btn ghost" id="forget">Olvidar en este dispositivo</button>
        </section>
      </div>`;

    $('#settings').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('PATCH', '/me', { name: fd.get('name'), weekly_goal: fd.get('weekly_goal') });
        await loadMe();
        toast('Ajustes guardados');
      } catch (err) { toast(err.message, true); }
    });
    $('#copy').addEventListener('click', () => copyText(link));
    $('#rotate')?.addEventListener('click', async () => {
      if (!confirm('Se generará un enlace nuevo y el actual dejará de funcionar. ¿Continuar?')) return;
      const r = await api('POST', '/rotate');
      store.set(TOKEN_KEY, r.token);
      location.replace(`/t/${r.token}#/ajustes`);
    });
    $('#export').addEventListener('click', async () => {
      const data = await api('GET', '/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `entrenamientos-${todayIso()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const replace = confirm('¿Reemplazar todas tus sesiones actuales por las del archivo?\n\nAceptar = reemplazar · Cancelar = agregar a las existentes');
        const r = await api('POST', `/import${replace ? '?mode=replace' : ''}`, data);
        await loadExercises();
        toast(`${r.imported} sesiones importadas`);
      } catch (err) {
        toast(err instanceof SyntaxError ? 'El archivo no es un JSON válido' : err.message, true);
      }
      e.target.value = '';
    });
    $('#forget').addEventListener('click', () => {
      if (!confirm('¿Olvidar el enlace en este dispositivo? Necesitarás abrirlo de nuevo para entrar.')) return;
      store.del(TOKEN_KEY);
      store.del(DRAFT_KEY);
      location.replace('/');
    });
  }

  // ================= Vista: Usuarios (administrador) =================
  const userLink = (tok) => `${location.origin}/t/${tok}`;

  async function copyText(text, msg = 'Enlace copiado') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast(msg);
  }

  // Compartir (WhatsApp, correo…) donde el navegador lo permita; si no, copia.
  async function shareLink(name, link) {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Mis Entrenamientos', text: `Hola ${name}, este es tu enlace para registrar tus entrenamientos (no lo compartas):`, url: link });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    copyText(link);
  }

  function showLinkModal(user, title, note) {
    const link = userLink(user.token);
    const m = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
      <div class="modal-body">
        <p style="margin:0">Envíale este enlace a <strong>${esc(user.name)}</strong>. Es su llave: quien lo tenga entra a sus datos.</p>
        <div class="link-box"><input readonly value="${esc(link)}"><button class="btn ghost" data-copy>Copiar</button></div>
        ${note ? `<p class="hint">${esc(note)}</p>` : ''}
      </div>
      <div class="modal-foot"><button class="btn ghost" data-close>Listo</button><button class="btn" data-share>Compartir</button></div>`);
    $('[data-copy]', m).addEventListener('click', () => copyText(link));
    $('[data-share]', m).addEventListener('click', () => shareLink(user.name, link));
  }

  async function viewUsers() {
    if (!state.me.is_admin) { location.replace('#/resumen'); return; }
    const users = await api('GET', `/admin/users?today=${todayIso()}`);
    const activity = (u) => {
      if (!u.sessions) return 'Aún no entrena';
      return `${u.sessions} sesión${u.sessions === 1 ? '' : 'es'} · ${u.week} esta semana · última: ${fmtDate(u.last_date)}`;
    };
    view.innerHTML = `
      <div class="page-head">
        <h1>Usuarios</h1>
        <button class="btn" id="new-user">+ Nuevo usuario</button>
      </div>
      <p class="hint">No abras sus enlaces en este navegador: la app recordaría el de ellos en vez del tuyo.
        Usa <strong>Copiar</strong> o <strong>Compartir</strong> para enviárselos.</p>
      <div class="user-list">
        ${users.map((u) => `
          <div class="user-card${u.disabled ? ' disabled' : ''}" data-id="${u.id}">
            <div class="user-main">
              <div class="user-name">
                <strong>${esc(u.name)}</strong>
                ${u.token === token ? '<span class="chip main">Tú · admin</span>' : ''}
                ${u.disabled ? '<span class="chip warn">Suspendido</span>' : ''}
                ${u.in_progress ? '<span class="chip live">Entrenando</span>' : ''}
              </div>
              <div class="muted small">${activity(u)}</div>
            </div>
            <div class="user-actions">
              <button class="btn ghost small" data-act="copy">Copiar enlace</button>
              <button class="btn ghost small" data-act="share">Compartir</button>
              <details class="menu">
                <summary class="btn ghost small icon" aria-label="Más acciones">⋯</summary>
                <div class="menu-list">
                  <button data-act="rename">Cambiar nombre</button>
                  <button data-act="rotate">Generar enlace nuevo</button>
                  ${u.token === token ? '' : `<button data-act="toggle">${u.disabled ? 'Reactivar acceso' : 'Suspender acceso'}</button>
                  <button data-act="delete" class="danger">Eliminar usuario</button>`}
                </div>
              </details>
            </div>
          </div>`).join('')}
      </div>`;

    $('#new-user').addEventListener('click', () => {
      const m = openModal(`
        <form method="dialog" id="user-form" autocomplete="off">
          <div class="modal-head"><h2>Nuevo usuario</h2><button type="button" class="btn ghost icon" data-close aria-label="Cerrar">✕</button></div>
          <div class="modal-body">
            <label class="field">Nombre<input name="name" required maxlength="80" placeholder="Ej.: Ana" autofocus></label>
            <p class="muted small" style="margin:0">Se crea su espacio con el catálogo de ejercicios y un enlace propio para entrar.</p>
          </div>
          <div class="modal-foot"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn" type="submit">Crear</button></div>
        </form>`);
      $('#user-form', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const user = await api('POST', '/admin/users', { name: new FormData(e.target).get('name') });
          m.close();
          await route();
          showLinkModal(user, 'Usuario creado');
        } catch (err) { toast(err.message, true); }
      });
    });

    $('.user-list').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const u = users.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      b.closest('details')?.removeAttribute('open');
      try {
        switch (b.dataset.act) {
          case 'copy': return copyText(userLink(u.token));
          case 'share': return shareLink(u.name, userLink(u.token));
          case 'rename': {
            const name = prompt('Nuevo nombre', u.name);
            if (!name || !name.trim() || name.trim() === u.name) return;
            await api('PATCH', `/admin/users/${u.id}`, { name });
            if (u.token === token) await loadMe();
            toast('Nombre actualizado');
            return route();
          }
          case 'rotate': {
            const self = u.token === token;
            if (!confirm(self
              ? 'Se generará un enlace nuevo para ti y el actual dejará de funcionar en todos tus dispositivos. ¿Continuar?'
              : `Se generará un enlace nuevo para ${u.name} y el actual dejará de funcionar. ¿Continuar?`)) return;
            const { token: tok } = await api('POST', `/admin/users/${u.id}/rotate`);
            if (self) {
              store.set(TOKEN_KEY, tok);
              location.replace(`/t/${tok}#/usuarios`);
              return;
            }
            showLinkModal({ ...u, token: tok }, 'Enlace nuevo', 'El enlace anterior ya no funciona.');
            return;
          }
          case 'toggle': {
            if (!u.disabled && !confirm(`¿Suspender el acceso de ${u.name}? Sus datos se conservan y puedes reactivarlo cuando quieras.`)) return;
            await api('PATCH', `/admin/users/${u.id}`, { disabled: !u.disabled });
            toast(u.disabled ? 'Acceso reactivado' : 'Acceso suspendido');
            return route();
          }
          case 'delete': {
            if (!confirm(`¿Eliminar a ${u.name} y todos sus entrenamientos? No se puede deshacer.`)) return;
            await api('DELETE', `/admin/users/${u.id}`);
            toast('Usuario eliminado');
            return route();
          }
          default:
        }
      } catch (err) { toast(err.message, true); }
    });
  }

  // ================= Arranque =================
  async function loadMe() {
    const me = await api('GET', '/me');
    state.me = me;
    state.muscles = me.muscles;
    $('#brand-name').textContent = me.name;
    document.title = me.name;
  }

  (async () => {
    try {
      await Promise.all([loadMe(), loadExercises()]);
    } catch (err) {
      if (err.status === 404) {
        store.del(TOKEN_KEY);
        renderLanding('invalid');
        return;
      }
      // Suspendido: se conserva el enlace para que vuelva a funcionar si lo reactivan.
      if (err.status === 403) { renderLanding('suspended'); return; }
      view.innerHTML = `<div class="empty"><p>No se pudo conectar con el servidor.</p><button class="btn ghost" onclick="location.reload()">Reintentar</button></div>`;
      return;
    }
    $('#nav').hidden = false;
    route();
  })();
})();
