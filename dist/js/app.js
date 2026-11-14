// Точка входа: загрузка данных, маршрутизация по hash, шторки, копирование, Telegram.
import { icon } from './icons.js?v=5';
import { nowInBatumi, relativeDay } from './schedule.js?v=5';
import { initTelegram, setBackButton, startParam, openLink, haptic, inTelegram } from './telegram.js?v=5';
import * as V from './views.js?v=5';

const CONTENT_URL = 'content.json';
const CACHE_KEY = 'hkb-content-v3';
const METHOD_KEY = 'hkb-donate-method';

const TABS = [
  ['home', 'home', 'Главная'],
  ['schedule', 'calendar', 'Расписание'],
  ['donate', 'heart', 'Поддержать'],
  ['service', 'hands', 'Служение'],
  ['temple', 'temple', 'Храм'],
];
const TITLES = { home: 'Главная', schedule: 'Расписание', donate: 'Поддержать храм', service: 'Служение', temple: 'Храм', records: 'Лекции и трансляции' };
const SUBPAGES = { records: 'temple' }; // подстраница → активная вкладка

const state = { content: null, filter: '', lastRoute: '' };
const $ = sel => document.querySelector(sel);
const main = $('#main');
const sheet = $('#sheet');

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим — не критично */ } },
};

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

const ctx = () => ({ content: state.content, now: nowInBatumi() });

/* ---------- Маршрутизация ---------- */

function parseRoute() {
  const [page = 'home', arg = ''] = location.hash.replace(/^#/, '').split('/');
  const known = page in TITLES ? page : 'home';
  return { page: known, arg: known === page ? arg : '' };
}

function render({ keepScroll = false } = {}) {
  if (!state.content) return;
  const { page, arg } = parseRoute();
  const c = ctx();
  const views = {
    home: () => V.homeView(c),
    schedule: () => V.scheduleView(c, state.filter),
    donate: () => V.donateView(c, arg || storage.get(METHOD_KEY)),
    service: () => V.serviceView(c),
    temple: () => V.templeView(c),
    records: () => V.recordsView(c),
  };
  main.innerHTML = views[page]();
  renderNav(SUBPAGES[page] || page);
  document.title = `${TITLES[page]} · Харе Кришна Батуми`;
  $('[data-today]').textContent = relativeDay(c.now.date, c.now.date).replace('Сегодня, ', '');
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
  setBackButton(true);
}

function closeSheet() {
  if (!sheet.open) return;
  sheet.classList.add('is-closing');
  const done = () => {
    sheet.classList.remove('is-closing');
    sheet.close();
  };
  matchMedia('(prefers-reduced-motion: reduce)').matches ? done() : setTimeout(done, 180);
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
  if (await copyText(text)) {
    haptic('success');
    const label = el.dataset.copyLabel;
    toast(label ? `${label}: скопировано` : 'Скопировано');
    if (el.classList.contains('field-value')) {
      document.querySelectorAll('.field-value.is-copied').forEach(x => x.classList.remove('is-copied'));
      el.classList.add('is-copied');
      setTimeout(() => el.classList.remove('is-copied'), 2000);
    }
    return true;
  }
  openSheet(V.copyFallbackSheet(text));
  sheet.querySelector('textarea')?.select();
  return false;
}

/* ---------- Действия ---------- */

function shareEvent(id) {
  const e = V.findEvent(ctx(), id);
  if (!e) return;
  const c = ctx();
  const place = c.content.places[e.place]?.name || '';
  const text = `${e.title} — ${relativeDay(e.date, c.now.date)}, ${e.start}. ${place}`;
  const url = e.sources.at(-1) || c.content.links.channel;
  openLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}

document.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-event],[data-filter],[data-method],[data-copy],[data-service],[data-share],[data-action],[data-link]');
  if (!t) return;
  const d = t.dataset;

  if (d.event) { haptic('select'); openSheet(V.eventSheet(ctx(), V.findEvent(ctx(), d.event))); return; }
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
  if (d.write) { // «Скопировать и написать»
    await handleCopy(t);
    openLink(`https://t.me/${d.write}`);
    return;
  }
  if (d.copy) { handleCopy(t); return; }
  if (d.share) { shareEvent(d.share); return; }
  if (d.action === 'close-sheet') { closeSheet(); return; }
  if (d.action === 'retry') { boot(); return; }
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
  const next = tabs[(tabs.indexOf(tab) + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.click();
});

window.addEventListener('hashchange', () => { closeSheet(); render(); });

// Обновляем статусы («Идёт сейчас», «Завершено») раз в минуту, если приложение открыто
setInterval(() => { if (!sheet.open && document.visibilityState === 'visible') render({ keepScroll: true }); }, 60_000);

/* ---------- Запуск ---------- */

function applyStartParam() {
  const p = startParam();
  if (!p || location.hash) return;
  const [page, arg] = p.split('_'); // startapp=donate_usdt → #donate/usdt
  if (page in TITLES) history.replaceState(null, '', `#${page}${arg ? `/${arg}` : ''}`);
}

async function boot() {
  main.innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Загружаем расписание…</span></div>';
  try {
    state.content = await loadContent();
    render();
  } catch {
    main.innerHTML = V.errorView('https://t.me/harekrishnabatumi');
    renderNav('home');
  }
}

initTelegram({ onBack: () => (sheet.open ? closeSheet() : (location.hash = SUBPAGES[parseRoute().page] || 'home')) });
applyStartParam();
boot();
