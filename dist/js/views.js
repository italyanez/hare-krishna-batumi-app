// Разметка экранов и шторок. Только чистые функции: данные → HTML-строка.
import { icon } from './icons.js?v=5';
import {
  STATUS, addDays, buildEvents, effectiveStatus, isLive, relativeDay, timeRange,
  formatDayMonth, formatWeekdayShort, dayNumber, formatMonthShort,
} from './schedule.js?v=5';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ext = (url, label, cls = 'button button--secondary') =>
  `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" data-link>${label}</a>`;
const tme = handle => `https://t.me/${handle}`;
const pageHead = (title, lead) => `<header class="page-head"><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</header>`;
const sectionHead = (title, extra = '') => `<div class="section-head"><h2>${title}</h2>${extra}</div>`;

export const mapsUrl = (query, provider = 'google') => provider === 'yandex'
  ? `https://yandex.com/maps/?text=${encodeURIComponent(query)}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

/* ---------- События ---------- */

const HORIZON = 14; // дней вперёд

export function upcoming(ctx, days = HORIZON) {
  return buildEvents(ctx.content, { from: ctx.now.date, to: addDays(ctx.now.date, days) })
    .map(e => ({ ...e, state: effectiveStatus(e, ctx.now), live: isLive(e, ctx.now) }))
    .filter(e => e.state && (e.state !== 'completed' || e.date === ctx.now.date));
}

export function recent(ctx, days = 14) {
  const from = addDays(ctx.now.date, -days);
  return ctx.content.events
    .filter(e => e.date >= from && e.date <= ctx.now.date)
    .map(e => ({ ...e, state: effectiveStatus(e, ctx.now) }))
    .filter(e => e.state === 'completed' || (e.date < ctx.now.date && ['cancelled', 'moved'].includes(e.state)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function findEvent(ctx, id) {
  const all = buildEvents(ctx.content, { from: addDays(ctx.now.date, -60), to: addDays(ctx.now.date, 60) });
  const e = all.find(x => x.id === id);
  return e && { ...e, state: effectiveStatus(e, ctx.now) || 'completed', live: isLive(e, ctx.now) };
}

const statusChip = (state, live) => live
  ? '<span class="chip chip--live"><span class="pulse" aria-hidden="true"></span>Идёт сейчас</span>'
  : `<span class="chip chip--${state}">${STATUS[state].label}</span>`;

function eventRow(e, ctx, { showDate = false } = {}) {
  const place = ctx.content.places[e.place];
  const off = e.state === 'cancelled' || e.state === 'moved';
  return `<button class="event ${off ? 'is-off' : ''}" type="button" data-event="${esc(e.id)}">
    ${showDate
      ? `<span class="event-date"><b>${dayNumber(e.date)}</b>${esc(formatMonthShort(e.date))}</span>`
      : `<span class="event-time">${esc(e.start)}</span>`}
    <span class="event-main">
      <span class="event-title">${esc(e.title)}</span>
      <span class="event-meta">${showDate ? `${esc(formatWeekdayShort(e.date))}, ${esc(e.start)} · ` : ''}${esc(place?.name || '')}</span>
      ${off && e.note ? `<span class="event-note event-note--${e.state}">${esc(e.note)}</span>` : ''}
      <span class="event-tags">${statusChip(e.state, e.live)}${e.guest && !off ? `<span class="chip chip--guest">${icon('star')}${esc(e.guest)}</span>` : ''}</span>
    </span>
    ${icon('chevron', 'event-chevron')}
  </button>`;
}

function groupByDay(events) {
  const map = new Map();
  for (const e of events) map.set(e.date, [...(map.get(e.date) || []), e]);
  return [...map];
}

/* ---------- Главная ---------- */

export function homeView(ctx) {
  const list = upcoming(ctx);
  const todayAll = list.filter(e => e.date === ctx.now.date);
  const next = list.filter(e => e.date > ctx.now.date && e.state !== 'cancelled');
  const firstNext = next[0];
  const methods = ctx.content.donations.methods;

  return `
  <h1 class="sr-only">Храм Харе Кришна в Батуми</h1>
  <section class="today card">
    <p class="overline">${esc(relativeDay(ctx.now.date, ctx.now.date))}</p>
    ${todayAll.length
      ? `<div class="event-list">${todayAll.map(e => eventRow(e, ctx)).join('')}</div>`
      : '<p class="empty-line">Сегодня программ в храме нет.</p>'}
    ${firstNext ? `<div class="today-next">
        <p class="overline">Ближайшая программа · ${esc(relativeDay(firstNext.date, ctx.now.date))}</p>
        <div class="event-list">${eventRow(firstNext, ctx)}</div>
      </div>` : ''}
  </section>

  <nav class="quick" aria-label="Быстрые действия">
    <a class="quick-item quick-item--accent" href="#donate">${icon('heart')}<span>Пожертвовать</span></a>
    <a class="quick-item" href="${esc(mapsUrl(ctx.content.places.temple.query))}" target="_blank" rel="noopener" data-link>${icon('pin')}<span>Маршрут</span></a>
    <a class="quick-item" href="#temple/contacts">${icon('chat')}<span>Задать вопрос</span></a>
    <a class="quick-item" href="#records">${icon('play')}<span>Лекции</span></a>
  </nav>

  <section class="section">
    ${sectionHead('Ближайшие дни', '<a class="text-link" href="#schedule">Всё расписание</a>')}
    ${next.length > 1
      ? `<div class="card card--flush event-list">${next.slice(1, 6).map(e => eventRow(e, ctx, { showDate: true })).join('')}</div>`
      : '<p class="muted">Новых анонсов пока нет — следите за каналом храма.</p>'}
  </section>

  <section class="section donate-strip card">
    <div class="donate-strip-text">
      <h2>Храм живёт на пожертвования</h2>
      <p class="muted">Аренда, прасад, цветы и программы. Выберите удобный способ — реквизиты копируются одним касанием.</p>
    </div>
    <div class="donate-strip-methods">
      ${methods.map(m => `<a class="method-link" href="#donate/${esc(m.id)}">${icon(methodIcon(m.id))}<span><b>${esc(m.title)}</b><small>${esc(shortSubtitle(m))}</small></span>${icon('chevron')}</a>`).join('')}
    </div>
  </section>

  <a class="card link-card" href="#temple/first-visit">
    ${icon('temple')}
    <span><b>Впервые в храме?</b><small>Адрес, что происходит на программе, кому написать</small></span>
    ${icon('chevron')}
  </a>

  ${freshness(ctx)}`;
}

const methodIcon = id => ({ sber: 'phone', tbc: 'bank', usdt: 'coin' })[id] || 'heart';
const shortSubtitle = m => ({ sber: 'Из России', tbc: 'Грузия и SWIFT', usdt: 'Только TRC20' })[m.id] || m.subtitle;

function freshness(ctx) {
  const d = new Date(ctx.content.updatedAt);
  const when = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tbilisi', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
  return `<p class="freshness">${icon('info')}<span>Расписание обновлено ${esc(when)}. Срочные переносы и отмены сначала появляются в
    <a href="${esc(ctx.content.links.channel)}" target="_blank" rel="noopener" data-link>канале храма</a>.</span></p>`;
}

/* ---------- Расписание ---------- */

export function scheduleView(ctx, filter) {
  const cats = ctx.content.categories;
  const all = upcoming(ctx);
  const present = Object.keys(cats).filter(c => all.some(e => e.category === c));
  const list = filter ? all.filter(e => e.category === filter) : all;
  const past = recent(ctx);

  return `
  ${pageHead('Расписание', 'Ближайшие две недели. Время — по Батуми.')}
  <div class="chips" role="group" aria-label="Тип программы">
    <button class="filter" type="button" data-filter="" aria-pressed="${!filter}">Все</button>
    ${present.map(c => `<button class="filter" type="button" data-filter="${c}" aria-pressed="${filter === c}">${esc(cats[c])}</button>`).join('')}
  </div>

  ${list.length ? groupByDay(list).map(([day, items]) => `
    <section class="day">
      <h2 class="day-title">${esc(relativeDay(day, ctx.now.date))}</h2>
      <div class="card card--flush event-list">${items.map(e => eventRow(e, ctx)).join('')}</div>
    </section>`).join('') : '<p class="muted">В этой категории ближайших программ нет.</p>'}

  <aside class="callout">
    ${icon('megaphone')}
    <div><b>Харинамы и праздники объявляются в канале</b>
      <p>Обычно в день проведения. Включите уведомления канала, чтобы не пропустить перенос или отмену.</p>
      ${ext(ctx.content.links.channel, `${icon('send')}Открыть канал`, 'text-link')}
    </div>
  </aside>

  <section class="section">
    ${sectionHead('Обычная неделя')}
    <div class="card week">
      ${weekRows(ctx).map(([days, time, title, note]) => `
        <div class="week-row"><span class="week-days">${days}</span><span class="week-time">${time}</span>
        <span class="week-title">${title}${note ? `<small>${note}</small>` : ''}</span></div>`).join('')}
    </div>
    <p class="footnote">По сайту храма. Фактическое время иногда отличается — смотрите статус каждой программы.</p>
  </section>

  ${past.length ? `<details class="section disclosure">
    <summary><h2>Недавно прошло</h2>${icon('chevron', 'disclosure-icon')}</summary>
    <div class="card card--flush event-list">${past.map(e => eventRow(e, ctx, { showDate: true })).join('')}</div>
  </details>` : ''}`;
}

function weekRows(ctx) {
  const r = Object.fromEntries(ctx.content.regular.map(x => [x.id, x]));
  return [
    ['Вс', `${r.sunday.start}–${r.sunday.end}`, 'Воскресный пир любви', 'Киртан, чтение писаний, прасад'],
    ['Вт, Чт', r.tuesday.start, 'Прасад и киртан', 'Время уточняется'],
    ['Пн, Ср, Пт', r['yoga-mon'].start, 'Хатха-йога', 'Уточните, проходят ли занятия'],
  ];
}

/* ---------- Шторка события ---------- */

export function eventSheet(ctx, e) {
  const place = ctx.content.places[e.place];
  const moved = e.movedTo && findEvent(ctx, e.movedTo);
  const status = STATUS[e.state];
  return `
  ${ctx.content.categories[e.category] !== e.title ? `<p class="overline">${esc(ctx.content.categories[e.category] || '')}</p>` : ''}
  <h2 id="sheet-title" class="sheet-title">${esc(e.title)}</h2>
  <div class="status-box status-box--${e.live ? 'live' : e.state}">
    ${statusChip(e.state, e.live)}
    <p>${esc(e.note || status.hint)}</p>
    ${moved ? `<button class="text-link" type="button" data-event="${esc(moved.id)}">Перейти к программе ${esc(formatDayMonth(moved.date))} ${icon('chevron')}</button>` : ''}
  </div>

  <dl class="facts">
    <div>${icon('calendar')}<dt>Когда</dt><dd>${esc(relativeDay(e.date, ctx.now.date))}<br><span class="muted">${esc(timeRange(e))}</span></dd></div>
    ${place ? `<div>${icon('pin')}<dt>Где</dt><dd>${esc(place.name)}<br><span class="muted">${esc(place.address)}</span>
      <a class="text-link" href="${esc(mapsUrl(place.query))}" target="_blank" rel="noopener" data-link>Открыть на карте</a></dd></div>` : ''}
    ${e.guest ? `<div>${icon('star')}<dt>Гость</dt><dd>${esc(e.guest)}</dd></div>` : ''}
  </dl>

  ${e.program?.length ? `<h3 class="sheet-subtitle">Программа</h3>
    <ol class="timeline">${e.program.map(([t, what]) => `<li><time>${esc(t)}</time><span>${esc(what)}</span></li>`).join('')}</ol>
    ${e.generated ? '<p class="footnote">Обычный порядок программы по сайту храма. Точное время — в анонсе в канале.</p>' : ''}` : ''}

  <div class="sheet-actions">
    <button class="button button--primary" type="button" data-share="${esc(e.id)}">${icon('share')}Поделиться</button>
    ${ext(e.sources.at(-1) || ctx.content.links.channel, `${icon('send')}${e.sources.length > 1 ? 'Последнее сообщение в канале' : e.sources.length ? 'Анонс в канале' : 'Проверить в канале'}`)}
    ${e.sources.length > 1 ? `<p class="footnote sources">История: ${e.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener" data-link>${i ? 'обновление' : 'анонс'}</a>`).join(' → ')}</p>` : ''}
    <a class="button button--ghost" href="${esc(tme(ctx.content.contacts[0].handle))}" target="_blank" rel="noopener" data-link>${icon('chat')}Спросить @${esc(ctx.content.contacts[0].handle)}</a>
  </div>`;
}

