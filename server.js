'use strict';
/**
 * Smart Shelf Tilt Warning System - server Node.js
 * - REST API + Server-Sent Events untuk data live
 * - Simulator sensor (dipakai bila ESP32 belum mengirim telemetri)
 * - Logika ambang batas: Aman / Waspada / Bahaya
 * - Kendali servo palang (otomatis & manual), riwayat insiden
 * - Penyimpanan ke MySQL (tabel readings & incidents)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || ''; // opsional: wajib untuk POST /api/telemetry
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/* -------------------------------- Database ------------------------------- */
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'smart_shelf',
};
let pool = null; // null = database belum/tidak tersambung -> server tetap jalan pakai memori

function dbRun(sql, params) {
  if (!pool) return;
  pool.execute(sql, params).catch((e) => console.error('DB error:', e.message));
}

async function initDb() {
  try {
    const boot = await mysql.createConnection({ host: DB.host, port: DB.port, user: DB.user, password: DB.password });
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${DB.database}\``);
    await boot.end();
    const p = mysql.createPool({ ...DB, connectionLimit: 5 });
    // Sama dengan struktur tabel yang sudah ada di smart_shelf.sql (dilewati bila tabel sudah ada)
    await p.query(`CREATE TABLE IF NOT EXISTS incidents (
      id INT NOT NULL PRIMARY KEY,
      ts DATETIME(3) NOT NULL,
      kind VARCHAR(10) NOT NULL, level VARCHAR(10) NOT NULL,
      text VARCHAR(160) NOT NULL, note VARCHAR(160) NOT NULL,
      KEY idx_ts (ts)
    )`);
    await p.query(`CREATE TABLE IF NOT EXISTS readings (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ts DATETIME(3) NOT NULL,
      pitch FLOAT NOT NULL, roll FLOAT NOT NULL, load_kg FLOAT NOT NULL,
      KEY idx_ts (ts)
    )`);
    pool = p;
    console.log(`Database MySQL tersambung (${DB.host}/${DB.database}).`);
    try {
      await loadFromDb();
    } catch (e) {
      console.error('Gagal memuat data lama dari database:', e.message);
    }
  } catch (e) {
    pool = null;
    console.error('Database tidak tersambung, memakai memori saja:', e.message);
  }
}

// Muat data lama dari database supaya tidak hilang saat server restart
async function loadFromDb() {
  const [inc] = await pool.query('SELECT id, ts, kind, level, text, note FROM incidents ORDER BY id DESC LIMIT 200');
  if (inc.length) {
    incidents.length = 0;
    for (const r of inc) {
      incidents.push({ id: r.id, time: new Date(r.ts).toISOString(), kind: r.kind, level: r.level, text: r.text, note: r.note });
    }
    nextIncidentId = inc[0].id + 1;
  }
  const [rows] = await pool.query('SELECT ts, pitch, roll FROM readings WHERE ts >= ? ORDER BY ts', [
    new Date(Date.now() - 24 * 3600 * 1000),
  ]);
  if (rows.length) {
    history.length = 0;
    for (const r of rows) {
      history.push({ t: new Date(r.ts).getTime(), p: +Math.abs(r.pitch).toFixed(2), r: +Math.abs(r.roll).toFixed(2) });
    }
  }
}

/* ------------------------------ Pengaturan ------------------------------ */
const DEFAULTS = { warn: 7.0, danger: 10.0, maxLoad: 2.0 };
const RANGES = { warn: [3, 12], danger: [6, 15], maxLoad: [0.5, 5] };
const LABELS = { warn: 'Batas Waspada', danger: 'Batas Bahaya', maxLoad: 'Beban Maksimal' };

