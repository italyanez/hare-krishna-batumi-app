// Разметка экранов и шторок. Только чистые функции: данные → HTML-строка.
import { icon } from './icons.js?v=18';
import {
  STATUS, addDays, buildEvents, effectiveStatus, isLive, relativeDay, timeRange, calendarUrl,
  formatDayMonth, formatWeekdayShort, dayNumber, formatMonthShort,
} from './schedule.js?v=18';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ext = (url, label, cls = 'button button--secondary') =>
  `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" data-link>${label}</a>`;
const tme = handle => `https://t.me/${handle}`;
const pageHead = (title, lead, extra = '') => `<header class="page-head"><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}${extra}</header>`;
const sectionHead = (title, extra = '') => `<div class="section-head"><h2>${title}</h2>${extra}</div>`;
const contactById = (ctx, id) => ctx.content.contacts.find(c => c.id === id) || ctx.content.contacts[0];
const isOff = e => e.state === 'cancelled' || e.state === 'moved';

export const mapsUrl = (query, provider = 'google') => provider === 'yandex'
  ? `https://yandex.com/maps/?text=${encodeURIComponent(query)}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

export const shareUrl = (url, text) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;

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
    .filter(e => e.state === 'completed' || (e.date < ctx.now.date && isOff(e)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function findEvent(ctx, id) {
  const all = buildEvents(ctx.content, { from: addDays(ctx.now.date, -60), to: addDays(ctx.now.date, 60) });
  const e = all.find(x => x.id === id);
  return e && { ...e, state: effectiveStatus(e, ctx.now) || 'completed', live: isLive(e, ctx.now) };
}

const statusChip = (state, live) => live
  ? '<span class="chip chip--live"><span class="pulse" aria-hidden="true"></span>Идёт сейчас</span>'
  : `<span class="chip chip--${STATUS[state].chip}">${state === 'confirmed' ? icon('check') : ''}${STATUS[state].label}</span>`;

function eventRow(e, ctx, { showDate = false } = {}) {
  const place = ctx.content.places[e.place];
  const off = isOff(e);
  return `<button class="event ${off ? 'is-off' : ''}" type="button" data-event="${esc(e.id)}">
    ${showDate
      ? `<span class="event-date"><b>${dayNumber(e.date)}</b>${esc(formatMonthShort(e.date))}</span>`
      : `<span class="event-time">${esc(e.start)}</span>`}
    <span class="event-main">
      <span class="event-title">${esc(e.title)}</span>
      <span class="event-meta">${showDate ? `${esc(formatWeekdayShort(e.date))}, ${esc(e.start)} · ` : ''}${esc(place?.name || '')}</span>
      ${off && e.note ? `<span class="event-note event-note--${e.state}">${esc(e.note)}</span>` : ''}
      <span class="event-tags">${showDate && STATUS[e.state].chip === 'regular' ? '' : statusChip(e.state, e.live)}${e.guest && !off ? `<span class="chip chip--guest">${icon('star')}${esc(e.guest)}</span>` : ''}</span>
      <span class="event-more">${off || e.state === 'completed' ? 'Подробнее' : 'Программа и маршрут'}${icon('chevron')}</span>
    </span>
  </button>`;
}

function groupByDay(events) {
  const map = new Map();
  for (const e of events) map.set(e.date, [...(map.get(e.date) || []), e]);
  return [...map];
}

function freshness(ctx) {
  const when = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tbilisi', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    .format(new Date(ctx.content.updatedAt));
  return `<p class="freshness">${icon('info')}<span>Расписание обновлено ${esc(when)}. Срочные изменения — в
    <a href="${esc(ctx.content.links.channel)}" target="_blank" rel="noopener" data-link>канале храма</a>.</span></p>`;
}

/* ---------- Главная ---------- */

export function homeView(ctx) {
  const list = upcoming(ctx);
  const todayOff = list.filter(e => e.date === ctx.now.date && isOff(e));
  const active = list.filter(e => !isOff(e) && e.state !== 'completed');
  const [next, ...rest] = active;
  const temple = contactById(ctx, 'temple');
  const { links, places, donations } = ctx.content;

  return `
  <h1 class="sr-only">Храм Харе Кришна в Батуми</h1>

  ${todayOff.map(e => `<button class="alert-banner alert-banner--${e.state}" type="button" data-event="${esc(e.id)}">
      ${icon('alert')}
      <span><b>Сегодня ${e.state === 'cancelled' ? 'отменено' : 'перенесено'}: ${esc(e.title.toLowerCase())}</b>${e.note ? `<small>${esc(e.note)}</small>` : ''}</span>
      ${icon('chevron')}
    </button>`).join('')}

  ${next ? nextCard(ctx, next) : `<section class="card next">
      <p class="overline">Ближайшая программа</p>
      <h2 class="next-title">Новых анонсов пока нет</h2>
      <p class="muted">Следите за каналом храма — там появляются все объявления.</p>
      ${ext(links.channel, `${icon('send')}Открыть канал`, 'button button--primary')}
    </section>`}

  <nav class="quick" aria-label="Быстрые действия">
    <a class="quick-item quick-item--accent" href="#donate">${icon('heart')}<span>Пожертвовать</span></a>
    <a class="quick-item" href="${esc(tme(temple.handle))}" target="_blank" rel="noopener" data-link>${icon('chat')}<span>Написать в&nbsp;храм</span></a>
    <a class="quick-item" href="${esc(links.channel)}" target="_blank" rel="noopener" data-link>${icon('megaphone')}<span>Канал</span></a>
    <a class="quick-item" href="${esc(mapsUrl(places.temple.query))}" target="_blank" rel="noopener" data-link>${icon('pin')}<span>Как добраться</span></a>
  </nav>

  ${rest.length ? `<section class="section">
    ${sectionHead('Дальше', '<a class="text-link" href="#schedule">Всё расписание</a>')}
    <div class="card card--flush event-list">${rest.slice(0, 4).map(e => eventRow(e, ctx, { showDate: true })).join('')}</div>
  </section>` : ''}

  <section class="section donate-strip card">
    <div>
      <h2>Храм живёт на пожертвования</h2>
      <p class="muted">Аренда, прасад, цветы и программы. Выберите, откуда вы переводите:</p>
    </div>
    <div class="donate-strip-methods">
      ${donations.methods.map(m => `<a class="method-link" href="#donate/${esc(m.id)}">${icon(methodIcon(m.id))}<span><b>${esc(m.tab)}</b><small>${esc(m.tabSub)}</small></span>${icon('chevron')}</a>`).join('')}
    </div>
  </section>

  ${notifyCard(ctx)}

  <a class="card link-card" href="#prayers">
    ${icon('book')}
    <span><b>Молитвы</b><small>Тексты и переводы молитв, которые поют на программах</small></span>
    ${icon('chevron')}
  </a>

  <a class="card link-card" href="#newcomers">
    ${icon('temple')}
    <span><b>Впервые в храме?</b><small>Как проходит программа и как нас найти</small></span>
    ${icon('chevron')}
  </a>`;
}

function nextCard(ctx, e) {
  const place = ctx.content.places[e.place];
  return `<section class="card next">
    <p class="overline">${e.live ? 'Сейчас в храме' : 'Ближайшая программа'}</p>
    <h2 class="next-title">${esc(e.title)}</h2>
    <p class="next-when">${icon('calendar')}<span>${esc(relativeDay(e.date, ctx.now.date))} · ${esc(timeRange(e))}</span></p>
    ${place ? `<p class="next-when">${icon('pin')}<span>${esc(place.name)}${place.address ? `, ${esc(place.address)}` : ''}</span></p>` : ''}
    <div class="event-tags">${statusChip(e.state, e.live)}${e.guest ? `<span class="chip chip--guest">${icon('star')}${esc(e.guest)}</span>` : ''}</div>
    <div class="next-actions">
      ${place ? ext(mapsUrl(place.query), `${icon('pin')}Маршрут`, 'button button--primary') : ''}
      <button class="button button--secondary" type="button" data-event="${esc(e.id)}">Подробнее</button>
    </div>
    ${freshness(ctx)}
  </section>`;
}

function notifyCard(ctx) {
  return `<aside class="callout">
    ${icon('megaphone')}
    <div><b>Не пропустите перенос или отмену</b>
      <p>${esc(ctx.content.links.channelNotifications)}</p>
      ${ext(ctx.content.links.channel, `${icon('send')}Открыть канал`, 'text-link')}
    </div>
  </aside>`;
}

const methodIcon = id => ({ sber: 'phone', tbc: 'bank', usdt: 'coin' })[id] || 'heart';

/* ---------- Расписание ---------- */

export function scheduleView(ctx, filter) {
  const cats = ctx.content.categories;
  const all = upcoming(ctx);
  const present = Object.keys(cats).filter(c => all.some(e => e.category === c));
  const list = filter ? all.filter(e => e.category === filter) : all;
  const past = recent(ctx);

  return `
  ${pageHead('Расписание', 'Ближайшие две недели. Время — по Батуми.', freshness(ctx))}
  <div class="chips" role="group" aria-label="Тип программы">
    <button class="filter" type="button" data-filter="" aria-pressed="${!filter}">Все</button>
    ${present.map(c => `<button class="filter" type="button" data-filter="${c}" aria-pressed="${filter === c}">${esc(cats[c])}</button>`).join('')}
  </div>

  ${list.length ? groupByDay(list).map(([day, items]) => `
    <section class="day">
      <h2 class="day-title">${esc(relativeDay(day, ctx.now.date))}</h2>
      <div class="card card--flush event-list">${items.map(e => eventRow(e, ctx)).join('')}</div>
    </section>`).join('') : '<p class="muted">В этой категории ближайших программ нет.</p>'}

  <section class="section">
    ${sectionHead('Что значат отметки')}
    <ul class="card legend">
      <li>${statusChip('confirmed')}<span>Храм объявил программу в канале</span></li>
      <li>${statusChip('regular')}<span>Регулярная программа, анонса ещё нет</span></li>
      <li>${statusChip('moved')}<span>Перенесена на другой день</span></li>
      <li>${statusChip('cancelled')}<span>Не состоится</span></li>
    </ul>
  </section>

  ${notifyCard(ctx)}

  <section class="section">
    ${sectionHead('Обычная неделя')}
    <div class="card week">
      ${ctx.content.week.map(w => `
        <div class="week-row"><span class="week-days">${esc(w.days)}</span><span class="week-time">${esc(w.time)}</span>
        <span class="week-title">${esc(w.title)}${w.note ? `<small>${esc(w.note)}</small>` : ''}</span></div>`).join('')}
    </div>
  </section>

  ${past.length ? `<details class="section disclosure">
    <summary><h2>Недавно прошло</h2>${icon('chevron', 'disclosure-icon')}</summary>
    <div class="card card--flush event-list">${past.map(e => eventRow(e, ctx, { showDate: true })).join('')}</div>
  </details>` : ''}`;
}

/* ---------- Шторка события ---------- */

export function eventSheet(ctx, e) {
  const place = ctx.content.places[e.place];
  const moved = e.movedTo && findEvent(ctx, e.movedTo);
  const off = isOff(e);
  const upcomingEvent = !off && e.state !== 'completed';
  const lastSource = e.sources.at(-1) || ctx.content.links.channel;
  const temple = contactById(ctx, 'temple');
  return `
  ${ctx.content.categories[e.category] !== e.title ? `<p class="overline">${esc(ctx.content.categories[e.category] || '')}</p>` : ''}
  <h2 id="sheet-title" class="sheet-title" tabindex="-1">${esc(e.title)}</h2>
  <div class="status-box status-box--${e.live ? 'live' : STATUS[e.state].chip}">
    ${statusChip(e.state, e.live)}
    <p>${esc(e.note || STATUS[e.state].hint)}</p>
    ${moved ? `<button class="text-link" type="button" data-event="${esc(moved.id)}">Открыть программу ${esc(formatDayMonth(moved.date))} ${icon('chevron')}</button>` : ''}
  </div>

  <dl class="facts">
    <div>${icon('calendar')}<dt>Когда</dt><dd>${esc(relativeDay(e.date, ctx.now.date))}<br><span class="muted">${esc(timeRange(e))}</span></dd></div>
    ${place ? `<div>${icon('pin')}<dt>Где</dt><dd>${esc(place.name)}<br><span class="muted">${esc(place.address)}</span></dd></div>` : ''}
    ${e.guest ? `<div>${icon('star')}<dt>Гость</dt><dd>${esc(e.guest)}</dd></div>` : ''}
  </dl>

  ${e.program?.length ? `<h3 class="sheet-subtitle">Программа</h3>
    <ol class="timeline">${e.program.map(([t, what]) => `<li><time>${esc(t)}</time><span>${esc(what)}</span></li>`).join('')}</ol>
    ${e.generated ? '<p class="footnote">Обычный порядок по сайту храма. Точное время — в анонсе в канале.</p>' : ''}` : ''}

  <div class="sheet-actions">
    ${upcomingEvent && place ? ext(mapsUrl(place.query), `${icon('pin')}Как добраться`, 'button button--primary') : ''}
    ${upcomingEvent ? ext(calendarUrl(e, place ? `${place.name}, ${place.address}, Батуми` : 'Батуми'), `${icon('calendar')}Добавить в календарь`) : ''}
    ${ext(lastSource, `${icon('send')}${e.sources.length ? 'Сообщение в канале' : 'Проверить анонс в канале'}`, upcomingEvent ? 'button button--secondary' : 'button button--primary')}
  </div>
  ${e.sources.length > 1 ? `<p class="footnote sources">История: ${e.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener" data-link>${i ? 'обновление' : 'анонс'}</a>`).join(' → ')}</p>` : ''}
  <div class="sheet-links">
    <button class="text-link" type="button" data-share="${esc(e.id)}">${icon('share')}Отправить другу</button>
    ${ext(tme(temple.handle), `${icon('chat')}Задать вопрос`, 'text-link')}
  </div>`;
}

