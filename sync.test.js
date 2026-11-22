'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readdirSync, rmdirSync, unlinkSync } = require('node:fs');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function start(directory) {
  const child = spawn(process.execPath, [join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: '0', SPEKTR_HOST: '127.0.0.1', SPEKTR_DB: join(directory, 'test.sqlite'),
      SPEKTR_DEMO: '1', SPEKTR_OWNER_EMAIL: '', SPEKTR_OWNER_PASSWORD: '', SPEKTR_HTTPS: '0' },
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  let running = true;
  const exit = once(child, 'exit').then(() => { running = false; });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Server startup timed out ' + errors));
    }, 7000);
    let output = '';
    child.stdout.on('data', buffer => {
      output += buffer;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    exit.then(() => {
      clearTimeout(timer);
      reject(new Error('Server exited early ' + errors));
    }, reject);
  });
  return { address, close:async () => {
    if (running) child.kill();
    await exit;
  } };
}

function browser(address) {
  let cookie = '';
  async function api(path, body, status = 200) {
    const response = await fetch(address + '/api/' + path, {
      method:body ? 'POST' : 'GET', headers:{ Cookie:cookie, ...(body && { 'Content-Type':'application/json' }) },
      body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return payload;
  }
  return { api, state:() => api('state'), act:async (action, payload, status) => (await api('action', { action, ...payload }, status)).result };
}

test('Separate sessions share registrations, role applications, events, bookings and balances', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spektr-test-'));
  let server;
  try {
    server = await start(directory);
    const guest = browser(server.address);
    const member = browser(server.address);
    const applicant = browser(server.address);
    const owner = browser(server.address);
    const specialist = browser(server.address);
    const moderator = browser(server.address);
    await Promise.all([[member,'member'], [owner,'owner'], [specialist,'specialist'], [moderator,'moderator']]
      .map(([session, role]) => session.api('demo', { role })));

    const credentials = { first:'Аня', last:'Тестова', email:'anya@example.test', password:'Testing-2026!' };
    await applicant.api('register', { ...credentials, role:'owner' }, 201);
    const user = (await applicant.state()).me;
    assert.equal(user.role, 'member');
    assert((await owner.state()).directory.some(entry => entry.id === user.id));
    assert.equal((await guest.state()).directory, undefined);
    const request = await applicant.act('roleRequest', { description:'Хочу помогать команде.' });
    assert((await owner.state()).requests.some(entry => entry.id === request.id));
    assert(!(await moderator.state()).requests.some(entry => entry.id === request.id));
    await moderator.act('reviewRequest', { id:request.id, status:'approved' }, 403);
    await owner.act('reviewRequest', { id:request.id, status:'approved' });
    assert.equal((await applicant.state()).me.role, 'moderator');

    const details = { title:'Мастерская владельца', description:'Проверка публикации.', place:'Спектр', date:'2032-01-15', time:'16:30' };
    const baseline = await member.api('revision');
    const event = await owner.act('event', { ...details, news:false });
    assert((await member.api('revision')).revision > baseline.revision);
    assert((await member.state()).events.some(entry => entry.id === event.id));
    assert(!(await member.state()).news.some(entry => entry.eventId === event.id));
    const submitted = await specialist.act('event', { ...details, title:'Встреча специалиста' });
    assert(!(await member.state()).events.some(entry => entry.id === submitted.id));
    assert((await moderator.state()).inReview.some(entry => entry.id === submitted.id));
    await specialist.act('event', { ...details, id:submitted.id }, 403);
    await moderator.act('reviewEvent', { id:submitted.id, status:'approved', news:true });
    assert((await member.state()).events.some(entry => entry.id === submitted.id));
    assert((await member.state()).news.some(entry => entry.eventId === submitted.id));
    await member.act('event', details, 403);
    await member.act('rsvp', { id:submitted.id, response:'yes' });
    assert.equal((await owner.state()).events.find(entry => entry.id === submitted.id).attending, 1);

    const memberProfile = (await member.state()).me;
    const task = await moderator.act('task', { title:'Одна бронь', points:25, summary:'Помочь', description:'Подготовить материалы',
      difficulty:'medium', capacity:1, awarder:'Модератор' });
    await member.act('bookTask', { id:task.id });
    assert(!(await guest.state()).people);
    await moderator.act('confirmTask', { userId:memberProfile.id, taskId:task.id });
    const command = { userId:memberProfile.id, taskId:task.id, requestId:randomUUID() };
    await specialist.act('completeTask', command);
    await specialist.act('completeTask', command);
    await specialist.act('completeTask', { ...command, requestId:randomUUID() }, 409);
    assert.equal((await member.state()).me.balance, memberProfile.balance + 25);

    const gift = await moderator.act('gift', { title:'Подвес', description:'Мерч', price:20, stock:1, category:'merch' });
    const redeemed = await member.act('redeem', { id:gift.id });
    await member.act('redeem', { id:gift.id }, 409);
    await moderator.act('reviewRedemption', { id:redeemed.id, status:'cancelled' });
    assert.equal((await member.state()).me.balance, memberProfile.balance + 25);
    assert.equal((await guest.state()).gifts.find(entry => entry.id === gift.id).stock, 1);

    const chat = await member.act('chat', { members:[user.id], group:false });
    await member.act('message', { id:chat.id, text:'Привет из другой сессии' });
    assert((await applicant.state()).chats.some(entry => entry.id === chat.id && entry.messages.length === 1));
    assert(!(await owner.state()).chats.some(entry => entry.id === chat.id));
    await owner.act('message', { id:chat.id, text:'Проверка доступа' }, 403);

    await server.close();
    server = await start(directory);
    const restored = browser(server.address);
    await restored.api('login', credentials);
    assert.equal((await restored.state()).me.role, 'moderator');
    assert((await restored.state()).events.some(entry => entry.id === submitted.id));
  } finally {
    await server?.close();
    for (const path of readdirSync(directory)) unlinkSync(join(directory, path));
    rmdirSync(directory);
  }
});