/* ---------- Пожертвования ---------- */

const groupIban = v => v.replace(/(.{4})/g, '$1 ').trim();
const groupAddress = v => v.replace(/(.{4})/g, '$1 ').trim();

function field(f) {
  const shown = f.format === 'iban' ? groupIban(f.value) : f.format === 'address' ? groupAddress(f.value) : f.value;
  const raw = f.copy || f.value;
  return `<div class="field">
    <span class="field-label">${esc(f.label)}</span>
    <button class="field-value ${['iban', 'address'].includes(f.format) ? 'is-mono' : ''} ${f.format === 'phone' ? 'is-nowrap' : ''}" type="button" data-copy="${esc(raw)}" data-copy-label="${esc(f.label)}" aria-label="Скопировать: ${esc(f.label)} ${esc(raw)}">
      <span class="field-text">${esc(shown)}</span>
      <span class="copy-tag" aria-hidden="true">${icon('copy', 'copy-icon')}${icon('check', 'check-icon')}</span>
    </button>
  </div>`;
}

const allText = m => [m.title, ...m.fields.map(f => `${f.label}: ${f.copy || f.value}`), ...(m.extra?.fields || []).map(f => `${f.label}: ${f.value}`)].join('\n');

export function donateView(ctx, methodId) {
  const d = ctx.content.donations;
  const m = d.methods.find(x => x.id === methodId) || d.methods[0];
  const helper = ctx.content.contacts[0];
  return `
  ${pageHead('Поддержать храм', 'Храм в Батуми содержится на пожертвования прихожан. Выберите, откуда вам удобнее перевести.')}

  <div class="segmented" role="tablist" aria-label="Способ пожертвования">
    ${d.methods.map(x => `<button class="segment" type="button" role="tab" id="tab-${x.id}" aria-controls="panel-${x.id}" aria-selected="${x.id === m.id}" tabindex="${x.id === m.id ? 0 : -1}" data-method="${x.id}">
      ${icon(methodIcon(x.id))}<span>${esc(x.title)}</span></button>`).join('')}
  </div>

  <section class="card method" role="tabpanel" id="panel-${m.id}" aria-labelledby="tab-${m.id}">
    <header class="method-head">
      <h2>${esc(m.title)}</h2>
      <p class="muted">${esc(m.subtitle)}</p>
    </header>
    ${m.warning ? `<div class="warning">${icon('alert')}<div><b>Сеть: ${esc(m.network)}</b><p>${esc(m.warning)}</p></div></div>` : ''}
    <p class="hint">${icon('copy')}Нажмите на реквизит — он скопируется</p>
    <div class="fields">${m.fields.map(field).join('')}</div>
    ${m.extra ? `<details class="disclosure disclosure--inline">
        <summary><span>${esc(m.extra.title)}</span>${icon('chevron', 'disclosure-icon')}</summary>
        <div class="fields">${m.extra.fields.map(field).join('')}</div>
      </details>` : ''}
    ${m.fields.length + (m.extra?.fields.length || 0) > 1 ? `<button class="button button--secondary button--block" type="button" data-copy="${esc(allText(m))}" data-copy-label="Все реквизиты">${icon('copy')}Скопировать все реквизиты</button>` : ''}
    <ol class="steps">${m.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
  </section>

  <aside class="callout">
    ${icon('chat')}
    <div><b>Не получается перевести?</b>
      <p>Напишите в храм — подскажут другой способ. Пожертвования не отслеживаются автоматически: если хотите, чтобы перевод учли на конкретную цель, сообщите об этом.</p>
      ${ext(tme(helper.handle), `${icon('send')}Написать @${esc(helper.handle)}`, 'text-link')}
    </div>
  </aside>

  <section class="section">
    ${sectionHead('На что можно пожертвовать')}
    <ul class="card card--flush purposes">
      ${d.purposes.map(p => `<li><span><b>${esc(p.title)}</b><small>${esc(p.detail)}</small></span>${p.amount ? `<span class="amount">${esc(p.amount)}</span>` : ''}</li>`).join('')}
    </ul>
    <p class="footnote">Суммы — ориентиры с сайта храма.</p>
  </section>

  <a class="card link-card" href="${esc(ctx.content.links.financialReport.url)}" target="_blank" rel="noopener" data-link>
    ${icon('report')}
    <span><b>${esc(ctx.content.links.financialReport.title)}</b><small>Храм публикует отчёты о поступлениях и расходах в канале</small></span>
    ${icon('external')}
  </a>

  <p class="footnote">Реквизиты сверены с <a href="${esc(ctx.content.links.siteDonations)}" target="_blank" rel="noopener" data-link>сайтом храма</a> ${esc(formatDayMonth(d.verifiedAt))}.</p>`;
}

