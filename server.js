'use strict';

const { createServer } = require('node:http');
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { mkdirSync, readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const hashPassword = promisify(scrypt);
const roles = { member: 'Участник', specialist: 'Специалист', moderator: 'Модератор', owner: 'Владелец' };
const editors = ['moderator', 'owner'];
const staff = ['specialist', ...editors];
const ranks = ['Искра', 'Инфракрасный', 'Люминофор', 'Лазер', 'Ультрафиолет', 'Спектр'];
const difficulties = ['easy', 'medium', 'hard'];
const categories = ['merch', 'perk', 'partner'];
const reactions = ['yes', 'maybe', 'cannot', 'not-interested'];
const day = 86400000;
const demo = process.env.SPEKTR_DEMO === '1';
const file = resolve(process.env.SPEKTR_DB || (demo ? 'data/demo.sqlite' : 'data/spektr.sqlite'));
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS records (
    type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(type,id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, content BLOB NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS mutations (actor TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY(actor,key)) STRICT;
  CREATE TABLE IF NOT EXISTS revision (value INTEGER NOT NULL) STRICT;
  INSERT INTO revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM revision);
`);
const query = {
  get: db.prepare('SELECT data FROM records WHERE type=? AND id=?'),
  all: db.prepare('SELECT data FROM records WHERE type=?'),
  put: db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)'),
  delete: db.prepare('DELETE FROM records WHERE type=? AND id=?'),
  revision: db.prepare('SELECT value FROM revision'),
  bump: db.prepare('UPDATE revision SET value=value+1'),
};
const get = (type, id) => JSON.parse(query.get.get(type, String(id))?.data || 'null');
const all = type => query.all.all(type).map(row => JSON.parse(row.data));
const put = (type, entry) => {
  query.put.run(type, entry.id, JSON.stringify(entry));
  return entry;
};
const now = () => new Date().toISOString();
const make = fields => ({ id: randomUUID(), createdAt: now(), ...fields });
const revision = () => query.revision.get().value;

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assert(valid, message, status = 400) {
  if (!valid) throw new InputError(status, message);
}

function access(user, allowed) {
  assert(user, 'Войдите в аккаунт.', 401);
  assert(allowed.includes(user.role), 'У вашей роли нет доступа к этому действию.', 403);
}

function tx(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    query.bump.run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function field(value, label, limit = 160, required = true) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  assert((!required || cleaned) && cleaned.length <= limit, `Проверьте поле «${label}».`);
  return cleaned;
}

function number(value, label, min = 1, max = 100000) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, `Проверьте поле «${label}».`);
  return parsed;
}

function choice(value, options, label) {
  assert(options.includes(value), `Выберите значение в поле «${label}».`);
  return value;
}

function find(type, id) {
  const entry = get(type, id);
  assert(entry, 'Запись не найдена.', 404);
  return entry;
}

function link(value) {
  const text = field(value, 'Ссылка на изображение', 1500, false);
  if (text) {
    try {
      if (new URL(text).protocol !== 'https:') throw new Error();
    } catch {
      throw new InputError(400, 'Укажите полную HTTPS-ссылку.');
    }
  }
  return text;
}

function date(value) {
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value), 'Укажите дату.');
  const parsed = new Date(value);
  assert(!Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value, 'Укажите действительную дату.');
  return value;
}

function email(value) {
  const address = field(value, 'Почта', 254).toLowerCase();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address), 'Проверьте адрес почты.');
  return address;
}

function newProfile({ first, last, role }) {
  return make({ first, last, role, rank: -1, about: '', phone: '', birthday: '', photo: '', title: '',
    balance: 0, earned: 0, counts: { easy: 0, medium: 0, hard: 0 }, lastActive: now(),
    settings: { alerts: true, email: false, theme: 'light' } });
}

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await hashPassword(password, salt, 64)).toString('hex');
}

async function checkPassword(password, record) {
  const [salt, digest] = (record || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
  return timingSafeEqual(await hashPassword(password, salt, 64), Buffer.from(digest, 'hex'));
}

function session(req) {
  const token = (req.headers.cookie || '').match(/(?:^|; )spektr_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token && createHash('sha256').update(token).digest('hex');
}

function current(req) {
  const token = session(req);
  if (!token) return null;
  const row = db.prepare('SELECT accounts.email, sessions.account FROM sessions JOIN accounts ON accounts.id=sessions.account WHERE token=? AND expires>?').get(token, Date.now());
  if (!row) return null;
  const profile = get('users', row.account);
  return profile && { ...profile, email: row.email };
}

function cookie(req, token, age) {
  const secure = req.socket.encrypted || process.env.SPEKTR_HTTPS === '1' ? '; Secure' : '';
  return `spektr_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

function signIn(req, res, id) {
  const raw = randomBytes(32).toString('hex');
  const token = createHash('sha256').update(raw).digest('hex');
  const oldToken = session(req);
  if (oldToken) db.prepare('DELETE FROM sessions WHERE token=?').run(oldToken);
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, id, Date.now() + 14 * day);
  res.setHeader('Set-Cookie', cookie(req, raw, 14 * 86400));
}

function publicUser(user) {
  return { id: user.id, name: [user.first, user.last].filter(Boolean).join(' '), role: user.role,
    photo: user.photo, title: user.title, rank: user.role === 'member' ? user.rank : 5 };
}

function notify(to, text) {
  if (to) put('alerts', make({ to, text, read: false }));
}

function announce(text, except) {
  for (const user of all('users')) if (user.id !== except) notify(user.id, text);
}

function rankFor(user) {
  const config = get('config', 'ranks') || {};
  let rank = user.attended ? Math.max(0, user.rank) : user.rank;
  if (user.attended && config.easy && user.counts.easy >= config.easy) rank = Math.max(rank, 1);
  if (rank >= 1 && config.earned && user.earned >= config.earned) rank = Math.max(rank, 2);
  if (rank >= 2 && config.medium && user.counts.medium >= config.medium) rank = Math.max(rank, 3);
  if (rank >= 3 && config.hard && user.counts.hard >= config.hard) rank = Math.max(rank, 4);
  if (rank >= 4 && (user.mentored || []).length >= 5) rank = 5;
  return rank;
}

function adjust(user, amount, reason, kind, actor, options = {}) {
  assert(user.role === 'member', 'Баланс доступен только участникам.');
  assert(user.balance + amount >= 0, 'Недостаточно Спектр-коинов.', 409);
  user.balance += amount;
  if (amount > 0) {
    user.earned += amount;
    user.lastActive = options.at || now();
    user.burnPeriods = 0;
    user.season = seasonAt(Date.parse(user.lastActive));
  }
  if (options.difficulty) user.counts[options.difficulty] += 1;
  if (options.attended) user.attended = true;
  user.rank = rankFor(user);
  put('users', user);
  put('ledger', make({ userId: user.id, amount, reason, kind, actor, createdAt: options.at || now() }));
  notify(user.id, reason + ' · ' + (amount > 0 ? '+' : '') + amount + ' СК');
}

function seasonAt(timestamp) {
  const local = new Date(timestamp + 7 * 3600000);
  const year = local.getUTCFullYear();
  const reset = Date.UTC(year, 7, 31) - 7 * 3600000;
  return timestamp >= reset ? year : year - 1;
}

function neededBurn(user, timestamp) {
  const idle = timestamp - Date.parse(user.lastActive);
  return idle >= 240 * day ? 6 : idle >= 90 * day ? Math.min(5, 1 + Math.floor((idle - 90 * day) / (30 * day))) : 0;
}

function upkeep() {
  const at = Date.now();
  const season = seasonAt(at);
  const users = all('users').filter(u => u.role === 'member' && u.balance > 0);
  const expired = all('bookings').filter(b => b.status === 'reserved' && b.expires <= at);
  const reset = users.filter(u => seasonAt(Date.parse(u.createdAt)) < season && u.season !== season);
  const fading = users.filter(u => neededBurn(u, at) > (u.burnPeriods || 0));
  if (!expired.length && !reset.length && !fading.length) return;
  tx(() => {
    for (const booking of expired) put('bookings', { ...booking, status: 'expired' });
    for (const user of reset) {
      user.season = season;
      adjust(user, -user.balance, 'Сезонный сброс', 'season', null);
    }
    for (const candidate of fading) {
      const user = get('users', candidate.id);
      const due = neededBurn(user, at);
      for (let bucket = (user.burnPeriods || 0) + 1; bucket <= due && user.balance > 0; bucket++) {
        user.burnPeriods = bucket;
        const amount = bucket === 6 ? user.balance : Math.max(1, Math.floor(user.balance / 5));
        adjust(user, -amount, 'Угасание света', 'burn', null);
      }
    }
  });
}

function activeBooking(booking) {
  return ['reserved', 'confirmed', 'done'].includes(booking.status);
}

function available(task, bookings = all('bookings')) {
  return task.difficulty === 'easy' ? null : Math.max(0, task.capacity -
    bookings.filter(b => b.taskId === task.id && activeBooking(b)).length);
}

function publishEvent(event, actor, news) {
  put('events', { ...event, status: 'published' });
  announce('Новое мероприятие · ' + event.title, actor);
  if (news) put('news', make({ author: actor, title: event.title, description: event.description,
    image: event.image, video: '', eventId: event.id, likes: [], comments: [] }));
}

function state(user) {
  const events = all('events');
  const news = all('news');
  const bookings = all('bookings');
  const tasks = all('tasks');
  const gifts = all('gifts');
  const isEditor = user && editors.includes(user.role);
  const visibleEvents = events.filter(e => e.status === 'published').map(({ rsvp, ...e }) => ({
    ...e, response: rsvp?.[user?.id], attending: Object.values(rsvp || {}).filter(r => r === 'yes').length,
  }));
  const safeNews = news.map(({ likes, ...post }) => ({ ...post, likeCount: likes.length, liked: likes.includes(user?.id) }));
  const result = { revision: revision(), demo, me: user, events: visibleEvents, news: safeNews,
    tasks: [], gifts: [], ranks: get('config', 'ranks') || {}, rankNames: ranks };
  if (!user) return { ...result, tasks: tasks.filter(t => !t.archived).map(t => ({ ...t, available: available(t, bookings) })),
    gifts: gifts.filter(g => !g.archived) };
  const allUsers = all('users');
  const ledger = all('ledger');
  const members = allUsers.filter(u => u.role === 'member');
  const requests = all('requests');
  const messages = all('messages');
  result.people = allUsers.map(publicUser);
  const ownTasks = new Set(bookings.filter(b => b.userId === user.id && activeBooking(b)).map(b => b.taskId));
  result.tasks = tasks.map(t => ({ ...t, available: available(t, bookings) })).filter(t =>
    isEditor || ownTasks.has(t.id) || (!t.archived && t.available !== 0));
  result.gifts = gifts.filter(g => !g.archived || isEditor);
  result.bookings = bookings.filter(b => isEditor || b.userId === user.id);
  result.redemptions = all('redemptions').filter(r => isEditor || r.userId === user.id);
  result.requests = requests.filter(r => r.author === user.id ||
    (r.type === 'role' ? user.role === 'owner' : isEditor));
  result.inReview = events.filter(e => e.status !== 'published' && (isEditor || e.author === user.id));
  result.alerts = all('alerts').filter(a => a.to === user.id).reverse().slice(0, 100);
  result.ledger = ledger.filter(l => l.userId === user.id).reverse().slice(0, 100);
  result.chats = all('chats').filter(c => c.members.includes(user.id)).map(c => ({
    ...c, messages: messages.filter(m => m.chatId === c.id).slice(-100).map(({ media, ...m }) => ({ ...m, media })),
  }));
  if (staff.includes(user.role)) {
    const year = new Date(Date.now() + 7 * 3600000).getUTCFullYear();
    result.stats = {
      people: members.length, beginners: members.filter(u => u.rank < 0).length,
      ranks: ranks.map((_, i) => members.filter(u => u.rank === i).length),
      earned: ledger.filter(l => l.amount > 0 && l.kind !== 'refund' && new Date(Date.parse(l.createdAt) + 7 * 3600000).getUTCFullYear() === year)
        .reduce((sum, l) => sum + l.amount, 0),
      tasks: difficulties.map(d => members.reduce((sum, u) => sum + u.counts[d], 0)),
    };
  }
  if (user.role === 'owner') result.directory = allUsers.map(u => ({
    ...publicUser(u), balance: u.balance, earned: u.earned, counts: u.counts,
  }));
  return result;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  assert(/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''), 'Ожидается JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= 9 * 1024 * 1024, 'Вложение слишком большое.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    assert(value && !Array.isArray(value) && typeof value === 'object', 'Некорректные данные.');
    return value;
  } catch {
    throw new InputError(400, 'Некорректные данные.');
  }
}

