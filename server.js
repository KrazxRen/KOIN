const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto');
const db = new Database(process.env.DB_PATH || 'koin.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, pid TEXT UNIQUE, hash TEXT, salt TEXT, balance INTEGER DEFAULT 0, last_earn TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS tx(id INTEGER PRIMARY KEY, sender INTEGER, receiver INTEGER, amount INTEGER, at INTEGER);
CREATE INDEX IF NOT EXISTS tx_s ON tx(sender); CREATE INDEX IF NOT EXISTS tx_r ON tx(receiver);
CREATE INDEX IF NOT EXISTS ses_u ON sessions(user_id);`);

// Balances are stored as integer hundredths (2.50 KOINS = 250) so there are no float errors.
const TZ = +(process.env.TZ_OFFSET_MIN || 330); // daily reset at local midnight (330 = India)
const today = () => new Date(Date.now() + TZ * 6e4).toISOString().slice(0, 10);
const rid = n => crypto.randomBytes(n).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (p, s) => crypto.scryptSync(p, s, 32);
const checkPw = (u, p) => crypto.timingSafeEqual(hashPw(String(p || ''), u.salt), Buffer.from(u.hash, 'hex'));
const stm = new Map(); const P = s => stm.get(s) || (stm.set(s, db.prepare(s)), stm.get(s));
const err = (r, m, c = 400) => r.status(c).json({ error: m });
const USER = /^[a-z0-9._]{3,20}$/i, PWOK = p => typeof p === 'string' && p.length >= 6 && p.length <= 100;

const hits = new Map(); // tiny in-memory rate limiter
const count = (k, ms) => (hits.get(k) || []).filter(t => Date.now() - t < ms).length;
const hit = k => hits.set(k, [...(hits.get(k) || []), Date.now()].slice(-50));
setInterval(() => hits.clear(), 36e5).unref();
setInterval(() => P('DELETE FROM sessions WHERE expires<?').run(Date.now()), 36e5).unref();

function session(uid, remember) {
  const t = rid(32);
  P('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), uid, Date.now() + (remember ? 90 : 1) * 864e5);
  return t;
}
const auth = (q, r, n) => {
  const t = (q.headers.authorization || '').slice(7);
  const u = t && P('SELECT u.*, s.token AS st FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(sha(t), Date.now());
  if (!u) return err(r, 'Session expired', 401);
  q.u = u; n();
};
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

app.post('/api/signup', (q, r) => {
  const k = 's' + q.ip; if (count(k, 36e5) >= 10) return err(r, 'Too many sign-ups, try later', 429);
  const { username, password, remember } = q.body;
  if (!USER.test(username || '')) return err(r, 'Username: 3-20 letters, numbers, . or _');
  if (!PWOK(password)) return err(r, 'Password must be 6-100 characters');
  const salt = rid(16);
  try {
    const x = P('INSERT INTO users(username,pid,hash,salt) VALUES(?,?,?,?)').run(username, rid(9), hashPw(password, salt).toString('hex'), salt);
    hit(k); r.json({ token: session(x.lastInsertRowid, remember) });
  } catch { err(r, 'Username already taken'); }
});

app.post('/api/login', (q, r) => {
  const k = 'l' + q.ip; if (count(k, 9e5) >= 15) return err(r, 'Too many attempts, try later', 429);
  const { username, password, remember } = q.body;
  const u = P('SELECT * FROM users WHERE username=?').get(String(username || ''));
  if (!u || !checkPw(u, password)) { hit(k); return err(r, 'Wrong username or password'); }
  r.json({ token: session(u.id, remember) });
});

app.post('/api/logout', auth, (q, r) => { P('DELETE FROM sessions WHERE token=?').run(q.u.st); r.json({ ok: true }); });

app.get('/api/me', auth, (q, r) => r.json({ username: q.u.username, pid: q.u.pid, balance: q.u.balance, earned: q.u.last_earn === today() }));

app.post('/api/earn', auth, (q, r) => {
  const reward = db.transaction(() => {
    if (P('SELECT last_earn FROM users WHERE id=?').get(q.u.id).last_earn === today()) return 0;
    const c = crypto.randomInt(100, 1001); // 1.00 - 10.00
    P('UPDATE users SET balance=balance+?, last_earn=? WHERE id=?').run(c, today(), q.u.id);
    return c;
  })();
  reward ? r.json({ reward }) : err(r, 'Already earned today, come back tomorrow');
});

app.get('/api/lookup', auth, (q, r) => {
  const u = P('SELECT username FROM users WHERE pid=?').get(String(q.query.pid || ''));
  u ? r.json(u) : err(r, 'Unknown KOIN code', 404);
});

app.post('/api/send', auth, (q, r) => {
  const { pid, amount, password } = q.body;
  if (!pwOk(q, r, password)) return;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(amount))) return err(r, 'Enter a valid amount, e.g. 2.00');
  const c = Math.round(parseFloat(amount) * 100);
  if (c < 1) return err(r, 'Amount too small');
  const to = P('SELECT id FROM users WHERE pid=?').get(String(pid));
  if (!to) return err(r, 'Unknown receiver');
  if (to.id === q.u.id) return err(r, "You can't send KOINS to yourself");
  const ok = db.transaction(() => {
    if (!P('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(c, q.u.id, c).changes) return false;
    P('UPDATE users SET balance=balance+? WHERE id=?').run(c, to.id);
    P('INSERT INTO tx(sender,receiver,amount,at) VALUES(?,?,?,?)').run(q.u.id, to.id, c, Date.now());
    return true;
  })();
  ok ? r.json({ ok: true }) : err(r, 'Not enough KOINS');
});

app.get('/api/history', auth, (q, r) => r.json(P(`
  SELECT t.amount, t.at, (t.sender=?1) AS sent, u.username AS who FROM tx t
  JOIN users u ON u.id = CASE WHEN t.sender=?1 THEN t.receiver ELSE t.sender END
  WHERE t.sender=?1 OR t.receiver=?1 ORDER BY t.at DESC, t.id DESC LIMIT 200`).all(q.u.id)));

app.post('/api/username', auth, (q, r) => {
  if (!pwOk(q, r, q.body.password)) return;
  if (!USER.test(q.body.username || '')) return err(r, 'Username: 3-20 letters, numbers, . or _');
  try { P('UPDATE users SET username=? WHERE id=?').run(q.body.username, q.u.id); r.json({ ok: true }); }
  catch { err(r, 'Username already taken'); }
});

app.post('/api/password', auth, (q, r) => {
  if (!pwOk(q, r, q.body.password)) return;
  if (!PWOK(q.body.newPassword)) return err(r, 'Password must be 6-100 characters');
  const salt = rid(16);
  P('UPDATE users SET hash=?, salt=? WHERE id=?').run(hashPw(q.body.newPassword, salt).toString('hex'), salt, q.u.id);
  P('DELETE FROM sessions WHERE user_id=? AND token!=?').run(q.u.id, q.u.st); // log out other devices
  r.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('KOIN running'));
