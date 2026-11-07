const express = require('express'), crypto = require('crypto'), { Pool, types } = require('pg');
types.setTypeParser(20, Number); // Postgres BIGINT -> JS number
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('Set the DATABASE_URL environment variable'); process.exit(1); }
const pool = new Pool({
  connectionString: DB_URL, max: 5, connectionTimeoutMillis: 15000,
  ssl: /sslmode=|localhost|127\.0\.0\.1/.test(DB_URL) ? undefined : { rejectUnauthorized: false }
});
pool.on('error', e => console.error('idle db error', e.message)); // don't crash when the DB drops an idle connection

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, username TEXT NOT NULL, pid TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, salt TEXT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0), last_earn TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users(lower(username));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INT NOT NULL, expires BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS ses_u ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tx(id SERIAL PRIMARY KEY, sender INT NOT NULL, receiver INT NOT NULL, amount BIGINT NOT NULL, ts BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS tx_s ON tx(sender); CREATE INDEX IF NOT EXISTS tx_r ON tx(receiver);`;

// Balances are stored as integer hundredths (2.50 KOINS = 250): no float errors.
const TZ = +(process.env.TZ_OFFSET_MIN || 330); // daily reset at local midnight (330 = India)
const today = () => new Date(Date.now() + TZ * 6e4).toISOString().slice(0, 10);
const rid = n => crypto.randomBytes(n).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (p, s) => crypto.scryptSync(p, s, 32);
const checkPw = (u, p) => crypto.timingSafeEqual(hashPw(String(p || ''), u.salt), Buffer.from(u.hash, 'hex'));
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const err = (r, m, c = 400) => r.status(c).json({ error: m });
const h = f => (q, r, n) => Promise.resolve(f(q, r, n)).catch(e => { console.error(e); if (!r.headersSent) err(r, 'Server error, please try again', 500); });
const USER = /^[a-z0-9._]{3,20}$/i, PWOK = p => typeof p === 'string' && p.length >= 6 && p.length <= 100;

async function withTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

const hits = new Map(); // tiny in-memory rate limiter
const count = (k, ms) => (hits.get(k) || []).filter(t => Date.now() - t < ms).length;
const hit = k => hits.set(k, [...(hits.get(k) || []), Date.now()].slice(-50));
setInterval(() => hits.clear(), 36e5).unref();
setInterval(() => pool.query('DELETE FROM sessions WHERE expires<$1', [Date.now()]).catch(() => {}), 36e5).unref();

async function session(uid, remember) {
  const t = rid(32);
  await pool.query('INSERT INTO sessions VALUES($1,$2,$3)', [sha(t), uid, Date.now() + (remember ? 90 : 1) * 864e5]);
  return t;
}
const auth = h(async (q, r, n) => {
  const t = (q.headers.authorization || '').slice(7);
  const u = t && await one('SELECT u.*, s.token AS st FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>$2', [sha(t), Date.now()]);
  if (!u) return err(r, 'Session expired', 401);
  q.u = u; n();
});
function pwOk(q, r, p) { // checks the user's password; locks out repeated failures
  const k = 'p' + q.u.id;
  if (count(k, 9e5) >= 8) { err(r, 'Too many wrong passwords, try again later', 429); return false; }
  if (checkPw(q.u, p)) return true;
  hit(k); err(r, 'Wrong password'); return false;
}

const app = express();
app.disable('x-powered-by'); app.set('trust proxy', 1);
app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }); n(); });
app.use(express.json({ limit: '2kb' }));
app.use(express.static('public'));
app.get('/healthz', (q, r) => r.send('ok'));

app.post('/api/signup', h(async (q, r) => {
  const k = 's' + q.ip; if (count(k, 36e5) >= 10) return err(r, 'Too many sign-ups, try later', 429);
  const { username, password, remember } = q.body;
  if (!USER.test(username || '')) return err(r, 'Username: 3-20 letters, numbers, . or _');
  if (!PWOK(password)) return err(r, 'Password must be 6-100 characters');
  const salt = rid(16);
  try {
    const x = await one('INSERT INTO users(username,pid,hash,salt) VALUES($1,$2,$3,$4) RETURNING id', [username, rid(9), hashPw(password, salt).toString('hex'), salt]);
    hit(k); r.json({ token: await session(x.id, remember) });
  } catch (e) { if (e.code === '23505') return err(r, 'Username already taken'); throw e; }
}));

app.post('/api/login', h(async (q, r) => {
  const k = 'l' + q.ip; if (count(k, 9e5) >= 15) return err(r, 'Too many attempts, try later', 429);
  const { username, password, remember } = q.body;
  const u = await one('SELECT * FROM users WHERE lower(username)=lower($1)', [String(username || '')]);
  if (!u || !checkPw(u, password)) { hit(k); return err(r, 'Wrong username or password'); }
  r.json({ token: await session(u.id, remember) });
}));

app.post('/api/logout', auth, h(async (q, r) => { await pool.query('DELETE FROM sessions WHERE token=$1', [q.u.st]); r.json({ ok: true }); }));

app.get('/api/me', auth, (q, r) => r.json({ username: q.u.username, pid: q.u.pid, balance: q.u.balance, earned: q.u.last_earn === today() }));

app.post('/api/earn', auth, h(async (q, r) => {
  const c = crypto.randomInt(100, 1001); // 1.00 - 10.00
  // one atomic statement: can only succeed once per day, even with double-taps
  const x = await pool.query('UPDATE users SET balance=balance+$1, last_earn=$2 WHERE id=$3 AND last_earn IS DISTINCT FROM $2', [c, today(), q.u.id]);
  x.rowCount ? r.json({ reward: c }) : err(r, 'Already earned today, come back tomorrow');
}));

app.get('/api/lookup', auth, h(async (q, r) => {
  const u = await one('SELECT username FROM users WHERE pid=$1', [String(q.query.pid || '')]);
  u ? r.json(u) : err(r, 'Unknown KOIN code', 404);
}));

app.post('/api/send', auth, h(async (q, r) => {
  const { pid, amount, password } = q.body;
  if (!pwOk(q, r, password)) return;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(amount))) return err(r, 'Enter a valid amount, e.g. 2.00');
  const c = Math.round(parseFloat(amount) * 100);
  if (c < 1) return err(r, 'Amount too small');
  const to = await one('SELECT id FROM users WHERE pid=$1', [String(pid)]);
  if (!to) return err(r, 'Unknown receiver');
  if (to.id === q.u.id) return err(r, "You can't send KOINS to yourself");
  const ok = await withTx(async cl => {
    await cl.query('SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [q.u.id, to.id]); // fixed lock order = no deadlocks
    const d = await cl.query('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1', [c, q.u.id]);
    if (!d.rowCount) return false;
    await cl.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [c, to.id]);
    await cl.query('INSERT INTO tx(sender,receiver,amount,ts) VALUES($1,$2,$3,$4)', [q.u.id, to.id, c, Date.now()]);
    return true;
  });
  ok ? r.json({ ok: true }) : err(r, 'Not enough KOINS');
}));

app.get('/api/history', auth, h(async (q, r) => {
  const x = await pool.query(`
    SELECT t.amount, t.ts AS "at", (t.sender=$1) AS sent, u.username AS who FROM tx t
    JOIN users u ON u.id = CASE WHEN t.sender=$1 THEN t.receiver ELSE t.sender END
    WHERE t.sender=$1 OR t.receiver=$1 ORDER BY t.ts DESC, t.id DESC LIMIT 200`, [q.u.id]);
  r.json(x.rows);
}));

app.post('/api/username', auth, h(async (q, r) => {
  if (!pwOk(q, r, q.body.password)) return;
  if (!USER.test(q.body.username || '')) return err(r, 'Username: 3-20 letters, numbers, . or _');
  try { await pool.query('UPDATE users SET username=$1 WHERE id=$2', [q.body.username, q.u.id]); r.json({ ok: true }); }
  catch (e) { if (e.code === '23505') return err(r, 'Username already taken'); throw e; }
}));

app.post('/api/password', auth, h(async (q, r) => {
  if (!pwOk(q, r, q.body.password)) return;
  if (!PWOK(q.body.newPassword)) return err(r, 'Password must be 6-100 characters');
  const salt = rid(16);
  await pool.query('UPDATE users SET hash=$1, salt=$2 WHERE id=$3', [hashPw(q.body.newPassword, salt).toString('hex'), salt, q.u.id]);
  await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [q.u.id, q.u.st]); // log out other devices
  r.json({ ok: true });
}));

pool.query(SCHEMA)
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('KOIN running')))
  .catch(e => { console.error('Database error:', e.message); process.exit(1); });