function validateSettings(s) {
  for (const k of Object.keys(RANGES)) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${LABELS[k]} harus berupa angka` };
    if (v < RANGES[k][0] || v > RANGES[k][1]) {
      return { ok: false, error: `${LABELS[k]} harus antara ${RANGES[k][0]} dan ${RANGES[k][1]}` };
    }
  }
  if (s.warn >= s.danger) return { ok: false, error: 'Batas Waspada harus lebih kecil dari Batas Bahaya' };
  return { ok: true };
}

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    return validateSettings(s).ok ? s : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Gagal menyimpan pengaturan:', e.message);
  }
}

let settings = loadSettings();

/* --------------------------------- State -------------------------------- */
const OPEN_ANGLE = 30;
const CLOSED_ANGLE = 90;
const SCENARIOS = {
  normal: { pitch: 4.0, roll: 3.0, load: 1.2 },
  warn: { pitch: 8.2, roll: 5.5, load: 1.7 },
  danger: { pitch: 11.2, roll: 6.5, load: 2.3 },
};
const RANK = { safe: 0, warn: 1, danger: 2 };

const startedAt = Date.now() - (14 * 3600 + 22 * 60) * 1000; // demo: sudah menyala 14 jam 22 menit
const state = {
  pitch: 4.0,
  roll: 3.0,
  load: 1.2,
  rssi: -52,
  scenario: 'normal',
  lastTelemetry: 0,
  servo: { closed: true, angle: CLOSED_ANGLE, auto: true, reason: 'auto' }, // awal: tertutup, hanya dibuka lewat tombol dashboard
};
const prevLevels = { pitch: 'safe', roll: 'safe', load: 'safe' };

/* ------------------------------- Riwayat sudut --------------------------- */
const INTERVAL = 15000; // satu titik tiap 15 detik
const KEEP = (24 * 3600 * 1000) / INTERVAL; // 24 jam
const history = [];
let lastHistoryAt = Date.now();

(function seedHistory() {
  const now = Date.now();
  const N = KEEP;
  const rawP = (j) => 3.6 + 1.1 * Math.sin(j / 180) + 0.6 * Math.sin(j / 47 + 1) + 0.15 * Math.sin(j / 5);
  const rawR = (j) => 2.8 + 0.8 * Math.sin(j / 210 + 2) + 0.4 * Math.sin(j / 61) + 0.12 * Math.sin(j / 6 + 1);
  const dP = 4.0 - rawP(N - 1);
  const dR = 3.0 - rawR(N - 1);
  for (let j = 0; j < N; j++) {
    const w = Math.max(0, 1 - (N - 1 - j) / 240);
    history.push({
      t: now - (N - 1 - j) * INTERVAL,
      p: +Math.max(0.3, rawP(j) + dP * w).toFixed(2),
      r: +Math.max(0.3, rawR(j) + dR * w).toFixed(2),
    });
  }
  state.pitch = history[N - 1].p;
  state.roll = history[N - 1].r;
})();

/* ------------------------------- Insiden --------------------------------- */
let nextIncidentId = 1;
const incidents = [];
function seedIncident(iso, kind, level, text, note) {
  incidents.unshift({ id: nextIncidentId++, time: new Date(iso).toISOString(), kind, level, text, note });
}
// Data contoh (urut dari yang paling lama)
seedIncident('2026-10-11T16:48:00+07:00', 'pitch', 'warn', 'Pitch mendekati batas (7.6°)', 'Stabil dalam 12 detik');
seedIncident('2026-10-13T17:20:00+07:00', 'load', 'danger', 'Beban lebih muatan (2.3 kg)', 'Sirine berbunyi');
seedIncident('2026-10-15T09:05:00+07:00', 'roll', 'warn', 'Roll mendekati batas (8.4°)', 'Notifikasi terkirim');
seedIncident('2026-10-18T14:32:00+07:00', 'pitch', 'danger', 'Pitch melebihi batas (11.2°)', 'Palang otomatis ditutup');

function addIncident(kind, level) {
  const unit = kind === 'load' ? ' kg' : '°';
  const raw = kind === 'load' ? state.load : Math.abs(kind === 'pitch' ? state.pitch : state.roll);
  const v = raw.toFixed(1) + unit;
  const name = kind === 'pitch' ? 'Pitch' : kind === 'roll' ? 'Roll' : 'Beban';
  let text;
  if (kind === 'load') text = level === 'danger' ? `Beban lebih muatan (${v})` : `Beban mendekati kapasitas (${v})`;
  else text = level === 'danger' ? `${name} melebihi batas (${v})` : `${name} mendekati batas (${v})`;
  const note =
    level === 'danger'
      ? state.servo.closed && state.servo.reason === 'auto'
        ? 'Palang otomatis ditutup'
        : 'Alarm diaktifkan'
      : 'Notifikasi terkirim';
  const id = nextIncidentId++;
  incidents.unshift({ id, time: new Date().toISOString(), kind, level, text, note });
  if (incidents.length > 200) incidents.pop();
  dbRun('INSERT INTO incidents (id, ts, kind, level, text, note) VALUES (?,?,?,?,?,?)', [id, new Date(), kind, level, text, note]);
}

/* ------------------------------ Logika status ---------------------------- */
const levelAngle = (v) => {
  v = Math.abs(v);
  return v >= settings.danger ? 'danger' : v >= settings.warn ? 'warn' : 'safe';
};
const levelLoad = (l) => (l > settings.maxLoad ? 'danger' : l >= settings.maxLoad * 0.8 ? 'warn' : 'safe');

function closeServo(reason) {
  state.servo.closed = true;
  state.servo.angle = CLOSED_ANGLE;
  state.servo.reason = reason;
}
function openServo() {
  state.servo.closed = false;
  state.servo.angle = OPEN_ANGLE;
  state.servo.reason = null;
}

function currentLevels() {
  const levels = { pitch: levelAngle(state.pitch), roll: levelAngle(state.roll), load: levelLoad(state.load) };
  const overall = Object.values(levels).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'safe');
  return { levels, overall };
}

function evaluate() {
  const { levels, overall } = currentLevels();

  // Proteksi aktif: tutup palang saat bahaya
  if (overall === 'danger' && state.servo.auto && !state.servo.closed) closeServo('auto');

  // Catat insiden saat level naik
  for (const k of ['pitch', 'roll', 'load']) {
    if (RANK[levels[k]] > RANK[prevLevels[k]]) addIncident(k, levels[k]);
    prevLevels[k] = levels[k];
  }

  // Palang TIDAK pernah dibuka otomatis. Pembukaan hanya lewat tombol di dashboard
  // (POST /api/servo {action:"open"}) dan, pada mode otomatis, hanya saat status Aman.
}

/* -------------------------------- Simulator ------------------------------ */
const rnd = () => Math.random() - 0.5;
function simulate() {
  const t = SCENARIOS[state.scenario] || SCENARIOS.normal;
  const wander = state.scenario === 'normal' ? 0.8 * Math.sin(Date.now() / 60000) : 0;
  state.pitch = Math.max(0, state.pitch + (t.pitch + wander - state.pitch) * 0.08 + rnd() * 0.25);
  state.roll = Math.max(0, state.roll + (t.roll + wander * 0.6 - state.roll) * 0.08 + rnd() * 0.25);
  state.load = Math.max(0, state.load + (t.load - state.load) * 0.1 + rnd() * 0.02);
  state.rssi = Math.round(-52 + rnd() * 6);
}

const deviceOnline = () => Date.now() - state.lastTelemetry < 10000;

/* -------------------------------- Snapshot ------------------------------- */
const r1 = (n) => Math.round(n * 10) / 10;

// LED RGB tunggal: warna mengikuti status (kuning = merah + hijau)
const LED = {
  safe: { color: 'green', rgb: [0, 255, 0] },
  warn: { color: 'yellow', rgb: [255, 180, 0] },
  danger: { color: 'red', rgb: [255, 0, 0] },
};

function snapshot() {
  const { levels, overall } = currentLevels();
  const max = settings.maxLoad;
  return {
    time: Date.now(),
    pitch: r1(state.pitch),
    roll: r1(state.roll),
    load: r1(state.load),
    levels,
    status: overall,
    led: LED[overall],
    buzzer: overall === 'danger',
    loadPct: Math.round((state.load / max) * 100),
    tolerance: r1(Math.max(0, max - state.load)),
    servo: { ...state.servo },
    settings: { ...settings },
    scenario: state.scenario,
    telemetry: {
      rssi: state.rssi,
      source: deviceOnline() ? 'device' : 'simulator',
      hz: 1,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    lastIncidentId: incidents.length ? incidents[0].id : 0,
    incidentCount: incidents.length,
  };
}

function getHistory(range) {
  const now = Date.now();
  const span = range === '24h' ? 24 * 3600 * 1000 : 3600 * 1000;
  let pts = history.filter((h) => h.t >= now - span);
  const bin = Math.ceil(pts.length / 144);
  if (bin > 1) {
    const out = [];
    for (let i = 0; i < pts.length; i += bin) {
      const g = pts.slice(i, i + bin);
      out.push({
        t: g[Math.floor(g.length / 2)].t,
        p: +(g.reduce((a, b) => a + b.p, 0) / g.length).toFixed(2),
        r: +(g.reduce((a, b) => a + b.r, 0) / g.length).toFixed(2),
      });
    }
    pts = out;
  }
  pts.push({ t: now, p: +Math.abs(state.pitch).toFixed(2), r: +Math.abs(state.roll).toFixed(2) });
  return { range, from: now - span, to: now, points: pts };
}

/* ------------------------------------ SSE -------------------------------- */
const clients = new Set();
function broadcast() {
  if (!clients.size) return;
  const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

/* ------------------------------------ Tick ------------------------------- */
setInterval(() => {
  if (!deviceOnline()) simulate();
  evaluate();
  if (Date.now() - lastHistoryAt >= INTERVAL) {
    lastHistoryAt = Date.now();
    history.push({ t: lastHistoryAt, p: +Math.abs(state.pitch).toFixed(2), r: +Math.abs(state.roll).toFixed(2) });
    while (history.length > KEEP) history.shift();
    // Simpan ke database hanya saat ESP32 benar-benar online (data simulator tidak ikut)
    if (deviceOnline()) {
      dbRun('INSERT INTO readings (ts, pitch, roll, load_kg) VALUES (?,?,?,?)', [
        new Date(), state.pitch, state.roll, state.load,
      ]);
    }
  }
  broadcast();
}, 1000);

/* ------------------------------------ HTTP ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) {
        reject(new Error('Body terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Tidak ditemukan');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, snapshot());

  if (pathname === '/api/history' && method === 'GET') {
    return sendJson(res, 200, getHistory(url.searchParams.get('range') === '24h' ? '24h' : '1h'));
  }

  if (pathname === '/api/incidents' && method === 'GET') {
    return sendJson(res, 200, { total: incidents.length, items: incidents.slice(0, 50) });
  }

  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(res, 200, settings);
    if (method === 'PUT') {
      const b = await readJson(req);
      const next = {
        warn: Number(b.warn ?? settings.warn),
        danger: Number(b.danger ?? settings.danger),
        maxLoad: Number(b.maxLoad ?? settings.maxLoad),
      };
      const v = validateSettings(next);
      if (!v.ok) return sendJson(res, 400, { error: v.error });
      settings = next;
      saveSettings();
      evaluate();
      broadcast();
      return sendJson(res, 200, settings);
    }
  }

  if (pathname === '/api/servo' && method === 'POST') {
    const b = await readJson(req);
    if (b.auto !== undefined) {
      if (typeof b.auto !== 'boolean') return sendJson(res, 400, { error: 'auto harus boolean' });
      state.servo.auto = b.auto;
    }
    if (b.action === 'close') closeServo('manual');
    else if (b.action === 'open') {
      if (state.servo.auto && currentLevels().overall !== 'safe') {
        return sendJson(res, 409, { error: 'Mode otomatis: palang hanya bisa dibuka saat status Aman' });
      }
      openServo();
    } else if (b.action !== undefined) return sendJson(res, 400, { error: 'action harus "open" atau "close"' });
    evaluate();
    broadcast();
    return sendJson(res, 200, state.servo);
  }

  if (pathname === '/api/simulate' && method === 'POST') {
    const b = await readJson(req);
    if (!SCENARIOS[b.scenario]) return sendJson(res, 400, { error: 'scenario: normal | warn | danger' });
    state.scenario = b.scenario;
    return sendJson(res, 200, { scenario: state.scenario });
  }

  // Endpoint untuk ESP32: kirim telemetri, terima perintah servo
  if (pathname === '/api/telemetry' && method === 'POST') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return sendJson(res, 401, { error: 'API key salah' });
    const b = await readJson(req);
    const pitch = Number(b.pitch);
    const roll = Number(b.roll);
    if (!Number.isFinite(pitch) || !Number.isFinite(roll) || Math.abs(pitch) > 90 || Math.abs(roll) > 90) {
      return sendJson(res, 400, { error: 'pitch dan roll wajib angka (-90..90)' });
    }
    state.pitch = pitch;
    state.roll = roll;
    if (b.load !== undefined) {
      const load = Number(b.load);
      if (!Number.isFinite(load) || load < 0 || load > 50) return sendJson(res, 400, { error: 'load tidak valid (0..50 kg)' });
      state.load = load;
    }
    if (Number.isFinite(Number(b.rssi))) state.rssi = Math.round(Number(b.rssi));
    state.lastTelemetry = Date.now();
    // ESP32 baru menyala -> palangnya fisik tertutup, samakan state server
    if (b.boot === true) closeServo('auto');
    evaluate();
    broadcast();
    const s = snapshot();
    return sendJson(res, 200, {
      ok: true,
      status: s.status,
      alarm: s.status === 'danger',
      led: s.led,
      servo: { command: state.servo.closed ? 'close' : 'open', angle: state.servo.angle, auto: state.servo.auto },
      settings: { warn: settings.warn, danger: settings.danger, maxLoad: settings.maxLoad },
    });
  }

  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e.message || 'Request gagal' });
    else res.end();
  }
});

initDb();

server.listen(PORT, () => {
  console.log(`Smart Shelf dashboard berjalan di http://localhost:${PORT}`);
  if (API_KEY) console.log('POST /api/telemetry dilindungi API key (header x-api-key).');
});

process.on('SIGINT', () => {
  server.close();
  if (pool) pool.end();
  process.exit(0);
});