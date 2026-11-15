// Точка входа: загрузка данных, маршрутизация по hash, шторки, копирование, Telegram.
import { icon } from './icons.js?v=25';
import { nowInBatumi, relativeDay } from './schedule.js?v=25';
import { initTelegram, setBackButton, startParam, openLink, haptic, inTelegram } from './telegram.js?v=25';
import * as V from './views.js?v=25';

const CONTENT_URL = 'content.json';
const CACHE_KEY = 'hkb-content-v3';
const METHOD_KEY = 'hkb-donate-method';
const WELCOME_KEY = 'hkb-welcomed';
const PRAYER_PREFS_KEY = 'hkb-prayer-prefs';

const TABS = [
  ['home', 'home', 'Главная'],
  ['schedule', 'calendar', 'Расписание'],
  ['donate', 'heart', 'Поддержать'],
  ['contact', 'chat', 'Связаться'],
  ['newcomers', 'temple', 'Новичкам'],
];
const TITLES = { home: 'Главная', schedule: 'Расписание', donate: 'Поддержать храм', contact: 'Связаться', newcomers: 'Впервые в храме', records: 'Лекции и трансляции', prayers: 'Молитвы', calendar: 'Вайшнавский календарь' };
const SUBPAGES = { records: 'contact', prayers: 'contact', calendar: 'schedule' }; // подстраница → активная вкладка
const ALIASES = { service: 'contact/service', temple: 'newcomers' }; // адреса прошлой версии

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим — не критично */ } },
};

const state = { content: null, prayers: null, calendar: null, filter: '', calFilter: '', lastRoute: '' };

// Настройки чтения молитв: показывать перевод, размер шрифта 0–2. Хранятся на устройстве.
const prayerPrefs = (() => {
  try { return { translation: true, size: 1, ...JSON.parse(storage.get(PRAYER_PREFS_KEY) || '{}') }; } catch { return { translation: true, size: 1 }; }
})();
const $ = sel => document.querySelector(sel);
const main = $('#main');
const sheet = $('#sheet');


/* ---------- Данные ---------- */

