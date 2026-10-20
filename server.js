const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// ── Habit board ─────────────────────────────────────────────────────────────
// Two tables, both private to this app's group: a habit and the days it was
// done. Schema is applied idempotently on every boot.

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS habits (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS habits_user_demo_key_uniq
      ON habits (user_id, demo_key);
    COMMENT ON TABLE habits IS 'staging:private';
    CREATE TABLE IF NOT EXISTS habit_days (
      habit_id integer NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      day date NOT NULL,
      PRIMARY KEY (habit_id, day)
    );
    COMMENT ON TABLE habit_days IS 'staging:private';
  `);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A calendar day as a UTC-midnight Date, or null when it is not a real date.
function parseDay(raw) {
  const m = DAY_RE.exec(raw || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    return null;
  }
  return d;
}

function dayString(d) {
  return d.toISOString().slice(0, 10);
}

function shiftDay(day, delta) {
  return dayString(new Date(parseDay(day).getTime() + delta * 86400000));
}

// The viewer's own day, sent by the page as their device's local date. It is
// accepted only within one day of this request's UTC date, so a wrong or
// stale value cannot mark some other day. Never CURRENT_DATE / NOW().
function requestDay(req) {
  const now = req.now || new Date();
  const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const raw = typeof req.query.today === 'string' ? req.query.today : '';
  if (!raw) return dayString(new Date(utcToday));
  const parsed = parseDay(raw);
  if (!parsed || Math.abs(parsed.getTime() - utcToday) > 86400000) return null;
  return raw;
}

// The Monday of the week `day` falls in, as YYYY-MM-DD. The viewer's own
// calendar week, worked out from the day the page sent (their local date),
// never from NOW() or CURRENT_DATE.
function weekStart(day) {
  const dow = parseDay(day).getUTCDay(); // 0 = Sunday
  return shiftDay(day, -((dow + 6) % 7));
}

// How many times this board's habits were marked from Monday through `day`:
// the weekly line above the list. Scoped to the same habits the board shows
// (`demo` picks demo rows or the account's own), so it never counts another
// board's days.
async function weekSummary(userId, demo, day) {
  const start = weekStart(day);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS completed
     FROM habit_days d
     JOIN habits h ON h.id = d.habit_id
     WHERE h.user_id = $1 AND h.is_demo = $2
       AND d.day BETWEEN $3::date AND $4::date`,
    [userId, demo, start, day]
  );
  return { start, completed: rows[0].completed };
}

