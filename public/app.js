'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const LEVEL_TXT = { safe: 'Aman', warn: 'Waspada', danger: 'Bahaya' };
  const LOAD_TXT = { safe: 'Normal', warn: 'Waspada', danger: 'Bahaya' };
  const STATE_TXT = {
    pitch: { safe: 'Stabil', warn: 'Waspada', danger: 'Bahaya' },
    roll: { safe: 'Seimbang', warn: 'Waspada', danger: 'Bahaya' },
  };

  let state = null;
  let history = null;
  let range = '1h';
  let hoverIdx = null;
  let dirty = false;
  let incShowAll = false;
  let lastIncId = -1;
  let incidents = { total: 0, items: [] };

  /* ------------------------------ util ------------------------------ */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (n) => Number(n).toFixed(1);

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = 'toast'), 2800);
  }

  async function api(path, method, body) {
    const res = await fetch(path, {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Permintaan gagal');
    return data;
  }

  function fmtTime(iso) {
    const parts = new Intl.DateTimeFormat('id-ID', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta',
    }).formatToParts(new Date(iso));
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${g('day')} ${g('month')}, ${g('hour')}:${g('minute')}`;
  }

  function setConn(on) {
    $('#conn').classList.toggle('off', !on);
    $('#connText').textContent = on ? 'Terhubung' : 'Terputus';
  }

  /* ----------------------------- render ----------------------------- */
  function setBadge(el, level, map) {
    el.className = 'badge ' + level;
    el.textContent = map[level];
  }

  function setGauge(id, value, level, kind) {
    const g = $(id);
    const danger = state.settings.danger;
    const frac = Math.min(Math.abs(value) / danger, 1);
    g.classList.remove('warn', 'danger');
    if (level !== 'safe') g.classList.add(level);
    g.querySelector('.g-arc').setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
    const ang = frac * 2 * Math.PI - Math.PI / 2;
    const knob = g.querySelector('.g-knob');
    knob.setAttribute('cx', (60 + 50 * Math.cos(ang)).toFixed(2));
    knob.setAttribute('cy', (60 + 50 * Math.sin(ang)).toFixed(2));
    g.querySelector('.gv').textContent = f1(value);
    g.querySelector('.gs').textContent = STATE_TXT[kind][level];
  }

  function render() {
    const s = state;
    const st = s.status;

    // hero
    $('#hero').dataset.status = st;
    $('#heroTitle').textContent =
      st === 'safe' ? 'Semua Parameter Normal' : st === 'warn' ? 'Perhatian: Parameter Mendekati Batas' : 'Bahaya: Batas Terlampaui';
    $('#heroBadge').textContent = '● ' + (st === 'safe' ? 'Stabil' : LEVEL_TXT[st]);
    $('#hPitch').textContent = f1(s.pitch) + '°';
    $('#hRoll').textContent = f1(s.roll) + '°';
    $('#hLoad').textContent = f1(s.load) + ' kg';
    $('#heroServo').textContent = '● ' + (s.servo.closed ? 'Palang Rak Tertutup' : 'Palang Rak Siaga');
    $('#bellDot').hidden = st === 'safe';

    // servo
    $('#servoAngle').textContent = s.servo.angle + '°';
    $('#autoMode').checked = s.servo.auto;
    const sb = $('#servoState');
    sb.className = 'badge ' + (s.servo.closed ? 'warn' : 'safe');
    sb.textContent = s.servo.closed ? (s.servo.reason === 'auto' ? 'Tertutup Otomatis' : 'Tertutup Manual') : 'Terbuka Normal';
    const btn = $('#servoBtn');
    btn.className = 'btn-soft ' + (s.servo.closed ? 'ok' : 'danger');
    btn.querySelector('use').setAttribute('href', s.servo.closed ? '#i-unlock' : '#i-lock');
    btn.querySelector('span').textContent = s.servo.closed ? 'Buka Palang' : 'Tutup Palang';

    // pitch / roll
    setBadge($('#pitchBadge'), s.levels.pitch, LEVEL_TXT);
    setBadge($('#rollBadge'), s.levels.roll, LEVEL_TXT);
    setGauge('#gPitch', s.pitch, s.levels.pitch, 'pitch');
    setGauge('#gRoll', s.roll, s.levels.roll, 'roll');
    $('#pitchLimit').textContent = f1(s.settings.warn) + '°';
    $('#rollLimit').textContent = f1(s.settings.warn) + '°';

    // load
    setBadge($('#loadBadge'), s.levels.load, LOAD_TXT);
    $('#loadVal').textContent = f1(s.load);
    $('#loadMax').textContent = '/ ' + f1(s.settings.maxLoad) + ' kg';
    const bar = $('#loadBar');
    bar.style.width = Math.min(s.loadPct, 100) + '%';
    bar.className = s.levels.load === 'safe' ? '' : s.levels.load;
    $('#loadTol').textContent = f1(s.tolerance) + ' kg';
    $('#loadPct').textContent = s.loadPct + '% Terpakai';

    // telemetry
    $('#rssi').textContent = s.telemetry.rssi + ' dBm';
    $('#srcName').textContent = s.telemetry.source === 'device' ? 'Perangkat ESP32' : 'Simulator Sensor';
    $('#srcVal').textContent = 'Aktif (' + s.telemetry.hz + 'Hz)';
    const m = Math.floor(s.telemetry.uptimeSec / 60);
    $('#uptime').textContent = `${Math.floor(m / 60)} Jam ${m % 60} Menit`;

    // LED RGB
    const LED_TXT = { green: 'Hijau', yellow: 'Kuning', red: 'Merah' };
    $('#ledDot').className = 'led ' + s.led.color;
    $('#ledTxt').textContent = LED_TXT[s.led.color] + (s.buzzer ? ' + Buzzer' : '');

    // legend + simulasi
    $('#lgPitch').textContent = `Pitch (${f1(s.pitch)}°)`;
    $('#lgRoll').textContent = `Roll (${f1(s.roll)}°)`;
    if (document.activeElement !== $('#scenario')) $('#scenario').value = s.scenario;

    if (!dirty) syncSliders(s.settings);

    if (s.lastIncidentId !== lastIncId) {
      lastIncId = s.lastIncidentId;
      loadIncidents();
    }
  }

  /* ----------------------------- sliders ---------------------------- */
  const sliders = {
    warn: { el: '#sWarn', val: '#vWarn', mid: '#mWarn', unit: '°', midTxt: 'Normal: ' },
    danger: { el: '#sDanger', val: '#vDanger', mid: '#mDanger', unit: '°', midTxt: 'Kritis: ' },
    maxLoad: { el: '#sLoad', val: '#vLoad', mid: '#mLoad', unit: ' kg', midTxt: 'Kapasitas: ' },
  };

  function paintSlider(k) {
    const c = sliders[k];
    const el = $(c.el);
    const v = Number(el.value);
    const pct = ((v - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--pct', pct + '%');
    $(c.val).textContent = f1(v) + c.unit;
    $(c.mid).textContent = c.midTxt + f1(v) + c.unit;
  }

  function syncSliders(set) {
    for (const k of Object.keys(sliders)) {
      $(sliders[k].el).value = set[k];
      paintSlider(k);
    }
  }

  for (const k of Object.keys(sliders)) {
    $(sliders[k].el).addEventListener('input', () => {
      dirty = true;
      paintSlider(k);
    });
  }

  $('#saveBtn').addEventListener('click', async () => {
    const body = {
      warn: Number($('#sWarn').value),
      danger: Number($('#sDanger').value),
      maxLoad: Number($('#sLoad').value),
    };
    if (body.warn >= body.danger) return toast('Batas Waspada harus lebih kecil dari Batas Bahaya', true);
    const b = $('#saveBtn');
    b.disabled = true;
    try {
      await api('/api/settings', 'PUT', body);
      dirty = false;
      toast('Ambang batas berhasil disimpan');
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  });

  /* ----------------------------- controls --------------------------- */
  $('#servoBtn').addEventListener('click', async () => {
    if (!state) return;
    try {
      await api('/api/servo', 'POST', { action: state.servo.closed ? 'open' : 'close' });
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#autoMode').addEventListener('change', async (e) => {
    try {
      await api('/api/servo', 'POST', { auto: e.target.checked });
      toast(e.target.checked ? 'Mode otomatis aktif' : 'Mode otomatis dimatikan');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#scenario').addEventListener('change', async (e) => {
    try {
      await api('/api/simulate', 'POST', { scenario: e.target.value });
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#bell').addEventListener('click', () => $('#historyCard').scrollIntoView({ behavior: 'smooth', block: 'center' }));

  $('#rangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    range = b.dataset.range;
    hoverIdx = null;
    document.querySelectorAll('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#liveBadge').textContent = range === '1h' ? 'Live 60 Menit' : 'Live 24 Jam';
    loadHistory();
  });

  /* ---------------------------- incidents --------------------------- */
  async function loadIncidents() {
    try {
      incidents = await api('/api/incidents');
      renderIncidents();
    } catch {}
  }

  function renderIncidents() {
    $('#incCount').textContent = incidents.total + ' Insiden';
    const items = incShowAll ? incidents.items : incidents.items.slice(0, 4);
    $('#incList').innerHTML = items
      .map(
        (i) => `<li class="inc">
        <div class="inc-ic ${esc(i.level)}"><svg class="ic"><use href="#${i.level === 'danger' ? 'i-alert' : 'i-info'}"/></svg></div>
        <div class="inc-body"><div class="inc-title">${esc(i.text)}</div><div class="inc-sub">${esc(fmtTime(i.time))} · ${esc(i.note)}</div></div>
        <span class="badge ${esc(i.level)}">${LEVEL_TXT[i.level] || ''}</span></li>`
      )
      .join('');
    $('#moreBtn').firstChild.textContent = incShowAll ? 'Tampilkan lebih sedikit ' : 'Lihat semua log aktivitas ';
  }

  $('#moreBtn').addEventListener('click', () => {
    incShowAll = !incShowAll;
    renderIncidents();
  });

  /* ------------------------------ chart ----------------------------- */
  async function loadHistory() {
    try {
      history = await api('/api/history?range=' + range);
      drawChart();
    } catch {}
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 270, PL = 44, PR = 24, PT = 34, PB = 40;
  const IW = W - PL - PR, IH = H - PT - PB;

  function drawChart() {
    if (!history || !history.points.length) return;
    const svg = $('#chart');
    const { from, to, points } = history;
    const warn = state ? state.settings.warn : 7;
    let maxData = warn + 2;
    for (const p of points) maxData = Math.max(maxData, p.p, p.r);
    const maxV = Math.max(12, Math.ceil(maxData + 1));
    const x = (t) => PL + ((t - from) / (to - from)) * IW;
    const y = (v) => PT + IH - (v / maxV) * IH;
    const step = maxV > 14 ? 5 : 3;

    let out = `<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".16"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>`;
    for (let v = 0; v <= maxV; v += step) {
      out += `<line x1="${PL}" x2="${W - PR}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1f7"/>`;
      out += `<text x="${PL - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#8a94ad">${v}°</text>`;
    }

    const line = (key) => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    const first = points[0], last = points[points.length - 1];
    out += `<path d="${line('p')} L${x(last.t).toFixed(1)} ${y(0)} L${x(first.t).toFixed(1)} ${y(0)} Z" fill="url(#ag)"/>`;

    // garis batas waspada
    out += `<line x1="${PL}" x2="${W - PR}" y1="${y(warn)}" y2="${y(warn)}" stroke="#f59e0b" stroke-width="1.6" stroke-dasharray="7 6"/>`;
    out += `<text x="${W - PR}" y="${y(warn) - 8}" text-anchor="end" font-size="12" font-weight="600" fill="#d97706">Batas Waspada ${f1(warn)}°</text>`;

    out += `<path d="${line('r')}" fill="none" stroke="#14b8a6" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;
    out += `<path d="${line('p')}" fill="none" stroke="#2563eb" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`;

    // penanda (hover atau titik terakhir)
    const idx = hoverIdx == null || hoverIdx >= points.length ? points.length - 1 : hoverIdx;
    const pt = points[idx];
    const px = x(pt.t);
    out += `<line x1="${px}" x2="${px}" y1="${PT - 6}" y2="${y(0)}" stroke="#93b4f5" stroke-dasharray="3 4"/>`;
    out += `<circle cx="${px}" cy="${y(pt.r)}" r="4.5" fill="#fff" stroke="#14b8a6" stroke-width="2.5"/>`;
    out += `<circle cx="${px}" cy="${y(pt.p)}" r="5.5" fill="#fff" stroke="#2563eb" stroke-width="3"/>`;
    const label = `P ${f1(pt.p)}°  ·  R ${f1(pt.r)}°`;
    const bw = 130;
    const bx = Math.min(Math.max(px - bw / 2, PL), W - PR - bw);
    const by = Math.max(2, y(pt.p) - 40);
    out += `<rect x="${bx}" y="${by}" width="${bw}" height="26" rx="13" fill="#2563eb"/>`;
    out += `<text x="${bx + bw / 2}" y="${by + 17}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${label}</text>`;

    // label sumbu X
    const labels = range === '1h' ? ['60 mnt lalu', '45 mnt lalu', '30 mnt lalu', '15 mnt lalu', 'Sekarang'] : ['24 jam lalu', '18 jam lalu', '12 jam lalu', '6 jam lalu', 'Sekarang'];
    labels.forEach((t, i) => {
      const lx = PL + (IW * i) / 4;
      const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
      const lastLbl = i === 4;
      out += `<text x="${lx}" y="${H - 12}" text-anchor="${anchor}" font-size="12" ${lastLbl ? 'font-weight="700" fill="#2563eb"' : 'fill="#8a94ad"'}>${t}</text>`;
    });

    svg.innerHTML = out;
  }

  const chartEl = $('#chart');
  function onMove(ev) {
    if (!history) return;
    const r = chartEl.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const t = history.from + ((sx - PL) / IW) * (history.to - history.from);
    let best = 0, bd = Infinity;
    history.points.forEach((p, i) => {
      const d = Math.abs(p.t - t);
      if (d < bd) { bd = d; best = i; }
    });
    hoverIdx = best;
    drawChart();
  }
  chartEl.addEventListener('pointermove', onMove);
  chartEl.addEventListener('pointerleave', () => { hoverIdx = null; drawChart(); });

  /* ------------------------------ start ----------------------------- */
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    setConn(true);
    render();
    if (!history) loadHistory();
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);

  setInterval(loadHistory, 5000);
  window.addEventListener('resize', drawChart);
})();