/* ---------- Служение ---------- */

export function serviceView(ctx) {
  return `
  ${pageHead('Служение', 'Выберите, чем хотите помочь, и напишите в храм — время и задачи договариваются лично.')}
  <div class="service-list">
    ${ctx.content.services.map(s => `
      <article class="card service">
        <h2>${esc(s.title)}</h2>
        <p class="service-when">${icon('clock')}${esc(s.when)}</p>
        <p>${esc(s.text)}</p>
        <button class="button button--secondary" type="button" data-service="${esc(s.id)}">Хочу помочь</button>
      </article>`).join('')}
  </div>`;
}

export function serviceSheet(ctx, s) {
  const c = ctx.content.contacts[0];
  return `
  <p class="overline">Служение</p>
  <h2 id="sheet-title" class="sheet-title">${esc(s.title)}</h2>
  <p>Напишите в Telegram контакту храма <b>@${esc(c.handle)}</b>. Можно отправить готовый текст:</p>
  <blockquote class="message">${esc(s.message)}</blockquote>
  <div class="sheet-actions">
    <button class="button button--primary" type="button" data-write="${esc(c.handle)}" data-copy="${esc(s.message)}">${icon('send')}Скопировать и написать</button>
  </div>
  <p class="footnote">Приложение не отправляет заявки само — сообщение пишете вы, и договариваетесь напрямую.</p>`;
}