async function loadContent() {
  try {
    const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const content = await res.json();
    storage.set(CACHE_KEY, JSON.stringify(content));
    return content;
  } catch (err) {
    const cached = storage.get(CACHE_KEY);
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

// Молитвы загружаются только при первом открытии раздела, чтобы не замедлять главную
let prayersLoading = null;
function loadPrayers() {
  prayersLoading ||= fetch('prayers.json?v=25', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => { state.prayers = data; render({ keepScroll: true }); })
    .catch(() => { prayersLoading = null; main.innerHTML = V.errorView('https://iskcone.com/ru/bhajans'); });
  return prayersLoading;
}

// Календарь подгружается в фоне: главная показывается сразу, карточка экадаши появляется, когда данные пришли
let calendarLoading = null;
function loadCalendar() {
  calendarLoading ||= fetch('calendar.json?v=25', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => { state.calendar = data; render({ keepScroll: true }); })
    .catch(() => { calendarLoading = null; });
  return calendarLoading;
}

const ctx = () => ({ content: state.content, calendar: state.calendar, now: nowInBatumi() });

/* ---------- Маршрутизация ---------- */

function parseRoute() {
  let hash = location.hash.replace(/^#/, '');
  const [first] = hash.split('/');
  if (ALIASES[first]) hash = ALIASES[first];
  const [page = 'home', arg = ''] = hash.split('/');
  return page in TITLES ? { page, arg } : { page: 'home', arg: '' };
}

function render({ keepScroll = false } = {}) {
  if (!state.content) return;
  const { page, arg } = parseRoute();
  const c = ctx();
  const views = {
    home: () => V.homeView(c),
    schedule: () => V.scheduleView(c, state.filter),
    donate: () => V.donateView(c, arg || storage.get(METHOD_KEY)),
    contact: () => V.contactView(c),
    newcomers: () => V.newcomersView(c),
    records: () => V.recordsView(c),
    calendar: () => {
      if (!state.calendar) { loadCalendar(); return '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Загружаем календарь…</span></div>'; }
      return V.calendarView(c, state.calFilter);
    },
    prayers: () => {
      if (!state.prayers) { loadPrayers(); return '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Загружаем молитвы…</span></div>'; }
      return arg ? V.prayerView(state.prayers, arg, prayerPrefs) : V.prayersView(state.prayers);
    },
  };
  document.body.dataset.page = page; // логотип в шапке показываем только на главной
  main.innerHTML = views[page]();
  renderNav(SUBPAGES[page] || page);
  document.title = `${TITLES[page]} · Харе Кришна Батуми`;
  setBackButton(sheet.open || page in SUBPAGES);

  const routeKey = `${page}/${arg}`;
  if (!keepScroll && routeKey !== state.lastRoute) {
    const anchor = arg && document.getElementById(arg);
    anchor ? anchor.scrollIntoView({ block: 'start' }) : window.scrollTo(0, 0);
  }
  state.lastRoute = routeKey;
}

function renderNav(active) {
  const html = TABS.map(([id, ic, label]) =>
    `<a class="nav-item" href="#${id}" ${id === active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`).join('');
  document.querySelectorAll('[data-nav]').forEach(n => { n.innerHTML = html; });
}

/* ---------- Шторка ---------- */

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  if (!sheet.open) {
    sheet.showModal();
    document.documentElement.classList.add('has-sheet');
  }
  sheet.querySelector('.sheet-inner').scrollTop = 0;
  // Фокус на заголовок, а не на крестик: так нет рамки фокуса и экранный диктор читает заголовок
  sheet.querySelector('.sheet-title')?.focus({ preventScroll: true });
  setBackButton(true);
}

// Без анимаций: встроенный браузер Telegram на macOS замирает на первом кадре анимации
// внутри <dialog>, и шторка остаётся видна лишь на несколько пикселей.
function closeSheet() {
  if (sheet.open) sheet.close();
}

sheet.addEventListener('close', () => {
  document.documentElement.classList.remove('has-sheet');
  setBackButton(parseRoute().page in SUBPAGES);
});
sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(); }); // Esc — с анимацией
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); }); // клик по фону
$('.sheet-close').innerHTML = icon('close');

/* ---------- Копирование ---------- */

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Старые WebView Telegram: запасной способ через выделение
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    ta.style.cssText = 'position:fixed;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function handleCopy(el) {
  const text = el.dataset.copy;
  if (!(await copyText(text))) {
    openSheet(V.copyFallbackSheet(text));
    sheet.querySelector('textarea')?.select();
    return;
  }
  haptic('success');

  if (el.classList.contains('field-value')) { // реквизит: подтверждение прямо в строке
    document.querySelectorAll('.field-value.is-copied').forEach(x => x.classList.remove('is-copied'));
    el.classList.add('is-copied');
    setTimeout(() => el.classList.remove('is-copied'), 2500);
    return;
  }
  if (el.dataset.reveal) { // служение: шаг 1 выполнен → показываем шаг 2
    el.classList.replace('button--primary', 'button--done');
    el.querySelector('span').textContent = 'Текст скопирован';
    el.querySelector('.icon').outerHTML = icon('check');
    const next = document.getElementById(el.dataset.reveal);
    next?.classList.remove('is-waiting');
    next?.querySelector('.button')?.classList.replace('button--secondary', 'button--primary');
    return;
  }
  toast(el.dataset.copyLabel ? `${el.dataset.copyLabel}: скопировано` : 'Скопировано');
}

/* ---------- Действия ---------- */

function shareEvent(id) {
  const c = ctx();
  const e = V.findEvent(c, id);
  if (!e) return;
  const place = c.content.places[e.place]?.name || '';
  const text = `${e.title} — ${relativeDay(e.date, c.now.date)}, ${e.start}. ${place}`;
  openLink(V.shareUrl(e.sources.at(-1) || c.content.links.channel, text));
}

function shareRequisites(id) {
  const m = state.content.donations.methods.find(x => x.id === id);
  if (m) openLink(V.shareUrl(state.content.links.siteDonations, V.requisitesText(m)));
}

