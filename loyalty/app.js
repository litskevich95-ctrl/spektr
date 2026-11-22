'use strict';

const main = document.querySelector('main');
const openedAsFile = location.protocol === 'file:';
const dialog = document.querySelector('dialog');
const dialogContent = document.querySelector('#dialog-content');
const connection = document.querySelector('#connection');
const defaultState = { revision: -1, me: null, events: [], news: [], tasks: [], gifts: [] };
let data = defaultState;
let loading = true;
let requestSequence = 0;
let toastTimer;
let submitHandler;
let renderedMain;
let pendingRetry;
let installPrompt;
let difficultyFilter = '';
let marketFilter = '';
let calendarMode = 'list';
let month = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
let selectedDay = '';
let selectedChat = '';

const roleNames = { member: 'Участник', specialist: 'Специалист', moderator: 'Модератор', owner: 'Владелец' };
const levels = { easy: 'Простое', medium: 'Среднее', hard: 'Сложное' };
const categories = { merch: 'Фирменный мерч', perk: 'Возможности', partner: 'Подарки партнёров' };
const responses = { yes: 'Обязательно буду', maybe: 'Планирую прийти', cannot: 'Очень хочу, но не смогу', 'not-interested': 'Тема мне не актуальна' };
const statuses = { pending: 'На рассмотрении', approved: 'Одобрено', rejected: 'Отклонено', reserved: 'Забронировано',
  confirmed: 'Подтверждено', done: 'Выполнено', expired: 'Бронь истекла', collected: 'Выдано', cancelled: 'Отменено' };
const navItems = { home: 'Главная', events: 'Афиша', tasks: 'Задания', market: 'Маркет', news: 'Новости',
  chats: 'Сообщения', profile: 'Профиль', moderation: 'Модерация', owner: 'Управление' };