/* ---------- Пожертвования ---------- */

const group4 = v => v.replace(/(.{4})/g, '$1 ').trim();

function field(f) {
  const shown = ['iban', 'address'].includes(f.format) ? group4(f.value) : f.value;
  const raw = f.copy || f.value;
  const cls = [['iban', 'address'].includes(f.format) && 'is-mono', f.format === 'phone' && 'is-nowrap'].filter(Boolean).join(' ');
  return `<div class="field">
    <span class="field-label">${esc(f.label)}</span>
    <button class="field-value ${cls}" type="button" data-copy="${esc(raw)}" data-copy-label="${esc(f.label)}">
      <span class="field-text">${esc(shown)}</span>
      <span class="copy-pill">${icon('copy', 'copy-icon')}${icon('check', 'check-icon')}<span class="copy-label">Копировать</span><span class="copied-label">Скопировано</span></span>
    </button>
  </div>`;
}

export const requisitesText = m => [
  `Пожертвование храму Харе Кришна, Батуми — ${m.title}`,
  ...m.fields.map(f => `${f.label}: ${f.copy || f.value}`),
  ...(m.extra?.fields || []).map(f => `${f.label}: ${f.value}`),
  ...(m.network ? [`Только сеть ${m.network}`] : []),
].join('\n');