const attempts = new Map();
function rateLimit(req) {
  const key = req.socket.remoteAddress;
  const since = Date.now() - 600000;
  for (const [address, value] of attempts) if (value.at < since) attempts.delete(address);
  const attempt = attempts.get(key) || { at: Date.now(), count: 0 };
  assert(attempt.count < 35, 'Слишком много попыток. Попробуйте через 10 минут.', 429);
  attempt.count += 1;
  attempts.set(key, attempt);
}

const addAccount = db.prepare('INSERT INTO accounts VALUES(?,?,?)');
const accountByEmail = db.prepare('SELECT * FROM accounts WHERE email=?');

async function setup() {
  if (process.env.SPEKTR_OWNER_EMAIL && process.env.SPEKTR_OWNER_PASSWORD && !all('users').some(u => u.role === 'owner')) {
    const address = email(process.env.SPEKTR_OWNER_EMAIL);
    const password = process.env.SPEKTR_OWNER_PASSWORD;
    assert(password.length >= 12 && password.length <= 128, 'Пароль владельца должен содержать от 12 до 128 знаков.');
    const digest = await passwordRecord(password);
    tx(() => {
      if (all('users').some(u => u.role === 'owner')) return;
      const owner = put('users', newProfile({ first: 'Команда «Спектра»', last: '', role: 'owner' }));
      addAccount.run(owner.id, address, digest);
    });
  }
  if (!demo || get('config', 'demo')) return;
  const password = await passwordRecord(randomBytes(32).toString('hex'));
  tx(() => {
    if (get('config', 'demo')) return;
    const people = [['Маша', 'Волкова', 'member'], ['Лера', 'Соколова', 'specialist'],
      ['Саша', 'Лисов', 'moderator'], ['Нина', 'Орлова', 'owner']];
    for (const [first, last, role] of people) {
      if (role === 'owner' && all('users').some(u => u.role === 'owner')) continue;
      const user = newProfile({ first, last, role });
      user.id = 'demo-' + role;
      put('users', user);
      addAccount.run(user.id, role + '@demo.spektr.invalid', password);
    }
    const actor = all('users').find(user => user.role === 'owner').id;
    put('config', { id: 'demo' });
    put('config', { id: 'ranks', easy: 3, earned: 240, medium: 3, hard: 2 });
    adjust(get('users', 'demo-member'), 180, 'Активность в пространстве', 'award', actor, { attended: true });
    const place = 'ЦП «Спектр»';
    const future = offset => new Date(Date.now() + offset * day + 7 * 3600000).toISOString().slice(0, 10);
    const sampleEvents = [
      ['Открытая мастерская', 'Собираемся в зелёной комнате. Будем делать яркие зины, коллажи и плакаты.', '16:00', 3, 'ink'],
      ['Вечер настолок', 'Собирай друзей или приходи один. Команда подберёт игру и объяснит правила.', '18:30', 6, 'sun'],
      ['Тренировка по танцам', 'Разучим короткую связку и попробуем импровизацию. Подойдёт новичкам.', '17:00', 11, 'lilac'],
    ];
    for (const [title, description, time, offset, art] of sampleEvents)
      put('events', make({ title, description, time, date: future(offset), place, art, speaker: '',
        image: '', author: actor, status: 'published', rsvp: {} }));
    for (const [title, summary, difficulty, points, capacity] of [
      ['Приходи в «Спектр»', 'Загляни на любое открытое событие и отметься у команды.', 'easy', 20, null],
      ['Помоги на мастерской', 'Подготовь материалы и помоги участникам освоиться.', 'medium', 80, 4],
      ['Проведи своё событие', 'Согласуй идею с командой, собери гостей и проведи встречу.', 'hard', 180, 2],
    ]) put('tasks', make({ title, summary, description: summary, difficulty, points, capacity,
      awarder: 'Команда «Спектра»', author: actor, archived: false, once: false }));
    for (const [title, description, category, price, stock] of [
      ['Значок «Искра»', 'Фирменный значок для рюкзака или куртки.', 'merch', 80, 12],
      ['Кофе от партнёра', 'Сертификат на напиток в кофейне-партнёре.', 'partner', 120, 6],
    ]) put('gifts', make({ title, description, category, price, stock, image: '', author: actor, archived: false }));
    put('news', make({ title: 'Встречаемся в «Спектре»', description: 'Занимайся любимым делом, знакомься с ребятами и собирай Спектр-коины за полезные дела.',
      image: '', video: '', author: actor, likes: [], comments: [] }));
  });
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/hero.webp': ['hero.webp', 'image/webp'],
  '/event-ink.webp': ['event-ink.webp', 'image/webp'],
  '/event-sun.webp': ['event-sun.webp', 'image/webp'],
  '/event-lilac.webp': ['event-lilac.webp', 'image/webp'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.png': ['icon.png', 'image/png'],
  '/icon-large.png': ['icon-large.png', 'image/png'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};
const staticFiles = new Map();

function serveMedia(user, id, res, req) {
  access(user, Object.keys(roles));
  const message = all('messages').find(m => m.media === id);
  assert(message && get('chats', message.chatId)?.members.includes(user.id), 'Файл недоступен.', 404);
  const media = db.prepare('SELECT mime,content FROM media WHERE id=?').get(id);
  assert(media, 'Файл не найден.', 404);
  const buffer = Buffer.from(media.content);
  const headers = { 'Content-Type': media.mime, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' };
  if (req.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    const start = Number(range?.[1]);
    const end = Math.min(range?.[2] ? Number(range[2]) : buffer.length - 1, buffer.length - 1);
    if (!range || start > end || start >= buffer.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buffer.length}`, 'Content-Length': end - start + 1 });
    return res.end(buffer.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': buffer.length });
  res.end(buffer);
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && Object.hasOwn(assets, path)) {
      const [name, mime] = assets[path];
      let asset = staticFiles.get(name);
      if (!asset) {
        let content;
        try { content = readFileSync(resolve(__dirname, name)); } catch (error) {
          if (error.code === 'ENOENT') throw new InputError(404, 'Файл не найден.');
          throw error;
        }
        asset = { content, etag:'"' + createHash('sha256').update(content).digest('hex') + '"' };
        staticFiles.set(name, asset);
      }
      const headers = { 'Content-Type':mime, 'Cache-Control':'no-cache', ETag:asset.etag };
      if (req.headers['if-none-match'] === asset.etag) return res.writeHead(304, headers).end();
      res.writeHead(200, { ...headers, 'Content-Length':asset.content.length });
      return res.end(asset.content);
    }
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/api/revision') return json(res, 200, { revision: revision(), user: current(req)?.id || null });
    if (req.method === 'GET' && path === '/api/state') {
      upkeep();
      return json(res, 200, state(current(req)));
    }
    if (req.method === 'GET' && path.startsWith('/api/media/')) return serveMedia(current(req), path.slice(11), res, req);
    assert(req.method === 'POST' && ['/api/login', '/api/register', '/api/demo', '/api/logout', '/api/action'].includes(path),
      'Страница не найдена.', 404);
    assert(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Запрос с другого сайта отклонён.', 403);
    const body = await readJson(req);
    if (path === '/api/logout') {
      const token = session(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return json(res, 200, { ok: true });
    }
    if (path === '/api/action') {
      upkeep();
      const result = command(current(req), body);
      if (body.action === 'deleteAccount') res.setHeader('Set-Cookie', cookie(req, '', 0));
      return json(res, 200, { ok: true, result });
    }
    rateLimit(req);
    if (path === '/api/demo') {
      assert(demo, 'Демо-режим выключен.', 404);
      const profile = find('users', 'demo-' + choice(body.role, Object.keys(roles), 'Роль'));
      signIn(req, res, profile.id);
      return json(res, 200, { ok: true });
    }
    const address = email(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    assert(password.length <= 128, 'Пароль слишком длинный.');
    if (path === '/api/login') {
      const account = accountByEmail.get(address);
      const valid = await checkPassword(password, account?.password);
      assert(account && valid, 'Почта или пароль не совпадают.', 401);
      signIn(req, res, account.id);
      return json(res, 200, { ok: true });
    }
    assert(password.length >= 10, 'Пароль должен содержать не меньше 10 знаков.');
    const profile = newProfile({ first: field(body.first, 'Имя', 80), last: field(body.last, 'Фамилия', 80), role: 'member' });
    const encoded = await passwordRecord(password);
    tx(() => {
      assert(!accountByEmail.get(address), 'Этот адрес уже зарегистрирован.', 409);
      addAccount.run(profile.id, address, encoded);
      put('users', profile);
    });
    signIn(req, res, profile.id);
    json(res, 201, { ok: true });
  } catch (error) {
    if (res.headersSent || res.destroyed) return res.end();
    if (error instanceof InputError) return json(res, error.status, { error: error.message });
    console.error(error);
    json(res, 500, { error: 'Возникла ошибка сервера. Повторите попытку.' });
  }
});

setup().then(() => {
  upkeep();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.SPEKTR_HOST || '127.0.0.1', () => {
    console.log('Спектр · http://' + (process.env.SPEKTR_HOST || '127.0.0.1') + ':' + server.address().port);
  });
  setInterval(() => {
    try {
      upkeep();
      db.prepare('DELETE FROM mutations WHERE created<?').run(Date.now() - 7 * day);
    } catch (error) { console.error(error); }
  }, 60000).unref();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function eventFields(body) {
  const time = field(body.time, 'Время', 5);
  assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'Укажите действительное время.');
  const speakerId = field(body.speakerId, 'Спикер из участников', 60, false);
  const speaker = speakerId ? publicUser(find('users', speakerId)).name : field(body.speaker, 'Спикер', 100, false);
  return { title: field(body.title, 'Название'), date: date(body.date), time,
    description: field(body.description, 'Описание', 4000), place: field(body.place, 'Место', 180),
    speaker, speakerId, image: link(body.image) };
}

function onlyMember(id) {
  const user = find('users', id);
  assert(user.role === 'member', 'Выберите участника.');
  return user;
}

function saveMedia(value) {
  if (!value) return '';
  const match = /^data:(image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  assert(match, 'Загрузите изображение PNG, JPEG, WebP, GIF или видео MP4, WebM.');
  const buffer = Buffer.from(match[2], 'base64');
  assert(buffer.length > 0 && buffer.length <= 6 * 1024 * 1024, 'Файл должен весить до 6 МБ.');
  const id = randomUUID();
  db.prepare('INSERT INTO media VALUES(?,?,?)').run(id, match[1], buffer);
  return id;
}

function command(user, { action, requestId, ...body }) {
  access(user, Object.keys(roles));
  if (requestId !== undefined) assert(typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId), 'Некорректный номер операции.');
  if (!requestId) return tx(() => executeCommand(user, action, body));
  const signature = createHash('sha256').update(JSON.stringify([action, body])).digest('hex');
  return tx(() => {
    const cached = db.prepare('SELECT result FROM mutations WHERE actor=? AND key=?').get(user.id, requestId);
    if (cached) {
      const stored = JSON.parse(cached.result);
      assert(stored.signature === signature, 'Номер операции уже был использован.', 409);
      return stored.result;
    }
    const result = executeCommand(user, action, body);
    if (action !== 'deleteAccount') db.prepare('INSERT INTO mutations VALUES(?,?,?,?)')
      .run(user.id, requestId, JSON.stringify({ signature, result: result ?? null }), Date.now());
    return result;
  });
}

function executeCommand(user, action, body) {
  switch (action) {
      case 'profile': {
        const first = field(body.first, 'Имя', 80);
        const last = field(body.last, 'Фамилия', 80, false);
        const birthday = body.birthday ? date(body.birthday) : '';
        const updates = { first, last, birthday, about: field(body.about, 'О себе', 500, false),
          phone: field(body.phone, 'Телефон', 50, false), photo: link(body.photo),
          title: field(body.title, user.role === 'member' ? 'Статус' : 'Должность', 100, false) };
        const address = email(body.email);
        assert(!db.prepare('SELECT id FROM accounts WHERE email=? AND id<>?').get(address, user.id), 'Этот адрес уже используется.', 409);
        db.prepare('UPDATE accounts SET email=? WHERE id=?').run(address, user.id);
        return put('users', { ...get('users', user.id), ...updates });
      }
      case 'settings':
        return put('users', { ...get('users', user.id), settings: { alerts: body.alerts === true, email: body.email === true,
          theme: choice(body.theme, ['light', 'dark'], 'Тема') } });
      case 'alertsRead':
        for (const alert of all('alerts')) if (alert.to === user.id && !alert.read) put('alerts', { ...alert, read: true });
        return;
      case 'roleRequest':
      case 'idea':
      case 'support': {
        const type = { roleRequest: 'role', idea: 'idea', support: 'support' }[action];
        if (type === 'role') {
          access(user, ['member', 'specialist']);
          assert(!all('requests').some(r => r.type === 'role' && r.author === user.id && r.status === 'pending'),
            'У вас уже есть заявка на рассмотрении.', 409);
        }
        const request = put('requests', make({ type, author: user.id, status: 'pending',
          title: type === 'role' ? 'Заявка в модераторы' : field(body.title, 'Тема'),
          description: field(body.description, 'Описание', 3000),
          organizer: type === 'idea' ? field(body.organizer, 'Организатор', 160) : '',
          contact: type === 'idea' ? field(body.contact, 'Контакт', 160) : '' }));
        for (const person of all('users')) if ((type === 'role' ? ['owner'] : editors).includes(person.role))
          notify(person.id, 'Новая заявка · ' + request.title);
        return request;
      }
      case 'reviewRequest': {
        const request = find('requests', body.id);
        access(user, request.type === 'role' ? ['owner'] : editors);
        assert(request.status === 'pending', 'Заявка уже рассмотрена.', 409);
        const status = choice(body.status, ['approved', 'rejected'], 'Решение');
        const author = find('users', request.author);
        if (request.type === 'role' && status === 'approved') put('users', { ...author, role: 'moderator' });
        notify(author.id, request.title + (status === 'approved' ? ' · Одобрена' : ' · Отклонена'));
        return put('requests', { ...request, status, updatedAt: now() });
      }
      case 'role': {
        access(user, ['owner']);
        const target = find('users', body.id);
        assert(target.role !== 'owner', 'Права владельца меняются при передаче управления.');
        const role = choice(body.role, ['member', 'specialist', 'moderator'], 'Роль');
        notify(target.id, 'Новая роль · ' + roles[role]);
        return put('users', { ...target, role });
      }
      case 'transfer': {
        access(user, ['owner']);
        const target = find('users', body.id);
        assert(target.role === 'moderator', 'Управление можно передать модератору.');
        put('users', { ...get('users', user.id), role: 'moderator' });
        put('users', { ...target, role: 'owner' });
        notify(target.id, 'Вам передано управление «Спектром».');
        return;
      }
      case 'event': {
        access(user, staff);
        const fields = eventFields(body);
        if (body.id) {
          access(user, editors);
          const event = find('events', body.id);
          assert(event.status === 'published', 'Для этой заявки используйте решение модерации.');
          return put('events', { ...event, ...fields });
        }
        const event = make({ ...fields, author: user.id, rsvp: {}, status: 'pending' });
        if (user.role === 'specialist') {
          for (const person of all('users')) if (editors.includes(person.role)) notify(person.id, 'На модерации · ' + event.title);
          return put('events', event);
        }
        publishEvent(event, user.id, body.news === true);
        return event;
      }
      case 'reviewEvent': {
        access(user, editors);
        const event = find('events', body.id);
        assert(event.status === 'pending', 'Событие уже рассмотрено.', 409);
        const status = choice(body.status, ['approved', 'rejected'], 'Решение');
        if (status === 'approved') publishEvent(event, user.id, body.news === true);
        else put('events', { ...event, status: 'rejected' });
        notify(event.author, event.title + (status === 'approved' ? ' · Опубликовано' : ' · Отклонено'));
        return;
      }
      case 'rsvp': {
        access(user, ['member']);
        const event = find('events', body.id);
        assert(event.status === 'published', 'Событие ещё не опубликовано.');
        event.rsvp[user.id] = choice(body.response, reactions, 'Ваш ответ');
        return put('events', event);
      }
      case 'news': {
        access(user, editors);
        const post = body.id ? find('news', body.id) : make({ author: user.id, likes: [], comments: [] });
        const updated = put('news', { ...post, title: field(body.title, 'Заголовок'),
          description: field(body.description, 'Текст новости', 6000), image: link(body.image), video: link(body.video) });
        if (!body.id) announce('Новая публикация · ' + updated.title, user.id);
        return updated;
      }
      case 'like':
      case 'comment': {
        const post = find('news', body.id);
        if (action === 'like') post.likes = post.likes.includes(user.id) ? post.likes.filter(id => id !== user.id) : [...post.likes, user.id];
        else post.comments.push(make({ author: user.id, text: field(body.text, 'Комментарий', 1000) }));
        put('news', post);
        return;
      }
      case 'task': {
        access(user, editors);
        const task = body.id ? find('tasks', body.id) : make({ author: user.id, archived: false });
        const difficulty = choice(body.difficulty, difficulties, 'Сложность');
        const active = all('bookings').filter(b => b.taskId === task.id && activeBooking(b)).length;
        assert(!active || task.difficulty === difficulty, 'У задания уже есть брони. Сложность зафиксирована.');
        const updated = put('tasks', { ...task, title: field(body.title, 'Название'),
          points: number(body.points, 'Награда'), summary: field(body.summary, 'Краткое описание', 280),
          description: field(body.description, 'Подробное описание', 4000), difficulty,
          capacity: difficulty === 'easy' ? null : number(body.capacity, 'Количество мест', Math.max(1, active), 10000),
          awarder: field(body.awarder, 'Кто начисляет баллы', 160), once: difficulty === 'easy' && body.once === true });
        if (!body.id) announce('Новое задание · ' + updated.title, user.id);
        return updated;
      }
      case 'bookTask': {
        access(user, ['member']);
        const task = find('tasks', body.id);
        assert(!task.archived && task.difficulty !== 'easy' && available(task) > 0, 'Свободных мест уже нет.', 409);
        assert(!all('bookings').some(b => b.taskId === task.id && b.userId === user.id && activeBooking(b)),
          'Вы уже забронировали это задание.', 409);
        return put('bookings', make({ taskId: task.id, userId: user.id, expires: Date.now() + day, status: 'reserved' }));
      }
      case 'confirmTask':
      case 'completeTask': {
        access(user, action === 'confirmTask' ? editors : staff);
        const task = find('tasks', body.taskId);
        const target = onlyMember(body.userId);
        assert(!task.archived || task.difficulty !== 'easy', 'Задание находится в архиве.', 409);
        const booking = all('bookings').find(b => b.taskId === task.id && b.userId === target.id && activeBooking(b));
        if (action === 'confirmTask') {
          assert(booking?.status === 'reserved', 'Активная бронь не найдена.', 409);
          notify(target.id, 'Бронь подтверждена · ' + task.title);
          return put('bookings', { ...booking, status: 'confirmed' });
        }
        if (task.difficulty === 'easy') assert(!task.once || !booking, 'За это задание баллы уже начислены.', 409);
        else assert(booking?.status === 'confirmed', 'Для начисления нужна подтверждённая бронь.', 409);
        const completed = put('bookings', { ...(booking && task.difficulty !== 'easy' ? booking : make({
          taskId: task.id, userId: target.id })), status: 'done' });
        adjust(target, task.points, task.title, 'task', user.id, { difficulty: task.difficulty, attended: body.attended === true });
        return completed;
      }
      case 'gift': {
        access(user, editors);
        const gift = body.id ? find('gifts', body.id) : make({ author: user.id, archived: false });
        return put('gifts', { ...gift, title: field(body.title, 'Название'),
          description: field(body.description, 'Описание', 3000), price: number(body.price, 'Стоимость'),
          stock: number(body.stock, 'Остаток', 0, 10000), category: choice(body.category, categories, 'Категория'),
          image: link(body.image) });
      }
      case 'archive': {
        access(user, editors);
        const type = choice(body.type, ['tasks', 'gifts'], 'Раздел');
        return put(type, { ...find(type, body.id), archived: body.archived === true });
      }
      case 'redeem': {
        access(user, ['member']);
        const gift = find('gifts', body.id);
        assert(!gift.archived && gift.stock > 0, 'Эта награда закончилась.', 409);
        const member = onlyMember(user.id);
        adjust(member, -gift.price, 'Бронь · ' + gift.title, 'redeem', user.id);
        put('gifts', { ...gift, stock: gift.stock - 1 });
        return put('redemptions', make({ giftId: gift.id, title: gift.title, userId: user.id, price: gift.price, status: 'reserved' }));
      }
      case 'reviewRedemption': {
        access(user, editors);
        const item = find('redemptions', body.id);
        assert(item.status === 'reserved', 'Бронь уже обработана.', 409);
        const status = choice(body.status, ['collected', 'cancelled'], 'Решение');
        if (status === 'cancelled') {
          const profile = find('users', item.userId);
          // Возврат не является новой активностью или заработком.
          profile.balance += item.price;
          profile.season = seasonAt(Date.now());
          put('users', profile);
          put('ledger', make({ userId: profile.id, amount: item.price, reason: 'Возврат · ' + item.title,
            kind: 'refund', actor: user.id }));
          const gift = find('gifts', item.giftId);
          put('gifts', { ...gift, stock: gift.stock + 1 });
        }
        notify(item.userId, item.title + (status === 'collected' ? ' · Награда выдана' : ' · Бронь отменена, баллы возвращены'));
        return put('redemptions', { ...item, status });
      }
      case 'award':
      case 'penalty': {
        access(user, staff);
        const member = onlyMember(body.userId);
        const reason = field(body.reason, 'Причина', 300);
        const amount = action === 'award' ? number(body.amount, 'Количество баллов') : -Math.floor(member.balance * .05);
        adjust(member, amount, reason, action, user.id, { attended: action === 'award' && body.attended === true });
        return;
      }
      case 'rankSettings': {
        access(user, ['owner']);
        const config = { id: 'ranks' };
        for (const key of ['easy', 'earned', 'medium', 'hard']) config[key] = body[key] ? number(body[key], 'Порог ранга') : null;
        put('config', config);
        for (const member of all('users').filter(u => u.role === 'member')) put('users', { ...member, rank: rankFor(member) });
        return;
      }
      case 'mentor': {
        access(user, editors);
        const mentor = onlyMember(body.userId);
        const mentee = onlyMember(body.menteeId);
        assert(mentor.id !== mentee.id && mentee.rank >= 2, 'Подопечный должен достичь ранга «Люминофор».');
        assert(!mentor.mentored?.includes(mentee.id), 'Этот подопечный уже зачтён.', 409);
        mentor.mentored = [...(mentor.mentored || []), mentee.id];
        mentor.rank = rankFor(mentor);
        return put('users', mentor);
      }
      case 'chat': {
        const others = Array.isArray(body.members) ? [...new Set(body.members)].filter(id => id !== user.id) : [];
        assert(others.length > 0 && others.length <= 30, 'Выберите от 1 до 30 собеседников.');
        for (const id of others) find('users', id);
        const isGroup = body.group === true;
        assert(isGroup || others.length === 1, 'Для личного чата выберите одного человека.');
        const existing = !isGroup && all('chats').find(c => !c.group && c.members.includes(user.id) && c.members.includes(others[0]));
        return existing || put('chats', make({ group: isGroup, members: [user.id, ...others],
          title: isGroup ? field(body.title, 'Название группы', 120) : '' }));
      }
      case 'message': {
        const chat = find('chats', body.id);
        assert(chat.members.includes(user.id), 'Чат недоступен.', 403);
        const text = field(body.text, 'Сообщение', 3000, false);
        const media = saveMedia(body.media);
        assert(text || media, 'Добавьте сообщение или файл.');
        const message = put('messages', make({ chatId: chat.id, author: user.id, text, media,
          video: typeof body.media === 'string' && body.media.startsWith('data:video/') }));
        for (const id of chat.members) if (id !== user.id) notify(id, 'Новое сообщение · ' + publicUser(user).name);
        return { id: message.id };
      }
      case 'deleteAccount': {
        assert(user.role !== 'owner', 'Передайте управление модератору перед удалением профиля.');
        assert(body.confirm === 'Удалить', 'Введите «Удалить» для подтверждения.');
        db.prepare('DELETE FROM sessions WHERE account=?').run(user.id);
        db.prepare('DELETE FROM accounts WHERE id=?').run(user.id);
        db.prepare('DELETE FROM mutations WHERE actor=?').run(user.id);
        for (const type of ['users', 'bookings', 'redemptions', 'ledger', 'alerts', 'requests']) {
          for (const entry of all(type)) if ([entry.id, entry.userId, entry.author, entry.to].includes(user.id)) {
            if (type === 'redemptions' && entry.status === 'reserved') {
              const gift = get('gifts', entry.giftId);
              if (gift) put('gifts', { ...gift, stock: gift.stock + 1 });
            }
            query.delete.run(type, entry.id);
          }
        }
        for (const message of all('messages')) if (message.author === user.id) {
          if (message.media) db.prepare('DELETE FROM media WHERE id=?').run(message.media);
          query.delete.run('messages', message.id);
        }
        for (const chat of all('chats')) if (chat.members.includes(user.id))
          put('chats', { ...chat, members: chat.members.filter(id => id !== user.id) });
        for (const event of all('events')) if (event.rsvp[user.id]) {
          delete event.rsvp[user.id];
          put('events', event);
        }
        return;
      }
      default:
        throw new InputError(404, 'Действие не найдено.');
  }
}