// The run of consecutive marked days ending at `day` when today is marked,
// else ending yesterday, else 0.
function streakOf(days, day, doneToday) {
  let cursor = doneToday ? day : shiftDay(day, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

async function habitsFor(userId, demo, day) {
  const { rows } = await pool.query(
    `SELECT id, name FROM habits
     WHERE user_id = $1 AND is_demo = $2
     ORDER BY created_at, id`,
    [userId, demo]
  );
  if (!rows.length) return [];
  const { rows: dayRows } = await pool.query(
    `SELECT habit_id, to_char(day, 'YYYY-MM-DD') AS day
     FROM habit_days WHERE habit_id = ANY($1::int[])`,
    [rows.map((r) => r.id)]
  );
  const byHabit = new Map();
  for (const r of dayRows) {
    if (!byHabit.has(r.habit_id)) byHabit.set(r.habit_id, new Set());
    byHabit.get(r.habit_id).add(r.day);
  }
  return rows.map((h) => {
    const days = byHabit.get(h.id) || new Set();
    const doneToday = days.has(day);
    return { id: h.id, name: h.name, doneToday, streak: streakOf(days, day, doneToday) };
  });
}

async function habitFor(userId, id, day) {
  const { rows } = await pool.query(
    `SELECT id, name, is_demo FROM habits WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (!rows.length) return null;
  const { rows: dayRows } = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM habit_days WHERE habit_id = $1`,
    [id]
  );
  const days = new Set(dayRows.map((r) => r.day));
  const doneToday = days.has(day);
  return {
    id: rows[0].id,
    name: rows[0].name,
    is_demo: rows[0].is_demo,
    doneToday,
    streak: streakOf(days, day, doneToday),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The `?demo=1` populated board: the viewer's own nine habits, written once
// for the viewing account, days relative to that request's today. Later
// reloads change nothing and whatever the viewer did to them stays.
const DEMO_HABITS = [
  ['read-20-pages', 'Read 20 pages', 9, false],
  ['stretch-10-minutes', 'Stretch for 10 minutes', 3, false],
  ['write-journal', 'Write in journal', 0, false],
  ['meditate-5-minutes', 'Meditate 5 minutes', 15, false],
  ['water-plants', 'Water the plants', 4, false],
  ['drink-2-litres', 'Drink 2 litres of water', 6, true],
  ['practise-guitar', 'Practise guitar', 2, true],
  ['no-phone-10pm', 'No phone after 10pm', 12, true],
  ['walk-after-lunch', 'Walk after lunch', 1, true],
];

async function writeDemo(userId, day) {
  for (const [key, name, streak, doneToday] of DEMO_HABITS) {
    const inserted = await pool.query(
      `INSERT INTO habits (user_id, name, is_demo, demo_key)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (user_id, demo_key) DO NOTHING
       RETURNING id`,
      [userId, name, key]
    );
    if (!inserted.rows.length) continue;
    const id = inserted.rows[0].id;
    const days = [];
    const end = doneToday ? 0 : -1;
    for (let i = 0; i < streak; i++) days.push(shiftDay(day, end - i));
    if (days.length) {
      await pool.query(
        `INSERT INTO habit_days (habit_id, day)
         SELECT $1::int, d::date FROM unnest($2::text[]) AS d
         ON CONFLICT DO NOTHING`,
        [id, days]
      );
    }
  }
}

function wantsDemo(req) {
  return req.query.demo === '1';
}

app.get('/api/habits', wrap(async (req, res) => {
  if (!req.user) return res.json({ habits: [] });
  const day = requestDay(req);
  if (!day) return res.status(400).json({ error: 'invalid_today' });
  const demo = wantsDemo(req);
  if (demo && IS_STAGING) await writeDemo(req.user.id, day);
  return res.json({
    habits: await habitsFor(req.user.id, demo, day),
    week: await weekSummary(req.user.id, demo, day),
  });
}));

app.post('/api/habits', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const raw = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (raw.length < 1 || raw.length > 60) return res.status(400).json({ error: 'invalid_name' });
  const demo = wantsDemo(req) && IS_STAGING;
  const { rows } = await pool.query(
    `INSERT INTO habits (user_id, name, is_demo) VALUES ($1, $2, $3) RETURNING id, name`,
    [req.user.id, raw, demo]
  );
  return res.status(201).json({ id: rows[0].id, name: rows[0].name, doneToday: false, streak: 0 });
}));

app.delete('/api/habits/:id', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  // The week figure is for the line above the list; a missing day only means
  // this request did not ask about one, so fall back to the request's UTC date.
  const day = requestDay(req) || dayString(req.now);
  const { rows } = await pool.query(
    `DELETE FROM habits WHERE id = $1 AND user_id = $2 RETURNING is_demo`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true, week: await weekSummary(req.user.id, rows[0].is_demo, day) });
}));

app.put('/api/habits/:id/days/:day', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  const day = requestDay(req);
  if (!day) return res.status(400).json({ error: 'invalid_today' });
  if (req.params.day !== day) return res.status(400).json({ error: 'invalid_day' });
  const owned = await pool.query(
    `SELECT id FROM habits WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!owned.rows.length) return res.status(404).json({ error: 'not_found' });
  await pool.query(
    `INSERT INTO habit_days (habit_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [req.params.id, day]
  );
  const updated = await habitFor(req.user.id, req.params.id, day);
  return res.json({ ...updated, week: await weekSummary(req.user.id, updated.is_demo, day) });
}));

app.delete('/api/habits/:id/days/:day', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  const day = requestDay(req);
  if (!day) return res.status(400).json({ error: 'invalid_today' });
  if (req.params.day !== day) return res.status(400).json({ error: 'invalid_day' });
  const owned = await pool.query(
    `SELECT id FROM habits WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!owned.rows.length) return res.status(404).json({ error: 'not_found' });
  await pool.query(
    `DELETE FROM habit_days WHERE habit_id = $1 AND day = $2::date`,
    [req.params.id, day]
  );
  const updated = await habitFor(req.user.id, req.params.id, day);
  return res.json({ ...updated, week: await weekSummary(req.user.id, updated.is_demo, day) });
}));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/streak-habit-board-21ca6c/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/streak-habit-board-21ca6c/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// A failed route answers JSON, so the page can tell it apart from an answer.
app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).send('Something went wrong.');
});

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting connections, drain for a few seconds, close the pool.
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, shutting down`);
    server.close(async () => {
      try { await pool.end(); } catch (err) { console.error(err); }
      process.exit(0);
    });
    setTimeout(async () => {
      try { await pool.end(); } catch (err) { console.error(err); }
      process.exit(0);
    }, 3000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