export function donateView(ctx, methodId) {
  const d = ctx.content.donations;
  const m = d.methods.find(x => x.id === methodId) || d.methods[0];
  const helper = contactById(ctx, 'temple');
  return `
  ${pageHead('Поддержать храм', 'Храм в Батуми содержится на пожертвования прихожан. Откуда вам удобнее перевести?')}

  <div class="segmented" role="tablist" aria-label="Откуда вы переводите">
    ${d.methods.map(x => `<button class="segment" type="button" role="tab" id="tab-${x.id}" aria-controls="panel-${x.id}" aria-selected="${x.id === m.id}" tabindex="${x.id === m.id ? 0 : -1}" data-method="${x.id}">
      <b>${esc(x.tab)}</b><small>${esc(x.tabSub)}</small></button>`).join('')}
  </div>

  <section class="card method" role="tabpanel" id="panel-${m.id}" aria-labelledby="tab-${m.id}">
    <header class="method-head">
      <span class="method-icon">${icon(methodIcon(m.id))}</span>
      <div><h2>${esc(m.title)}</h2><p class="muted">${esc(m.subtitle)}</p></div>
    </header>
    ${m.warning ? `<div class="warning">${icon('alert')}<div><b>Сеть: ${esc(m.network)}</b><p>${esc(m.warning)}</p></div></div>` : ''}
    <div class="fields">${m.fields.map(field).join('')}</div>
    ${m.extra ? `<details class="disclosure disclosure--inline">
        <summary><span>${esc(m.extra.title)}</span>${icon('chevron', 'disclosure-icon')}</summary>
        <div class="fields">${m.extra.fields.map(field).join('')}</div>
      </details>` : ''}
    <ol class="steps">${m.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <button class="text-link" type="button" data-share-requisites="${esc(m.id)}">${icon('share')}Отправить эти реквизиты другу или себе</button>
  </section>

  <section class="card after">
    <h2>После перевода</h2>
    <p class="muted">Спасибо! Переводы не отслеживаются автоматически. Если хотите, чтобы пожертвование учли на конкретную цель, или что-то не получилось — напишите в храм.</p>
    ${ext(tme(helper.handle), `${icon('send')}Написать @${esc(helper.handle)}`, 'button button--secondary button--block')}
  </section>

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

/* ---------- Связаться ---------- */

export function contactView(ctx) {
  const { questions, services, links } = ctx.content;
  return `
  ${pageHead('Связаться', 'Выберите вопрос — откроется чат с нужным человеком в Telegram.')}

  <div class="card card--flush rows">
    ${questions.map(q => {
      const c = contactById(ctx, q.contact);
      return `<a class="row" href="${esc(tme(c.handle))}" target="_blank" rel="noopener" data-link>${icon('chat')}
        <span><b>${esc(q.title)}</b><small>${esc(c.name)} · @${esc(c.handle)}</small></span>${icon('external')}</a>`;
    }).join('')}
  </div>

  <section class="section" id="service">
    ${sectionHead('Помочь храму')}
    <p class="muted section-lead">Выберите, чем хотите помочь. Время и задачи договариваются лично в Telegram.</p>
    <div class="service-list">
      ${services.map(s => `
        <button class="card service" type="button" data-service="${esc(s.id)}">
          <span class="service-title">${esc(s.title)}</span>
          <span class="service-when">${icon('clock')}${esc(s.when)}</span>
          <span class="service-text">${esc(s.text)}</span>
          <span class="event-more">Хочу помочь${icon('chevron')}</span>
        </button>`).join('')}
    </div>
  </section>

  <section class="section">
    ${sectionHead('Материалы и новости')}
    <div class="card card--flush rows">
      <a class="row" href="#prayers">${icon('book')}<span><b>Молитвы</b><small>Тексты и переводы для программ</small></span>${icon('chevron')}</a>
      ${row(links.channel, 'megaphone', 'Канал храма', 'Анонсы, переносы, трансляции, отчёты')}
      ${row(links.chat, 'chat', 'Чат сообщества', 'Общение с преданными')}
      <a class="row" href="#records">${icon('play')}<span><b>Лекции и трансляции</b><small>Прямые эфиры идут в канале</small></span>${icon('chevron')}</a>
      ${row(links.site, 'globe', 'Сайт храма', 'iskcone.com/batumi')}
    </div>
  </section>`;
}

const row = (url, ic, title, sub) =>
  `<a class="row" href="${esc(url)}" target="_blank" rel="noopener" data-link>${icon(ic)}<span><b>${esc(title)}</b><small>${esc(sub)}</small></span>${icon('external')}</a>`;

export function serviceSheet(ctx, s) {
  const c = contactById(ctx, 'temple');
  return `
  <p class="overline">Помочь храму</p>
  <h2 id="sheet-title" class="sheet-title" tabindex="-1">${esc(s.title)}</h2>
  <ol class="flow">
    <li>
      <b>Скопируйте готовый текст</b>
      <blockquote class="message">${esc(s.message)}</blockquote>
      <button class="button button--primary button--block" type="button" data-copy="${esc(s.message)}" data-copy-label="Текст" data-reveal="flow-2">${icon('copy')}<span>Скопировать текст</span></button>
    </li>
    <li id="flow-2" class="is-waiting">
      <b>Откройте чат и вставьте текст</b>
      <p class="muted">В Telegram нажмите на поле сообщения и выберите «Вставить».</p>
      ${ext(tme(c.handle), `${icon('send')}Открыть чат с @${esc(c.handle)}`, 'button button--secondary button--block')}
    </li>
  </ol>
  <p class="footnote">Приложение не отправляет заявки само — вы пишете напрямую и договариваетесь лично.</p>`;
}

/* ---------- Новичкам ---------- */

export function newcomersView(ctx) {
  const { places, newcomers, regular } = ctx.content;
  const t = places.temple;
  const sunday = regular.find(r => r.id === 'sunday');
  const c = contactById(ctx, 'temple');
  return `
  ${pageHead('Впервые в храме', esc(newcomers.intro))}

  <section class="card address" id="address">
    <p class="overline">Адрес</p>
    <p class="address-line">Батуми, ${esc(t.address)}</p>
    <div class="button-row">
      ${ext(mapsUrl(t.query), `${icon('pin')}Google Карты`, 'button button--primary')}
      ${ext(mapsUrl(t.query, 'yandex'), 'Яндекс Карты')}
      <button class="button button--ghost" type="button" data-copy="Батуми, ${esc(t.address)}" data-copy-label="Адрес">${icon('copy')}Скопировать</button>
    </div>
  </section>

  ${sunday?.program ? `<section class="section">
    ${sectionHead('Как проходит воскресенье')}
    <div class="card">
      <ol class="timeline">${sunday.program.map(([time, what]) => `<li><time>${esc(time)}</time><span>${esc(what)}</span></li>`).join('')}</ol>
      <p class="footnote">Обычный порядок. Точное время публикуется в канале утром в день программы.</p>
    </div>
  </section>` : ''}

  <section class="section" id="faq">
    ${sectionHead('Частые вопросы')}
    <div class="card card--flush faq">
      ${newcomers.faq.map(([q, a]) => `<details class="faq-item"><summary>${esc(q)}${icon('chevron', 'disclosure-icon')}</summary><p>${esc(a)}</p></details>`).join('')}
    </div>
  </section>

  <aside class="callout">
    ${icon('chat')}
    <div><b>Остались вопросы?</b>
      <p>Напишите в храм — подскажут время и как найти вход.</p>
      ${ext(tme(c.handle), `${icon('send')}Написать @${esc(c.handle)}`, 'text-link')}
    </div>
  </aside>`;
}

/* ---------- Лекции и трансляции ---------- */

export function recordsView(ctx) {
  const { recordings, links } = ctx.content;
  return `
  <a class="back-link" href="#contact">${icon('chevron')}Связаться</a>
  ${pageHead('Лекции и трансляции')}

  <section class="card stack">
    <h2>Прямые трансляции — в канале</h2>
    <p class="muted">Программы иногда транслируются в Telegram-канале храма. Включите уведомления канала, чтобы узнать о начале эфира.</p>
    <div class="button-row">
      ${ext(links.channel, `${icon('send')}Открыть канал`, 'button button--primary')}
      ${ext(links.lastBroadcast.url, 'Последняя трансляция')}
    </div>
    <p class="footnote">${esc(links.lastBroadcast.title)}</p>
  </section>

  ${recordings.length ? `<section class="section">${sectionHead('Записи')}<div class="records">${recordings.map(r => `
      <a class="card record" href="${esc(r.url)}" target="_blank" rel="noopener" data-link>
        ${icon('play')}<span><b>${esc(r.title)}</b><small>${esc(r.speaker)} · ${esc(formatDayMonth(r.date))}</small></span>${icon('external')}
      </a>`).join('')}</div></section>`
    : `<section class="card stack">
        <h2>Архива записей пока нет</h2>
        <p class="muted">Когда лекции храма начнут публиковаться на YouTube, они появятся здесь. Нужны люди, которые помогут записывать.</p>
        <button class="text-link" type="button" data-service="recording">${icon('hands')}Помочь с записью</button>
      </section>`}`;
}

/* ---------- Молитвы ---------- */

const verseCount = n => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'стих' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'стиха' : 'стихов'}`;

export function prayersView(data) {
  return `
  <a class="back-link" href="#contact">${icon('chevron')}Связаться</a>
  ${pageHead('Молитвы', 'Молитвы, которые поют на службах в храме: транслитерация и перевод.')}
  <div class="card card--flush rows">
    ${data.prayers.map(p => `<a class="row" href="#prayers/${esc(p.id)}">${icon('book')}
      <span><b>${esc(p.title)}</b><small>${esc(p.subtitle)}${p.verses.length > 1 ? ` · ${verseCount(p.verses.length)}` : ''}</small></span>${icon('chevron')}</a>`).join('')}
  </div>
  <p class="footnote">Тексты и переводы — с сайтов <a href="${esc(data.source)}" target="_blank" rel="noopener" data-link>ISKCON One Love</a> и Vedabase. На ISKCON One Love — другие бхаджаны и аудиозаписи.</p>`;
}

export function prayerView(data, id, prefs) {
  const i = data.prayers.findIndex(p => p.id === id);
  if (i < 0) return prayersView(data);
  const p = data.prayers[i];
  const prev = data.prayers[i - 1];
  const next = data.prayers[i + 1];
  const hasTranslation = p.verses.some(v => v.translation);
  return `
  <a class="back-link" href="#prayers">${icon('chevron')}Все молитвы</a>
  <header class="page-head">
    <h1>${esc(p.title)}</h1>
    <p class="lead">${esc(p.subtitle)}</p>
    ${p.when ? `<p class="prayer-when">${icon('clock')}${esc(p.when)}</p>` : ''}
    ${p.intro ? `<p class="prayer-intro">${esc(p.intro)}</p>` : ''}
  </header>

  <div class="reader-tools" role="group" aria-label="Настройки чтения">
    ${hasTranslation ? `<button class="filter" type="button" data-action="toggle-translation" aria-pressed="${prefs.translation}">Перевод</button>` : ''}
    <span class="reader-size">
      <button class="filter" type="button" data-action="font-down" aria-label="Уменьшить шрифт" ${prefs.size <= 0 ? 'disabled' : ''}>A−</button>
      <button class="filter" type="button" data-action="font-up" aria-label="Увеличить шрифт" ${prefs.size >= 2 ? 'disabled' : ''}>A+</button>
    </span>
  </div>

  <article class="prayer size-${prefs.size} ${prefs.translation ? '' : 'no-translation'}">
    ${p.verses.map((v, n) => `
      <section class="verse">
        ${p.verses.length > 1 || v.label ? `<span class="verse-head">${p.verses.length > 1 ? `<span class="verse-num">${n + 1}</span>` : ''}${v.label ? `<span class="verse-label">${esc(v.label)}</span>` : ''}</span>` : ''}
        <p class="verse-text">${(Array.isArray(v.text) ? v.text : [v.text]).flat().map(l => `<span class="verse-line">${esc(l)}</span>`).join('')}</p>
        ${v.translation ? `<p class="verse-translation">${esc(v.translation)}</p>` : ''}
      </section>`).join('')}
  </article>

  ${p.commentary ? `<details class="section disclosure card">
    <summary><span class="commentary-title">${esc(p.commentary.title)}</span>${icon('chevron', 'disclosure-icon')}</summary>
    <div class="commentary">${p.commentary.paragraphs.map(t => `<p>${esc(t)}</p>`).join('')}</div>
  </details>` : ''}

  <nav class="prayer-nav" aria-label="Другие молитвы">
    ${prev ? `<a class="card prayer-nav-link" href="#prayers/${esc(prev.id)}"><small>Предыдущая</small><b>${esc(prev.title)}</b></a>` : '<span></span>'}
    ${next ? `<a class="card prayer-nav-link prayer-nav-link--next" href="#prayers/${esc(next.id)}"><small>Следующая</small><b>${esc(next.title)}</b></a>` : '<span></span>'}
  </nav>
  <p class="footnote">Источник: <a href="${esc(p.source)}" target="_blank" rel="noopener" data-link>${esc(new URL(p.source).hostname)}</a>${p.copyright ? ` · ${esc(p.copyright)}` : ''}</p>`;
}

/* ---------- Знакомство и состояния ---------- */

export const welcomeSheet = () => `
  <h2 id="sheet-title" class="sheet-title" tabindex="-1">Харе Кришна!</h2>
  <p class="muted">Это приложение храма в Батуми. Здесь:</p>
  <ul class="welcome">
    <li>${icon('calendar')}<span><b>Расписание</b>Отметка «Анонсировано» значит, что храм объявил программу в канале</span></li>
    <li>${icon('heart')}<span><b>Пожертвования</b>Реквизиты копируются одним касанием</span></li>
    <li>${icon('chat')}<span><b>Связаться</b>Выберите вопрос — откроется чат с нужным человеком</span></li>
  </ul>
  <p class="welcome-note">Главная встреча недели — <b>воскресенье, 14:00</b>. Вход свободный.</p>
  <button class="button button--primary button--block" type="button" data-action="close-sheet">Понятно</button>`;

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
  <h2 id="sheet-title" class="sheet-title" tabindex="-1">Скопируйте вручную</h2>
  <p class="muted">Браузер не дал скопировать автоматически. Нажмите на текст и удерживайте, чтобы выделить.</p>
  <textarea class="copy-area" readonly rows="${Math.min(8, text.split('\n').length + 1)}">${esc(text)}</textarea>`;