document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-event],[data-filter],[data-cal-filter],[data-method],[data-copy],[data-service],[data-share],[data-share-requisites],[data-action],[data-link]');
  if (!t) return;
  const d = t.dataset;

  if (d.event) { haptic('select'); openSheet(V.eventSheet(ctx(), V.findEvent(ctx(), d.event))); return; }
  if (d.calFilter !== undefined) { haptic('select'); state.calFilter = d.calFilter; render({ keepScroll: true }); return; }
  if (d.filter !== undefined && t.classList.contains('filter')) { haptic('select'); state.filter = d.filter; render({ keepScroll: true }); return; }
  if (d.method) {
    haptic('select');
    storage.set(METHOD_KEY, d.method);
    history.replaceState(null, '', `#donate/${d.method}`);
    render({ keepScroll: true });
    document.getElementById(`tab-${d.method}`)?.focus();
    return;
  }
  if (d.service) {
    const s = state.content.services.find(x => x.id === d.service);
    if (s) openSheet(V.serviceSheet(ctx(), s));
    return;
  }
  if (d.copy) { handleCopy(t); return; }
  if (d.share) { shareEvent(d.share); return; }
  if (d.shareRequisites) { shareRequisites(d.shareRequisites); return; }
  if (d.action === 'close-sheet') { closeSheet(); return; }
  if (d.action === 'retry') { boot(); return; }
  if (['toggle-translation', 'font-up', 'font-down'].includes(d.action)) {
    haptic('select');
    if (d.action === 'toggle-translation') prayerPrefs.translation = !prayerPrefs.translation;
    else prayerPrefs.size = Math.max(0, Math.min(2, prayerPrefs.size + (d.action === 'font-up' ? 1 : -1)));
    storage.set(PRAYER_PREFS_KEY, JSON.stringify(prayerPrefs));
    render({ keepScroll: true });
    return;
  }
  if (t.hasAttribute('data-link') && inTelegram) { // внешние ссылки — через Telegram, чтобы не закрывать приложение
    ev.preventDefault();
    openLink(t.href);
  }
});

// Стрелки влево/вправо в переключателе способов пожертвования
document.addEventListener('keydown', ev => {
  const tab = ev.target.closest?.('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  tabs[(tabs.indexOf(tab) + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].click();
});

window.addEventListener('hashchange', () => { closeSheet(); render(); });

// Обновляем статусы («Идёт сейчас», «Прошло») раз в минуту, если приложение открыто
setInterval(() => { if (!sheet.open && document.visibilityState === 'visible') render({ keepScroll: true }); }, 60_000);

/* ---------- Запуск ---------- */

function applyStartParam() {
  const p = startParam();
  if (!p || location.hash) return false;
  const [page, arg] = p.split('_'); // startapp=donate_usdt → #donate/usdt
  if (!(page in TITLES) && !(page in ALIASES)) return false;
  history.replaceState(null, '', `#${page}${arg ? `/${arg}` : ''}`);
  return true;
}

function maybeWelcome(deepLinked) {
  // Знакомство показываем один раз и не мешаем тому, кто пришёл по прямой ссылке на раздел
  if (storage.get(WELCOME_KEY) || deepLinked || (location.hash && location.hash !== '#home')) return;
  storage.set(WELCOME_KEY, '1');
  openSheet(V.welcomeSheet());
}

async function boot(deepLinked = false) {
  main.innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Загружаем расписание…</span></div>';
  try {
    state.content = await loadContent();
    loadCalendar();
    render();
    maybeWelcome(deepLinked);
  } catch {
    main.innerHTML = V.errorView('https://t.me/harekrishnabatumi');
    renderNav('home');
  }
}

// Кнопка «Назад» Telegram: закрыть шторку → из текста молитвы к списку → из подраздела во вкладку
function goBack() {
  if (sheet.open) return closeSheet();
  const { page, arg } = parseRoute();
  location.hash = page === 'prayers' && arg ? 'prayers' : SUBPAGES[page] || 'home';
}
initTelegram({ onBack: goBack });
boot(applyStartParam());