/* ---------- Храм ---------- */

export function templeView(ctx) {
  const { places, contacts, links } = ctx.content;
  const t = places.temple;
  return `
  ${pageHead('Храм', 'Центр ведической культуры в Батуми. Вход на программы свободный.')}

  <section class="card address">
    <p class="overline">Адрес</p>
    <p class="address-line">Батуми, ${esc(t.address)}</p>
    <div class="button-row">
      ${ext(mapsUrl(t.query), `${icon('pin')}Google Карты`, 'button button--primary')}
      ${ext(mapsUrl(t.query, 'yandex'), 'Яндекс Карты')}
      <button class="button button--ghost" type="button" data-copy="Батуми, ${esc(t.address)}" data-copy-label="Адрес">${icon('copy')}Адрес</button>
    </div>
  </section>

  <section class="section" id="contacts">
    ${sectionHead('Кому написать')}
    <div class="contacts">
      ${contacts.map(c => `
      <article class="card contact">
        <div class="contact-head">${icon('user')}<div><h3>${esc(c.name)}</h3><p class="muted">${esc(c.role)}</p></div></div>
        <p class="contact-topics-label">С вопросами о:</p>
        <ul class="contact-topics">${c.topics.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${ext(tme(c.handle), `${icon('send')}Написать @${esc(c.handle)}`, 'button button--secondary button--block')}
      </article>`).join('')}
    </div>
  </section>

  <section class="section">
    ${sectionHead('Где следить за новостями')}
    <div class="card card--flush rows">
      ${row(links.channel, 'megaphone', 'Канал храма', 'Анонсы, переносы, трансляции, отчёты')}
      ${row(links.chat, 'chat', 'Чат сообщества', 'Общение с преданными')}
      <a class="row" href="#records">${icon('play')}<span><b>Лекции и трансляции</b><small>Записи и прямые эфиры</small></span>${icon('chevron')}</a>
      ${row(links.site, 'globe', 'Сайт храма', 'iskcone.com/batumi')}
    </div>
  </section>

  <section class="section" id="first-visit">
    ${sectionHead('Первый раз в храме')}
    <div class="card card--flush faq">
      ${faq('Можно прийти без подготовки?', 'Да. Воскресная программа открыта для всех, вход свободный. Перед визитом проверьте анонс в канале — время иногда меняется.')}
      ${faq('Что происходит на воскресной программе?', 'Обычно: киртан, чтение и обсуждение писаний — «Бхагавад-гиты», «Шримад-Бхагаватам», «Чайтанья-чаритамриты», — снова киртан и прасад.')}
      ${faq('Что такое киртан и прасад?', 'Киртан — совместное пение святых имён под музыку. Прасад — вегетарианская пища, предложенная Кришне, которой угощают всех после программы.')}
      ${faq('С кем связаться заранее?', `С контактом храма @${contacts[0].handle} — подскажет время и как найти вход.`)}
    </div>
  </section>`;
}

const row = (url, ic, title, sub) =>
  `<a class="row" href="${esc(url)}" target="_blank" rel="noopener" data-link>${icon(ic)}<span><b>${esc(title)}</b><small>${esc(sub)}</small></span>${icon('external')}</a>`;
const faq = (q, a) =>
  `<details class="faq-item"><summary>${esc(q)}${icon('chevron', 'disclosure-icon')}</summary><p>${esc(a)}</p></details>`;

/* ---------- Лекции и трансляции ---------- */

export function recordsView(ctx) {
  const { recordings, links } = ctx.content;
  return `
  <a class="back-link" href="#temple">${icon('chevron')}Храм</a>
  ${pageHead('Лекции и трансляции')}
  ${recordings.length ? `<div class="records">${recordings.map(r => `
      <a class="card record" href="${esc(r.url)}" target="_blank" rel="noopener" data-link>
        ${icon('play')}<span><b>${esc(r.title)}</b><small>${esc(r.speaker)} · ${esc(formatDayMonth(r.date))}</small></span>${icon('external')}
      </a>`).join('')}</div>`
    : `<section class="card empty">
        ${icon('play', 'empty-icon')}
        <h2>Архива записей пока нет</h2>
        <p class="muted">Когда лекции храма начнут публиковаться на YouTube, они появятся здесь.</p>
      </section>`}

  <section class="section">
    ${sectionHead('Прямые трансляции')}
    <div class="card">
      <p>Трансляции программ идут в Telegram-канале храма. Подпишитесь и включите уведомления, чтобы узнать о начале эфира.</p>
      <div class="button-row">
        ${ext(links.channel, `${icon('send')}Открыть канал`, 'button button--primary')}
        ${ext(links.lastBroadcast.url, 'Последняя трансляция')}
      </div>
      <p class="footnote">${esc(links.lastBroadcast.title)}</p>
    </div>
  </section>

  <aside class="callout">
    ${icon('hands')}
    <div><b>Поможете с записью?</b><p>Нужны люди, которые будут записывать и публиковать лекции.</p>
      <button class="text-link" type="button" data-service="recording">Предложить помощь</button></div>
  </aside>`;
}

/* ---------- Состояния ---------- */

export const errorView = channel => `
  <section class="card empty">
    ${icon('alert', 'empty-icon')}
    <h2>Не удалось загрузить данные</h2>
    <p class="muted">Проверьте интернет и попробуйте снова. Анонсы храма всегда есть в канале.</p>
    <div class="button-row button-row--center">
      <button class="button button--primary" type="button" data-action="retry">Повторить</button>
      ${ext(channel, 'Открыть канал')}
    </div>
  </section>`;

export const copyFallbackSheet = text => `
  <h2 id="sheet-title" class="sheet-title">Скопируйте вручную</h2>
  <p class="muted">Браузер не дал скопировать автоматически. Нажмите на текст и удерживайте, чтобы выделить.</p>
  <textarea class="copy-area" readonly rows="${Math.min(8, text.split('\n').length + 1)}">${esc(text)}</textarea>`;