const editable = () => ['owner', 'moderator'].includes(data.me?.role);
const isStaff = () => !!data.me && data.me.role !== 'member';
const byId = (entries, id) => (entries || []).find(entry => entry.id === id);
const person = id => byId(data.people, id)?.name || 'Пользователь';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const fmt = new Intl.NumberFormat('ru');
const prettyDate = value => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(value));
const timeStamp = value => new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Novosibirsk' }).format(new Date(value));
const icon = name => {
  const paths = {
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};
const button = (label, open, id = '', look = 'outline') => `<button class="button ${look}" type="button" data-open="${esc(open)}" data-id="${esc(id)}">${esc(label)}</button>`;
const anchor = (label, page, look = 'outline') => `<a class="button ${look}" href="#${page}">${esc(label)}</a>`;
const pill = (label, style = '') => `<span class="pill ${style}">${esc(label)}</span>`;
const empty = text => `<p class="empty">${esc(text)}</p>`;
const actions = (...content) => `<div class="actions">${content.join('')}</div>`;
const list = (entries, renderer, fallback) => entries.length ? entries.map(renderer).join('') : empty(fallback);
const panel = (title, content, className = '') => `<section class="panel ${className}"><h2>${esc(title)}</h2>${content}</section>`;
const row = (title, meta, buttons = '') => `<div class="row"><div><strong>${esc(title)}</strong>${meta ? `<small class="muted">${esc(meta)}</small>` : ''}</div>${buttons}</div>`;
const page = (title, description, content, controls = '') => `<section class="shell section"><div class="section-head"><div>
  <h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div>${controls}</div>${content}</section>`;
const grid = (entries, render, fallback, size = '') => entries.length ? `<div class="grid ${size}">${entries.map(render).join('')}</div>` : empty(fallback);

function route() {
  const key = location.hash.slice(1);
  return Object.hasOwn(navItems, key) ? key : 'home';
}

function art(entry, index, symbol = '✦') {
  const tone = ['ink', 'sun', 'lilac'].includes(entry.art) ? entry.art : ['pink', 'green', 'lilac'][index % 3];
  const picture = entry.image || (entry.art ? './event-' + tone + '.webp' : '');
  return `<div class="art ${tone}">${picture
    ? `<img src="${esc(picture)}" alt="" width="480" height="220" loading="lazy">`
    : `<span class="art-mark" aria-hidden="true">${symbol}</span>`}</div>`;
}

function eventCard(event, index) {
  return `<article class="card">${art(event, index)}<div class="card-body">
    <div class="pill-row">${pill(prettyDate(event.date) + ' · ' + event.time, 'sun')}${event.response ? pill(responses[event.response], 'green') : ''}</div>
    <h3>${esc(event.title)}</h3><p>${esc(event.place)}</p>
    ${actions(button('Подробнее ↗', 'eventDetail', event.id), editable() ? button('Изменить', 'event', event.id) : '')}
  </div></article>`;
}

function taskCard(task) {
  const booking = (data.bookings || []).find(b => b.taskId === task.id && b.userId === data.me?.id && ['reserved','confirmed','done'].includes(b.status));
  return `<article class="card"><div class="card-body">
    <div class="pill-row">${pill(levels[task.difficulty], {easy:'green',medium:'sun',hard:'pink'}[task.difficulty])}${pill('+' + fmt.format(task.points) + ' СК')}</div>
    <h3>${esc(task.title)}</h3><p>${esc(task.summary)}</p>
    ${task.archived ? '<p>В архиве</p>' : booking ? `<p>${statuses[booking.status]}</p>` : task.available !== null ? `<p>Свободных мест: ${task.available}</p>` : ''}
    ${actions(button('О задании ↗', 'taskDetail', task.id), editable() ? button('Изменить', 'task', task.id) : '')}
  </div></article>`;
}

function giftCard(gift, index) {
  return `<article class="card">${art(gift, index, '✷')}<div class="card-body">
    <div class="pill-row">${pill(categories[gift.category])}${pill(fmt.format(gift.price) + ' СК', 'sun')}</div>
    <h3>${esc(gift.title)}</h3><p>${gift.archived ? 'В архиве' : gift.stock ? 'В наличии: ' + gift.stock : 'Закончилась'}</p>
    ${actions(button('О награде ↗', 'giftDetail', gift.id), editable() ? button('Изменить', 'gift', gift.id) : '')}
  </div></article>`;
}

function newsCard(post, index) {
  return `<article class="card">${post.image ? art(post, index) : ''}<div class="card-body">
    <span class="card-meta">${prettyDate(post.createdAt)}</span><h3>${esc(post.title)}</h3>
    <p>${esc(post.description.length > 180 ? post.description.slice(0, 180) + '…' : post.description)}</p>
    ${actions(button('Читать ↗', 'newsDetail', post.id), editable() ? button('Изменить', 'news', post.id) : '')}
  </div></article>`;
}

function upcoming() {
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  return data.events.filter(event => event.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function home() {
  const entries = upcoming().slice(0, 3);
  const me = data.me;
  const heroLabel = me?.role === 'member' ? fmt.format(me.balance) + ' СК на балансе' : me ? roleNames[me.role] : '';
  return `<section class="shell hero">
    <div class="hero-copy"><p class="eyebrow"><span></span> Цветовое пространство</p>
      <h1>От искры<br>до <em>спектра.</em></h1>
      <p class="lead">Ходи на события, делай полезные дела и меняй Спектр-коины на подарки.</p>
      ${actions(anchor('Смотреть афишу ↗', 'events', 'ink'), me ? anchor('Мой профиль', 'profile') : button('Выбрать роль', 'login'))}
    </div><div class="hero-visual"><div class="orbit"></div>
      <img src="./hero.webp" alt="" width="720" height="720" fetchpriority="high">${heroLabel ? `<a class="hero-tag" href="#profile">${esc(heroLabel)}</a>` : ''}
    </div></section>
    <div class="ribbon"><div class="shell ribbon-inner">
      <a href="#events"><b aria-hidden="true">✦</b> Ходи на события</a>
      <a href="#tasks"><b aria-hidden="true">✦</b> Выполняй задания</a>
      <a href="#market"><b aria-hidden="true">✦</b> Выбирай награды</a>
    </div></div>
    <section class="shell section"><div class="section-head"><div><h2>Ближайшие события</h2></div>${anchor('Вся афиша ↗', 'events')}</div>
    ${loading ? '<div class="grid" aria-label="Загружаем события"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'
      : grid(entries, eventCard, 'Ближайших событий пока нет. Новые встречи появятся в афише.')}</section>
    ${data.tasks.length ? `<section class="shell section"><div class="section-head"><h2>Задания</h2>${anchor('Все задания ↗', 'tasks')}</div>
    ${grid(data.tasks.filter(t => !t.archived).slice(0, 3), taskCard, 'Открытых заданий пока нет.')}</section>` : ''}
    ${data.news.length ? `<section class="shell section"><div class="section-head"><h2>Новости</h2>${anchor('Все новости ↗', 'news')}</div>
    ${grid([...data.news].reverse().slice(0, 3), newsCard, '')}</section>` : ''}`;
}

function filterButton(label, filter, value, active) {
  return `<button type="button" class="button outline" data-filter="${filter}" data-value="${value}" aria-pressed="${active}">${esc(label)}</button>`;
}

function eventsPage() {
  const [year, mon] = month.split('-').map(Number);
  const range = data.events.filter(e => e.date.startsWith(month)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const eventDays = new Set(range.map(e => e.date));
  const gap = (new Date(Date.UTC(year, mon - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const calendar = `<div class="calendar" aria-label="Дни месяца">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(d => `<span class="weekday">${d}</span>`).join('')}
    ${'<span></span>'.repeat(gap)}${Array.from({ length: days }, (_, i) => {
      const date = month + '-' + String(i + 1).padStart(2, '0');
      return `<button type="button" class="${eventDays.has(date) ? 'has-event' : ''}" data-filter="day" data-value="${date}"
        aria-pressed="${selectedDay === date}" aria-label="${prettyDate(date)}${eventDays.has(date) ? ', есть события' : ''}">${i + 1}</button>`;
    }).join('')}</div>`;
  const entries = calendarMode === 'calendar' ? range.filter(e => !selectedDay || selectedDay === e.date) : upcoming();
  return page('Афиша', 'Время событий указано по Новосибирску.',
    `<div class="filters">${filterButton('Ближайшие', 'calendar', 'list', calendarMode === 'list')}
    ${filterButton('Календарь', 'calendar', 'calendar', calendarMode === 'calendar')}
    ${calendarMode === 'calendar' ? `<label class="date-picker">Месяц <input id="month" type="month" min="2000-01" max="2120-12" value="${esc(month)}"></label>` : ''}</div>
    ${calendarMode === 'calendar' ? calendar : ''}
    ${grid(entries, eventCard, 'На выбранные даты событий пока нет.')}`,
    actions(data.me && !editable() ? button('Предложить идею', 'idea') : '',
      isStaff() ? button(editable() ? 'Создать событие' : 'Предложить событие', 'event', '', 'ink') : ''));
}

function tasksPage() {
  const entries = data.tasks.filter(t => (!t.archived || editable()) && (!difficultyFilter || t.difficulty === difficultyFilter));
  return page('Задания', 'Выбери дело по силам и зарабатывай Спектр-коины.',
    `<div class="filters">${Object.entries({ '': 'Все', ...levels }).map(([key, name]) => filterButton(name, 'difficulty', key, key === difficultyFilter)).join('')}</div>
    ${grid(entries, taskCard, 'В этой категории пока нет заданий.')}`, editable() ? button('Создать задание', 'task', '', 'ink') : '');
}

function marketPage() {
  const entries = data.gifts.filter(g => !marketFilter || g.category === marketFilter);
  return page('Спектр-маркет', data.me?.role === 'member' ? 'На балансе ' + fmt.format(data.me.balance) + ' СК.' : 'Подарки, которые можно забронировать за Спектр-коины.',
    `<div class="filters">${Object.entries({ '': 'Все награды', ...categories }).map(([key, label]) => filterButton(label, 'market', key, key === marketFilter)).join('')}</div>
    ${grid(entries, giftCard, 'В этой категории пока нет наград.')}`, editable() ? button('Добавить награду', 'gift', '', 'ink') : '');
}

function newsPage() {
  return page('Новости', '', grid([...data.news].reverse(), newsCard, 'Публикаций пока нет.'),
    editable() ? button('Создать новость', 'news', '', 'ink') : '');
}

const requiresLogin = (title) => page(title, '', panel('Войди в «Спектр»', actions(button('Войти', 'login', '', 'ink'), button('Зарегистрироваться', 'register'))));

function profilePage() {
  const me = data.me;
  if (!me) return requiresLogin('Мой профиль');
  const isMember = me.role === 'member';
  const fullName = [me.first, me.last].filter(Boolean).join(' ');
  const rank = data.rankNames[isMember ? me.rank : 5] || 'Новичок';
  const myBookings = data.bookings.filter(b => b.userId === me.id && b.status !== 'expired');
  const myGifts = data.redemptions.filter(r => r.userId === me.id);
  const history = data.ledger;
  const next = data.rankNames[me.rank + 1];
  const roleRequest = data.requests.find(r => r.type === 'role' && r.author === me.id && r.status === 'pending');
  const sections = [
    panel('Профиль', `<div><span class="avatar">${me.photo ? `<img src="${esc(me.photo)}" alt="">`
      : esc(me.first[0] + (me.last?.[0] || ''))}</span><strong>${esc(fullName)}</strong></div>
      <p class="muted">${esc(me.email)}${me.title ? ' · ' + esc(me.title) : ''}</p>
      ${me.phone ? `<p>${esc(me.phone)}</p>` : ''}${me.birthday ? `<p>Дата рождения · ${prettyDate(me.birthday)} ${esc(me.birthday.slice(0, 4))}</p>` : ''}
      ${me.about ? '<p>' + esc(me.about) + '</p>' : ''}${actions(button('Редактировать', 'profile'), button('Настройки', 'settings'))}`),
    panel('Мой ранг', `<p class="score">${esc(rank)}</p>${isMember ? `<p class="muted">${next ? 'Следующий ранг · ' + esc(next) : 'Высший ранг'}</p>` : ''}
      ${button('Условия рангов', 'ranks')}`, 'tinted'),
  ];
  if (isMember) sections.push(panel('Мои успехи', `<p class="score">${fmt.format(me.balance)} СК</p>
    <div class="pill-row">${Object.entries(me.counts).map(([key, count]) => pill(levels[key] + ' · ' + count)).join('')}</div>${button('Правила сгорания', 'burn')}`),
    panel('История баллов', `<div class="rows">${list(history, l => row(l.reason, (l.amount > 0 ? '+' : '') + fmt.format(l.amount) + ' СК · ' + timeStamp(l.createdAt)), 'Операций пока нет.')}</div>`),
    panel('Мои брони заданий', `<div class="rows">${list(myBookings, b => row(byId(data.tasks, b.taskId)?.title || 'Задание',
      statuses[b.status] + (b.status === 'reserved' ? ' · до ' + timeStamp(b.expires) : ''),
      byId(data.tasks, b.taskId) ? button('Открыть', 'taskDetail', b.taskId) : ''), 'Броней пока нет.')}</div>`),
    panel('Мои награды', `<div class="rows">${list(myGifts, r => row(r.title, statuses[r.status]), 'Броней пока нет.')}</div>`));
  if (data.stats) sections.push(panel('Статистика пространства', `<div class="rows">
    ${row('Участники', String(data.stats.people))}${row('Заработано за календарный год', fmt.format(data.stats.earned) + ' СК')}
    ${data.stats.tasks.map((n, i) => row(['Простые задания','Средние задания','Сложные задания'][i], String(n))).join('')}
    ${row('Новички', String(data.stats.beginners))}${data.stats.ranks.map((n, i) => row(data.rankNames[i], String(n))).join('')}</div>`));
  sections.push(panel('Мои заявки', `<div class="rows">${list(data.requests.filter(r => r.author === me.id), r => row(r.title, statuses[r.status]), 'Заявок пока нет.')}
    ${list(data.inReview.filter(e => e.author === me.id), e => row(e.title, statuses[e.status]), '')}</div>
    ${actions(!editable() && !roleRequest ? button('Подать заявку в модераторы', 'roleRequest') : '', button('Поддержка', 'support'))}`));
  return page(fullName, roleNames[me.role], `<div class="grid two">${sections.join('')}</div>`);
}

function moderationPage() {
  if (!isStaff()) return requiresLogin('Модерация');
  const sections = [panel('События', actions(button(editable() ? 'Создать событие' : 'Предложить событие', 'event', '', 'ink'))),
    panel('Спектр-коины', actions(button('Начислить баллы', 'award'), button('Назначить штраф 5%', 'penalty'), button('Отметить выполнение', 'completeTask')))];
  if (editable()) {
    sections.push(
      panel('События на модерации', `<div class="rows">${list(data.inReview.filter(e => e.status === 'pending'),
        e => row(e.title, person(e.author) + ' · ' + prettyDate(e.date), button('Рассмотреть', 'reviewEvent', e.id)), 'Новых событий на рассмотрении нет.')}</div>`),
      panel('Идеи и поддержка', `<div class="rows">${list(data.requests.filter(r => r.type !== 'role' && r.status === 'pending'),
        r => row(r.title, person(r.author) + ' · ' + (r.type === 'idea' ? 'Идея' : 'Поддержка'), button('Рассмотреть', 'reviewRequest', r.id)),
        'Новых обращений нет.')}</div>`),
      panel('Брони заданий', `<div class="rows">${list(data.bookings.filter(b => b.status === 'reserved' || b.status === 'confirmed'),
        b => row(byId(data.tasks, b.taskId)?.title || 'Задание', person(b.userId) + ' · ' + statuses[b.status],
          b.status === 'reserved' ? button('Подтвердить', 'confirmTask', b.id) : button('Начислить за выполнение', 'bookingComplete', b.id)),
        'Активных броней нет.')}</div>`),
      panel('Выдача наград', `<div class="rows">${list(data.redemptions.filter(r => r.status === 'reserved'),
        r => row(r.title, person(r.userId) + ' · ' + r.price + ' СК', button('Обработать', 'reviewRedemption', r.id)),
        'Активных броней нет.')}</div>`),
      panel('Материалы', actions(button('Создать задание', 'task'), button('Создать новость', 'news'), button('Добавить награду', 'gift'), button('Зачесть наставничество', 'mentor'))));
  }
  return page('Модерация', roleNames[data.me.role], `<div class="grid two">${sections.join('')}</div>`);
}

function ownerPage() {
  if (data.me?.role !== 'owner') return requiresLogin('Управление');
  const members = data.directory.filter(u => u.role === 'member').sort((a, b) => b.earned - a.earned);
  const staff = data.directory.filter(u => u.role !== 'member' && u.role !== 'owner');
  const queue = data.requests.filter(r => r.type === 'role' && r.status === 'pending');
  return page('Управление', 'Владелец пространства', `<div class="grid two">
    ${panel('Заявки в модераторы', `<div class="rows">${list(queue, r => row(person(r.author), timeStamp(r.createdAt), button('Рассмотреть', 'reviewRequest', r.id)),
      'Новых заявок нет.')}</div>`)}
    ${panel('Модераторы и специалисты', `<div class="rows">${list(staff, u => row(u.name, roleNames[u.role], button('Роль', 'role', u.id)), 'Команда пока пуста.')}</div>`)}
    ${panel('Участники', `<div class="rows">${list(members, (u, i) => row((i + 1) + '. ' + u.name,
      (data.rankNames[u.rank] || 'Новичок') + ' · заработано ' + fmt.format(u.earned) + ' СК', button('Роль', 'role', u.id)), 'Участников пока нет.')}</div>`)}
    ${panel('Настройки программы', actions(button('Пороги рангов', 'rankSettings'), button('Передать управление', 'transfer')))}
  </div>`);
}

function chatName(chat) {
  return chat.group ? chat.title : person(chat.members.find(id => id !== data.me.id));
}

function chatMessages(chat) {
  return list(chat.messages, m => `<div class="message ${m.author === data.me.id ? 'mine' : ''}"><small>${esc(person(m.author))} · ${timeStamp(m.createdAt)}</small>
    ${m.text ? `<p>${esc(m.text)}</p>` : ''}
    ${m.media ? m.video ? `<video controls preload="metadata" src="/api/media/${esc(m.media)}"></video>`
      : `<img loading="lazy" src="/api/media/${esc(m.media)}" alt="Вложение в сообщении">` : ''}</div>`, 'Начни разговор.');
}

function chatsPage() {
  if (!data.me) return requiresLogin('Сообщения');
  const chat = byId(data.chats, selectedChat);
  return page('Сообщения', '', `<div class="grid two">
    ${panel('Чаты', `<div class="rows">${list(data.chats, c => row(chatName(c), c.messages.at(-1)?.text.slice(0, 90) || '',
      button('Открыть', 'chatChoose', c.id)), 'Личных и групповых чатов пока нет.')}</div>`)}
    ${chat ? panel(chatName(chat), `<div class="conversation" id="conversation" role="log" aria-label="Сообщения чата">${chatMessages(chat)}</div>
      <form id="message-form"><p class="form-error" role="alert"></p>${textarea('text', 'Сообщение', '', false, 3000)}
      <label class="field">Фото, мем или видео до 6 МБ <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"></label>
      <button type="submit" class="button ink">Отправить</button></form>`) : empty('Выбери чат или начни новый.')}
  </div>`, actions(button('Написать', 'chat', '', 'ink'), button('Создать группу', 'group')));
}

const renderers = { home, events: eventsPage, tasks: tasksPage, market: marketPage, news: newsPage,
  profile: profilePage, chats: chatsPage, moderation: moderationPage, owner: ownerPage };

function render(options = {}) {
  const key = route();
  const me = data.me;
  const pages = ['events', 'tasks', 'market', 'news'];
  if (me) pages.push('chats');
  if (isStaff()) pages.push('moderation');
  if (me?.role === 'owner') pages.push('owner');
  document.documentElement.dataset.theme = me?.settings.theme || 'light';
  const nav = document.querySelector('#nav');
  const nextNav = pages.map(k => `<a href="#${k}"${k === key ? ' aria-current="page"' : ''}>${navItems[k]}</a>`).join('');
  if (nextNav !== nav.innerHTML) nav.innerHTML = nextNav;
  const top = document.querySelector('#top-actions');
  const unread = me?.settings.alerts && data.alerts.some(alert => !alert.read);
  const nextTop = me ? `<button class="icon-button" aria-label="Уведомления${unread ? ', есть новые' : ''}" data-open="alerts">${icon('bell')}${unread ? '<span class="notice-dot"></span>' : ''}</button>
    <a class="icon-button" href="#profile" aria-label="Мой профиль"${key === 'profile' ? ' aria-current="page"' : ''}>${icon('user')}</a>` :
    button('Демо ↗', 'login', '', 'ink');
  if (top.dataset.rendered !== nextTop) {
    top.innerHTML = nextTop;
    top.dataset.rendered = nextTop;
  }
  if (options.background && document.activeElement?.closest('#message-form')) {
    const chat = route() === 'chats' && byId(data.chats, selectedChat);
    const log = document.querySelector('#conversation');
    if (chat && log && log.innerHTML !== chatMessages(chat)) {
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 65;
      log.innerHTML = chatMessages(chat);
      if (nearBottom) log.scrollTop = log.scrollHeight;
    }
    return;
  }
  const active = document.activeElement;
  const focusId = active?.id;
  const focusData = active?.dataset;
  const html = renderers[key]();
  if (renderedMain !== html) {
    main.innerHTML = html;
    renderedMain = html;
    const log = document.querySelector('#conversation');
    if (log) log.scrollTop = log.scrollHeight;
    if (!options.route) {
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
      else if (focusData?.filter) [...main.querySelectorAll('[data-filter]')].find(
        node => node.dataset.filter === focusData.filter && node.dataset.value === focusData.value)?.focus({ preventScroll: true });
      else if (focusData?.open) [...main.querySelectorAll('[data-open]')].find(
        node => node.dataset.open === focusData.open && node.dataset.id === focusData.id)?.focus({ preventScroll: true });
    }
  }
  document.title = key === 'home' ? 'Спектр — от Искры до Спектра' : navItems[key] + ' — Спектр';
}

function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
}

function online(ok) {
  connection.hidden = ok;
  connection.innerHTML = ok ? '' : `Сервер временно недоступен. ${button('Повторить', 'retry')}`;
}

async function api(path, body) {
  return window.spektrPreview.request(path, body);
}


async function refresh(background = false) {
  const sequence = ++requestSequence;
  try {
    const next = await api('state');
    if (sequence !== requestSequence) return;
    data = next;
    loading = false;
    online(true);
    render({ background });
  } catch {
    if (sequence !== requestSequence) return;
    loading = false;
    online(false);
    render({ background });
  }
}

async function sync() {
  if (document.hidden) return;
  try {
    const result = await api('revision');
    if (data.revision !== result.revision || (data.me?.id || null) !== result.user || !connection.hidden) await refresh(true);
  } catch {
    online(false);
  }
}

function open(title, content, submit = null) {
  document.querySelector('#dialog-title').textContent = title;
  dialogContent.innerHTML = content;
  submitHandler = submit;
  if (!dialog.open) dialog.showModal();
  const initial = dialogContent.querySelector('input,select,textarea');
  (initial || document.querySelector('#close-dialog')).focus();
}

function form(title, fields, submit, label = 'Сохранить', note = '', extra = '') {
  open(title, `<form id="dialog-form">${note ? `<p class="muted">${esc(note)}</p>` : ''}
    <p class="form-error" role="alert"></p>${fields}<button class="button ink" type="submit">${esc(label)}</button></form>${extra}`, submit);
}

function input(name, label, value = '', options = {}) {
  const { type = 'text', required = true, max = 160, min, maxValue, autocomplete } = options;
  return `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}"
    ${required ? 'required' : ''} ${min != null ? 'min="' + min + '"' : ''} ${maxValue != null ? 'max="' + maxValue + '"' : ''}
    ${autocomplete ? 'autocomplete="' + autocomplete + '"' : ''}></label>`;
}

function textarea(name, label, value = '', required = true, max = 4000) {
  return `<label class="field">${esc(label)}<textarea name="${name}" maxlength="${max}" ${required ? 'required' : ''}>${esc(value)}</textarea></label>`;
}

function select(name, label, options, value = '', { multiple = false, required = true, placeholder = 'Выбери вариант' } = {}) {
  return `<label class="field">${esc(label)}<select name="${name}" ${multiple ? 'multiple' : ''} ${required ? 'required' : ''}>
    ${multiple ? '' : `<option value="">${esc(placeholder)}</option>`}
    ${Object.entries(options).map(([key, text]) => `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}
    </select></label>`;
}

const checkbox = (name, label, checked = false) => `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}>${esc(label)}</label>`;
const optional = { required:false };
const imageField = (value = '') => input('image', 'Ссылка на изображение', value, { type:'url', required:false, max:1500 });
const numField = (name, label, value = '', min = 1, required = true) => input(name, label, value, { type:'number', min, required });
const profileOptions = (membersOnly = false) => Object.fromEntries((data.people || []).filter(p => p.id !== data.me?.id &&
  (!membersOnly || p.role === 'member')).map(p => [p.id, p.name]));
const fromForm = fd => Object.fromEntries(fd);

async function change(action, fields, message, { close = true, rerender = true } = {}) {
  const actor = data.me?.id;
  const signature = JSON.stringify({ action, ...fields });
  const requestId = pendingRetry?.actor === actor && pendingRetry.signature === signature
    ? pendingRetry.requestId
    : (globalThis.crypto.randomUUID?.() || globalThis.crypto.getRandomValues(new Uint8Array(18))
      .reduce((result, number) => result + number.toString(16).padStart(2, '0'), ''));
  let result;
  try {
    result = await api('action', { action, requestId, ...fields });
  } catch (error) {
    if (error.retryable) pendingRetry = { actor, signature, requestId };
    throw error;
  }
  if (pendingRetry?.requestId === requestId) pendingRetry = null;
  if (close) dialog.close();
  if (rerender) await refresh();
  if (message) toast(message);
  return result.result;
}

function auth() {
  open('Выбрать роль', '<p class="muted">Открой тестовый кабинет участника, специалиста, модератора или владельца.</p><div class="divider"></div>' + actions(...Object.entries(roleNames).map(([role, name]) => button(name, 'demo', role))));
}

function eventForm(id) {
  const event = byId(data.events, id);
  const fields = input('title', 'Название', event?.title) + `<div class="split">${input('date', 'Дата', event?.date, { type:'date' })}
    ${input('time', 'Время', event?.time, { type:'time' })}</div>` +
    input('place', 'Место', event?.place || 'ЦП «Спектр»', { max:180 }) + textarea('description', 'Описание', event?.description) +
    input('speaker', 'Имя спикера', event?.speaker, { ...optional, max:100 }) +
    select('speakerId', 'Или спикер из пользователей', profileOptions(), event?.speakerId, { required:false, placeholder:'Не выбран' }) +
    imageField(event?.image) + (!id && editable() ? checkbox('news', 'Опубликовать также в новостях') : '');
  form(id ? 'Изменить событие' : 'Новое событие', fields,
    fd => change('event', { ...fromForm(fd), id, news:fd.has('news') }, id ? 'Изменения сохранены.' : editable() ? 'Событие опубликовано.' : 'Событие отправлено на модерацию.'),
    id ? 'Сохранить' : editable() ? 'Опубликовать' : 'Отправить на модерацию');
}

function taskForm(id) {
  const task = byId(data.tasks, id);
  const archive = task ? `<div class="divider"></div>${button(task.archived ? 'Вернуть из архива' : 'Перенести в архив', 'archiveTask', task.id)}` : '';
  const fields = input('title', 'Название', task?.title) + textarea('summary', 'Краткое описание', task?.summary, true, 280) +
    textarea('description', 'Условия выполнения', task?.description) + select('difficulty', 'Сложность', levels, task?.difficulty || 'easy') +
    numField('points', 'Награда в СК', task?.points) + numField('capacity', 'Количество мест для средних и сложных заданий', task?.capacity || 1) +
    input('awarder', 'Кто начисляет баллы', task?.awarder || 'Команда «Спектра»') + checkbox('once', 'Простое задание выполняется один раз', task?.once);
  form(id ? 'Изменить задание' : 'Новое задание', fields,
    fd => change('task', { ...fromForm(fd), id, once:fd.has('once') }, 'Задание сохранено.'), id ? 'Сохранить' : 'Опубликовать', '', archive);
}

function giftForm(id) {
  const gift = byId(data.gifts, id);
  const archive = gift ? `<div class="divider"></div>${button(gift.archived ? 'Вернуть из архива' : 'Перенести в архив', 'archiveGift', gift.id)}` : '';
  form(id ? 'Изменить награду' : 'Новая награда', input('title', 'Название', gift?.title) +
    textarea('description', 'Описание', gift?.description, true, 3000) + select('category', 'Категория', categories, gift?.category) +
    `<div class="split">${numField('price', 'Стоимость в СК', gift?.price)}${numField('stock', 'Количество', gift?.stock, 0)}</div>` +
    imageField(gift?.image), fd => change('gift', { ...fromForm(fd), id }, 'Награда сохранена.'), id ? 'Сохранить' : 'Опубликовать', '', archive);
}

function newsForm(id) {
  const post = byId(data.news, id);
  form(id ? 'Изменить новость' : 'Новая новость', input('title', 'Заголовок', post?.title) +
    textarea('description', 'Текст новости', post?.description, true, 6000) + imageField(post?.image) +
    input('video', 'HTTPS-ссылка на видеофайл', post?.video, { type:'url', required:false, max:1500 }),
  fd => change('news', { ...fromForm(fd), id }, 'Новость сохранена.'), id ? 'Сохранить' : 'Опубликовать');
}

function detailsImage(item) {
  return item.image ? `<img class="detail-img" src="${esc(item.image)}" alt="">` : '';
}

function eventDetail(id) {
  const event = byId(data.events, id);
  if (!event) return;
  const info = `<div class="stack">${detailsImage(event)}<p class="pill sun">${prettyDate(event.date)} · ${esc(event.time)}</p>
    <p>${esc(event.place)}${event.speaker ? ' · Спикер: ' + esc(event.speaker) : ''}</p><p>${esc(event.description)}</p></div>`;
  if (data.me?.role === 'member') {
    form(event.title, select('response', 'Пойдёшь на событие?', responses, event.response),
      fd => change('rsvp', { id, response:fd.get('response') }, 'Ответ сохранён.'), 'Сохранить ответ');
    dialogContent.insertAdjacentHTML('afterbegin', info + '<div class="divider"></div>');
  } else open(event.title, info + (!data.me ? `<div class="divider"></div>${button('Войти, чтобы ответить', 'login')}` : ''));
}

function taskDetail(id) {
  const task = byId(data.tasks, id);
  if (!task) return;
  const booking = data.bookings?.filter(b => b.taskId === id && b.userId === data.me?.id && b.status !== 'expired').at(-1);
  const detail = `<div class="stack">${pill(levels[task.difficulty])} <span>+${task.points} СК</span>
    <p>${esc(task.description)}</p><p class="muted">Начисляет баллы · ${esc(task.awarder)}</p>
    ${booking ? `<p>${statuses[booking.status]}${booking.status === 'reserved' ? ' · до ' + timeStamp(booking.expires) : ''}</p>` : ''}</div>`;
  if (data.me?.role === 'member' && !task.archived && task.difficulty !== 'easy' && !booking && task.available > 0) {
    form(task.title, '', () => change('bookTask', { id }, 'Бронь создана на 24 часа.'), 'Забронировать',
      'Свяжись с командой «Спектра» в течение 24 часов, чтобы подтвердить бронь.');
    dialogContent.insertAdjacentHTML('afterbegin', detail + '<div class="divider"></div>');
  } else open(task.title, detail);
}

function giftDetail(id) {
  const gift = byId(data.gifts, id);
  if (!gift) return;
  const detail = `<div class="stack">${detailsImage(gift)}<p>${esc(gift.description)}</p>
    ${pill(gift.price + ' СК', 'sun')}<p class="muted">${gift.archived || !gift.stock ? 'Награда недоступна' : 'В наличии: ' + gift.stock}</p></div>`;
  if (data.me?.role === 'member' && !gift.archived && gift.stock) {
    if (data.me.balance < gift.price) return open(gift.title, detail + '<p class="muted">На балансе пока недостаточно Спектр-коинов.</p>');
    form(gift.title, '', () => change('redeem', { id }, 'Награда забронирована.'), 'Забронировать',
      'Спектр-коины спишутся с баланса. Забрать награду можно у команды пространства.');
    dialogContent.insertAdjacentHTML('afterbegin', detail + '<div class="divider"></div>');
  } else open(gift.title, detail + (!data.me ? `<div class="divider"></div>${button('Войти', 'login')}` : ''));
}

function newsDetail(id) {
  const post = byId(data.news, id);
  if (!post) return;
  const detail = `<div class="stack">${detailsImage(post)}<p>${esc(post.description)}</p>
    ${post.video ? `<video controls preload="metadata" src="${esc(post.video)}"></video>` : ''}
    ${data.me ? button((post.liked ? 'Убрать реакцию' : 'Нравится') + ' · ' + post.likeCount, 'like', id) : ''}
    <div class="rows">${post.comments.map(c => row(c.name || person(c.author), c.text)).join('')}</div></div>`;
  if (data.me) {
    form(post.title, textarea('text', 'Комментарий', '', true, 1000), async fd => {
      await change('comment', { id, text:fd.get('text') }, 'Комментарий добавлен.', { close:false });
      newsDetail(id);
    }, 'Отправить');
    dialogContent.insertAdjacentHTML('afterbegin', detail + '<div class="divider"></div>');
  } else open(post.title, detail);
}

function reviewRequest(id) {
  const request = byId(data.requests, id);
  if (!request) return;
  const context = `<div class="stack"><p><strong>${esc(person(request.author))}</strong></p><p>${esc(request.description)}</p>
    ${request.organizer ? '<p>Организатор · ' + esc(request.organizer) + '</p><p>Контакт · ' + esc(request.contact) + '</p>' : ''}
    ${request.type !== 'role' ? button('Написать автору', 'direct', request.author) : ''}</div>`;
  form(request.title, select('status', 'Решение', { approved:'Одобрить', rejected:'Отклонить' }),
    fd => change('reviewRequest', { id, status:fd.get('status') }, 'Решение сохранено.'), 'Сохранить решение');
  dialogContent.insertAdjacentHTML('afterbegin', context + '<div class="divider"></div>');
}

function reviewEvent(id) {
  const event = byId(data.inReview, id);
  if (!event) return;
  form(event.title, select('status', 'Решение', { approved:'Опубликовать', rejected:'Отклонить' }) +
    checkbox('news', 'При публикации добавить в новости'),
    fd => change('reviewEvent', { id, status:fd.get('status'), news:fd.has('news') }, 'Решение сохранено.'), 'Сохранить решение');
  dialogContent.insertAdjacentHTML('afterbegin', `<div class="stack">${detailsImage(event)}<p>${esc(person(event.author))}
    · ${prettyDate(event.date)} · ${esc(event.time)}</p><p>${esc(event.place)}${event.speaker ? ' · ' + esc(event.speaker) : ''}</p>
    <p>${esc(event.description)}</p></div><div class="divider"></div>`);
}

function chatForm(group) {
  const people = profileOptions();
  if (!Object.keys(people).length) return open('Сообщения', empty('Другие пользователи пока не зарегистрированы.'));
  form(group ? 'Новая группа' : 'Написать сообщение',
    (group ? input('title', 'Название группы', '', { max:120 }) : '') +
    select('members', group ? 'Участники группы' : 'Собеседник', people, '', { multiple:group }),
    fd => openChat({ group, title:fd.get('title'), members:fd.getAll('members') }),
    'Открыть чат', group ? 'Чтобы выбрать несколько человек на компьютере, удерживай Ctrl или Command.' : '');
}

async function openChat(body) {
  const chat = await change('chat', body, '');
  selectedChat = chat.id;
  if (route() === 'chats') render();
  else location.hash = 'chats';
}

function profileForm() {
  const me = data.me;
  form('Редактировать профиль', `<div class="split">${input('first', 'Имя', me.first, { max:80 })}
    ${input('last', 'Фамилия', me.last, { ...optional, max:80 })}</div>` +
    input('email', 'Почта', me.email, { type:'email', max:254 }) + input('phone', 'Телефон', me.phone, { type:'tel', required:false, max:50 }) +
    input('birthday', 'Дата рождения', me.birthday, { type:'date', required:false }) +
    input('photo', 'Ссылка на фото', me.photo, { type:'url', required:false, max:1500 }) +
    input('title', isStaff() ? 'Должность' : 'Статус', me.title, { ...optional, max:100 }) +
    textarea('about', 'О себе', me.about, false, 500), fd => change('profile', fromForm(fd), 'Профиль сохранён.'));
}

function settingsForm() {
  const settings = data.me.settings;
  form('Настройки', checkbox('alerts', 'Отмечать новые уведомления', settings.alerts) +
    checkbox('email', 'Получать рассылку по почте', settings.email) +
    select('theme', 'Тема', { light:'Светлая', dark:'Тёмная' }, settings.theme),
    fd => change('settings', { alerts:fd.has('alerts'), email:fd.has('email'), theme:fd.get('theme') }, 'Настройки сохранены.'),
    'Сохранить', 'Настройка рассылки сохраняется в профиле. Отправка писем станет доступна после подключения рассылки.',
    `<div class="divider"></div>${actions(button('На главный экран', 'install'), button('Выйти', 'logout'),
      data.me.role !== 'owner' ? button('Удалить профиль', 'deleteAccount') : '')}`);
}

function rankDetail() {
  const cfg = data.ranks;
  const me = data.me;
  const requirement = (count, unit, current) => count ? unit + ' · ' + (me?.role === 'member' ? current + ' из ' : '') + count : unit + ' · порог уточняется';
  const content = ['Регистрация и первое посещение события.',
    requirement(cfg.easy, 'Простые задания', me?.counts.easy), requirement(cfg.earned, 'Заработано СК', me?.earned),
    requirement(cfg.medium, 'Средние задания', me?.counts.medium), requirement(cfg.hard, 'Сложные задания', me?.counts.hard),
    'Помочь пяти новичкам достичь ранга «Люминофор»' + (me?.role === 'member' ? ' · ' + (me.mentored?.length || 0) + ' из 5' : '')];
  open('Условия рангов', `<div class="rows">${content.map((rule, i) => row(data.rankNames[i], rule)).join('')}</div>`);
}

function alertDetail() {
  const alerts = data.alerts;
  open('Уведомления', `<div class="stack"><div class="rows">${list(alerts, a => row(a.text, timeStamp(a.createdAt) + (a.read ? '' : ' · Новое')),
    'Уведомлений пока нет.')}</div>${alerts.some(a => !a.read) ? button('Прочитать все', 'alertsRead') : ''}</div>`);
}

function pointForm(kind) {
  const award = kind === 'award';
  form(award ? 'Начислить Спектр-коины' : 'Назначить штраф',
    select('userId', 'Участник', profileOptions(true)) + (award ? numField('amount', 'Количество СК') : '') +
    textarea('reason', 'Причина', '', true, 300) + (award ? checkbox('attended', 'Отметить посещение пространства') : ''),
    fd => change(kind, { ...fromForm(fd), attended:fd.has('attended') }, award ? 'Баллы начислены.' : 'Штраф назначен.'),
    award ? 'Начислить' : 'Списать 5%', award ? '' : 'Спишется 5% текущего баланса с округлением вниз.');
}

function completeForm(bookingId) {
  const booking = byId(data.bookings, bookingId);
  const opts = Object.fromEntries(data.tasks.filter(t => !t.archived).map(t => [t.id, t.title]));
  form('Отметить выполнение', (booking ? '' : select('userId', 'Участник', profileOptions(true)) + select('taskId', 'Задание', opts)) +
    checkbox('attended', 'Отметить посещение пространства'),
    fd => change('completeTask', { userId:booking?.userId || fd.get('userId'), taskId:booking?.taskId || fd.get('taskId'),
      attended:fd.has('attended') }, 'Выполнение отмечено, баллы начислены.'), 'Начислить',
    booking ? person(booking.userId) : 'Для среднего или сложного задания нужна подтверждённая бронь.');
}

function confirm(title, label, description, action, fields, message) {
  form(title, '', () => change(action, fields, message), label, description);
}

async function handleOpen(key, id) {
  switch (key) {
    case 'login':
    case 'register': return auth(key);
    case 'retry': return refresh();
    case 'demo':
      await api('demo', { role:id });
      dialog.close();
      await refresh();
      return toast('Открыт демо-аккаунт.');
    case 'logout':
      await api('logout', {});
      dialog.close();
      selectedChat = '';
      data = defaultState;
      location.hash = 'home';
      return refresh();
    case 'event': return eventForm(id);
    case 'eventDetail': return eventDetail(id);
    case 'task': return taskForm(id);
    case 'taskDetail': return taskDetail(id);
    case 'gift': return giftForm(id);
    case 'giftDetail': return giftDetail(id);
    case 'news': return newsForm(id);
    case 'newsDetail': return newsDetail(id);
    case 'like': await change('like', { id }, '', { close:false }); return newsDetail(id);
    case 'profile': return profileForm();
    case 'settings': return settingsForm();
    case 'ranks': return rankDetail();
    case 'burn': return open('Сгорание баллов', `<div class="stack"><p>После 90 дней без начислений баланс уменьшается на 20% каждые 30 дней.
      Через 240 дней без начислений остаток обнуляется.</p><p>31 августа в начале дня по Новосибирску проходит сезонный сброс.</p>
      <p>За нарушение правил пространства команда может списать 5% баланса.</p></div>`);
    case 'alerts': return alertDetail();
    case 'alertsRead': await change('alertsRead', {}, '', { close:false }); return alertDetail();
    case 'idea': return form('Предложить идею', input('title', 'Название идеи') + textarea('description', 'Описание', '', true, 3000) +
      input('organizer', 'ФИО организатора') + input('contact', 'Телефон или почта организатора'),
      fd => change('idea', fromForm(fd), 'Идея отправлена команде.'), 'Отправить');
    case 'roleRequest': return form('Заявка в модераторы', textarea('description', 'Почему хочешь стать модератором?', '', true, 3000),
      fd => change('roleRequest', fromForm(fd), 'Заявка отправлена владельцу.'), 'Отправить');
    case 'support':
      if (!data.me) return auth('login');
      return form('Поддержка', input('title', 'Тема') + textarea('description', 'Что произошло?', '', true, 3000),
        fd => change('support', fromForm(fd), 'Обращение отправлено.'), 'Отправить');
    case 'reviewEvent': return reviewEvent(id);
    case 'reviewRequest': return reviewRequest(id);
    case 'archiveGift':
    case 'archiveTask': {
      const type = key === 'archiveGift' ? 'gifts' : 'tasks';
      const item = byId(data[type], id);
      const label = item.archived ? 'Вернуть из архива' : 'Перенести в архив';
      return confirm(item.title, label, '', 'archive', { type, id, archived:!item.archived }, 'Статус изменён.');
    }
    case 'reviewRedemption': {
      const item = byId(data.redemptions, id);
      return form(item.title, select('status', 'Решение', { collected:'Награда выдана', cancelled:'Отменить и вернуть баллы' }),
        fd => change('reviewRedemption', { id, status:fd.get('status') }, 'Решение сохранено.'), 'Сохранить', person(item.userId));
    }
    case 'confirmTask': {
      const booking = byId(data.bookings, id);
      return confirm('Подтвердить бронь', 'Подтвердить', person(booking.userId), 'confirmTask',
        { userId:booking.userId, taskId:booking.taskId }, 'Бронь подтверждена.');
    }
    case 'award':
    case 'penalty': return pointForm(key);
    case 'completeTask':
    case 'bookingComplete': return completeForm(id);
    case 'role': {
      const user = byId(data.directory, id);
      const roles = { ...roleNames };
      delete roles.owner;
      return form(user.name, select('role', 'Роль', roles, user.role),
        fd => change('role', { id, role:fd.get('role') }, 'Роль сохранена.'));
    }
    case 'rankSettings': return form('Пороги рангов', numField('easy', 'Простые задания для Инфракрасного', data.ranks.easy, 1, false) +
      numField('earned', 'Заработано СК для Люминофора', data.ranks.earned, 1, false) +
      numField('medium', 'Средние задания для Лазера', data.ranks.medium, 1, false) +
      numField('hard', 'Сложные задания для Ультрафиолета', data.ranks.hard, 1, false),
      fd => change('rankSettings', fromForm(fd), 'Пороги сохранены.'), 'Сохранить', 'Оставь поле пустым, если порог ещё обсуждается.');
    case 'transfer': return form('Передать управление',
      select('id', 'Новый владелец', Object.fromEntries(data.directory.filter(u => u.role === 'moderator').map(u => [u.id, u.name]))) +
      checkbox('confirm', 'Подтверждаю передачу управления'),
      fd => {
        if (!fd.has('confirm')) throw new Error('Подтверди передачу управления.');
        return change('transfer', { id:fd.get('id') }, 'Управление передано.');
      }, 'Передать', 'После передачи твоя роль изменится на «Модератор».');
    case 'mentor': return form('Зачесть наставничество', select('userId', 'Наставник', profileOptions(true)) +
      select('menteeId', 'Подопечный', profileOptions(true)), fd => change('mentor', fromForm(fd), 'Наставничество зачтено.'));
    case 'chat': return chatForm(false);
    case 'group': return chatForm(true);
    case 'direct': return openChat({ group:false, members:[id] });
    case 'chatChoose':
      selectedChat = id;
      render();
      document.querySelector('#message-form textarea')?.focus({ preventScroll:true });
      return;
    case 'deleteAccount': return form('Удалить профиль', input('confirm', 'Введи слово «Удалить»'),
      async fd => {
        await change('deleteAccount', fromForm(fd), 'Профиль удалён.');
        location.hash = 'home';
      }, 'Удалить профиль', 'Аккаунт, баллы и личные результаты будут удалены без восстановления.');
    case 'install':
      if (installPrompt) {
        await installPrompt.prompt();
        installPrompt = null;
        return;
      }
      return open('На главный экран', '<p>Открой меню браузера и выбери «Установить приложение» или «На экран Домой».</p>');
  }
}

document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { if (!dialog.open) submitHandler = null; });

document.addEventListener('click', async event => {
  if (openedAsFile) return;
  const trigger = event.target.closest('[data-open]');
  const filter = event.target.closest('[data-filter]');
  if (trigger) {
    try {
      await handleOpen(trigger.dataset.open, trigger.dataset.id || '');
    } catch (error) {
      toast(error.message);
    }
  }
  if (filter) {
    const { filter: group, value } = filter.dataset;
    if (group === 'difficulty') difficultyFilter = value;
    if (group === 'market') marketFilter = value;
    if (group === 'calendar') calendarMode = value;
    if (group === 'day') selectedDay = selectedDay === value ? '' : value;
    render();
  }
});

main.addEventListener('change', event => {
  if (event.target.id !== 'month') return;
  if (!/^\d{4}-\d{2}$/.test(event.target.value)) {
    event.target.value = month;
    return;
  }
  month = event.target.value;
  selectedDay = '';
  render();
});

main.addEventListener('focusout', () => {
  setTimeout(() => { if (!main.contains(document.activeElement)) render(); }, 0);
});

function fileData(file) {
  if (!file?.size) return Promise.resolve('');
  if (file.size > 6 * 1024 * 1024) return Promise.reject(new Error('Файл весит больше 6 МБ.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Файл не удалось прочитать.'));
    reader.readAsDataURL(file);
  });
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['dialog-form', 'message-form'].includes(form.id)) return;
  event.preventDefault();
  const fd = new FormData(form);
  const errorLine = form.querySelector('.form-error');
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  submit.disabled = true;
  errorLine.textContent = '';
  try {
    if (form.id === 'dialog-form') await submitHandler?.(fd);
    else {
      await change('message', { id:selectedChat, text:fd.get('text'), media:await fileData(fd.get('file')) }, '', { close:false });
      form.reset();
      document.querySelector('#message-form textarea')?.focus({ preventScroll:true });
    }
  } catch (error) {
    errorLine.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#main') {
    main.focus();
    return;
  }
  if (openedAsFile) return;
  if (dialog.open) dialog.close();
  render({ route:true });
  window.scrollTo(0, 0);
  main.focus({ preventScroll:true });
  if (data.revision !== -1) void sync();
});
if (openedAsFile) {
  document.body.classList.add('file-preview');
  document.querySelector('#file-notice').hidden = false;
} else {
  window.addEventListener('online', () => { void refresh(true); });
  document.addEventListener('visibilitychange', () => { void sync(); });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  setInterval(() => { void sync(); }, 5000);
  render();
  void refresh();
}
