// Бот «Харе Кришна Батуми» — Supabase Edge Function "hk-bot"
// • Воскресенье: админы указывают лектора и джапу; в субботу в 14:00 — анонс с афишей.
// • Вторник и четверг: в 10:00 — пост «Сегодня прасад и киртан» с афишей; админы могут отменить или перенести.
// • Накануне экадаши в 18:00 — пост с временем выхода из поста для Батуми (из calendar.json мини-приложения).
// • Подписчики получают личное напоминание за 2 часа до программы.
// • ?task=schedule — расписание на 2 недели для мини-приложения (JSON).
// Пока в hk_settings mode <> 'live', всё, что предназначено для канала, уходит админам в личку.
import postgres from "npm:postgres@3.4.5";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const CHANNEL = "@harekrishnabatumi";
const ADDRESS_LINK = "https://t.me/harekrishnabatumi/1178";
const APP_URL = "https://italyanez.github.io/hare-krishna-batumi-app/";
const BOT_LINK = "https://t.me/harekrishnabatumi_bot";
const FN_URL = SUPABASE_URL + "/functions/v1/hk-bot";
const TZ_MS = 4 * 3600 * 1000; // Asia/Tbilisi, UTC+4 без перехода на летнее время
const DAY = 86400000;
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря"];

const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { prepare: false, max: 2 });

// ---------------- утилиты ----------------
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function nowTb(): Date { return new Date(Date.now() + TZ_MS); } // читать через getUTC*
function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function dayStart(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function nextSunday(from: Date) {
  const d = dayStart(from);
  const add = ((7 - d.getUTCDay()) % 7) || 7;
  return new Date(d.getTime() + add * DAY);
}
function human(d: Date) { return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }

async function hash(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
const secretToken = () => hash("hk:" + TOKEN); // заголовок вебхука Telegram
const cronKey = () => hash("cron:" + TOKEN); // ключ для задач по расписанию (pg_cron)

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json();
}

async function tgPhoto(chatId: string | number, png: Uint8Array, caption: string) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("photo", new Blob([png as BlobPart], { type: "image/png" }), "afisha.png");
  fd.append("caption", caption);
  fd.append("parse_mode", "HTML");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
  return await r.json();
}

const say = (chatId: number, text: string, reply_markup?: unknown) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup });

// ---------------- данные ----------------
type Week = {
  sunday: string; japa: string | null; lecturer: string | null; skipped: boolean;
  published_at: string | null; message_id: number | null; reminded_at: string | null;
  blocks: Block[] | null; note: string | null; fests: string[] | null; prev_lecturer: string | null;
};
type Block = { t: string; text: string; tag?: string; lect?: boolean; off?: boolean; custom?: boolean };

async function getWeek(sunday: string): Promise<Week | null> {
  const rows = await sql`select sunday::text as sunday, japa, lecturer, skipped, published_at::text as published_at,
    message_id, reminded_at::text as reminded_at, blocks, note, fests, prev_lecturer from hk_weeks where sunday = ${sunday}`;
  return (rows[0] as unknown as Week) ?? null;
}
async function saveWeek(sunday: string, patch: Partial<Week>) {
  await sql`insert into hk_weeks (sunday) values (${sunday}) on conflict (sunday) do nothing`;
  const p = { ...patch, updated_at: new Date().toISOString() } as Record<string, unknown>;
  if (p.blocks) p.blocks = sql.json(p.blocks as any);
  if (p.fests) p.fests = sql.json(p.fests as any);
  await sql`update hk_weeks set ${sql(p as any)} where sunday = ${sunday}`;
}
async function admins(): Promise<{ chat_id: number }[]> {
  const rows = await sql`select chat_id from hk_admins`;
  return rows.map((r) => ({ chat_id: Number(r.chat_id) }));
}
async function saveAdmin(userId: number, chatId: number, name: string) {
  await sql`insert into hk_admins (user_id, chat_id, name) values (${userId}, ${chatId}, ${name})
    on conflict (user_id) do update set chat_id = excluded.chat_id, name = excluded.name`;
}
async function notifyAdmins(text: string, kb?: unknown) {
  for (const a of await admins()) await say(a.chat_id, text, kb).catch(() => {});
}

// Режим: 'test' (по умолчанию) — посты для канала получают только админы; 'live' — посты идут в канал.
async function isLive() {
  const r = await sql`select v from hk_settings where k = 'mode'`;
  return r[0]?.v === "live";
}

type Sent = { ok: boolean; message_id: number | null; test?: boolean; description?: string };
async function channelPost(png: Uint8Array | null, text: string): Promise<Sent> {
  if (!(await isLive())) {
    for (const a of await admins()) {
      await say(a.chat_id, "🧪 <b>Тестовый режим</b> — в канал это не ушло. Так будет выглядеть пост:").catch(() => {});
      if (png) await tgPhoto(a.chat_id, png, text).catch(() => {});
      else await say(a.chat_id, text).catch(() => {});
    }
    return { ok: true, message_id: null, test: true };
  }
  const r = png
    ? await tgPhoto(CHANNEL, png, text)
    : await tg("sendMessage", { chat_id: CHANNEL, text, parse_mode: "HTML", disable_web_page_preview: true });
  return r.ok ? { ok: true, message_id: r.result.message_id } : { ok: false, message_id: null, description: r.description };
}
const postLink = (id: number | null) => (id ? `https://t.me/${CHANNEL.slice(1)}/${id}` : null);

// Журнал разовых действий (пост, напоминание) — чтобы ничего не ушло дважды
async function done(key: string) {
  return (await sql`select 1 from hk_log where key = ${key}`).length > 0;
}
async function markDone(key: string, message_id: number | null = null) {
  await sql`insert into hk_log (key, message_id) values (${key}, ${message_id}) on conflict (key) do nothing`;
}
const dateOf = (key: string) => new Date(key + "T00:00:00Z");

// Воскресенье, к которому относится новое имя: ближайшее, если анонс ещё не вышел.
async function targetSunday(): Promise<Date> {
  const now = nowTb();
  let s = nextSunday(now);
  const w = await getWeek(ymd(s));
  const missed = now.getUTCDay() === 6 && now.getUTCHours() >= 17; // субботнее окно публикации прошло
  if (w?.published_at || missed) s = new Date(s.getTime() + 7 * DAY);
  return s;
}

// ---------------- программа и текст поста ----------------
const DEFAULT_BLOCKS: Block[] = [
  { t: "13:00", text: "Час силы: совместная джапа-медитация.", tag: "джапа", off: true }, // по умолчанию без джапы, начало в 14:00
  { t: "14:00", text: "Киртан 🎶", tag: "киртан" },
  { t: "15:00", text: "Лекция по философии сознания Кришны", tag: "лекция", lect: true },
  { t: "16:00", text: "Киртан 🎶", tag: "киртан" },
  { t: "17:00", text: "Прасад 🍚", tag: "прасад" },
];
function blocksOf(w: Week | null): Block[] {
  const b = w?.blocks;
  return (Array.isArray(b) && b.length ? b : DEFAULT_BLOCKS).map((x) => ({ ...x }));
}
const sortBlocks = (b: Block[]) => b.sort((x, y) => x.t.localeCompare(y.t));
function clock(t: string) {
  const [h, m] = t.split(":").map(Number);
  return String.fromCodePoint((m >= 30 ? 0x1F55C : 0x1F550) + ((h % 12) || 12) - 1);
}
function blockLine(b: Block, lecturer: string | null) {
  const lect = b.lect ? `${lecturer ? ` (лектор — ${esc(lecturer)})` : ""}.` : "";
  return `${clock(b.t)} ${b.t} — ${esc(b.text)}${lect}`;
}

// Джапа: воскресенье с джапой начинается в 13:00, без джапы — в 14:00
const isJapa = (b: Block) => b.tag === "джапа";
const japaOn = (w: Week | null) => blocksOf(w).some((b) => isJapa(b) && !b.off);
function withJapa(w: Week | null, on: boolean): Block[] {
  const bl = blocksOf(w);
  const j = bl.find(isJapa);
  if (j) j.off = !on;
  else if (on) bl.push({ ...DEFAULT_BLOCKS[0], off: false });
  return sortBlocks(bl);
}
const sundayStart = (w: Week | null) => blocksOf(w).filter((b) => !b.off).map((b) => b.t).sort()[0] ?? "14:00";

export function caption(sunday: Date, w: Week | null) {
  const lines = [
    "🙏Харе Кришна, дорогие друзья!",
    "",
    `Приглашаем вас завтра, ${human(sunday)}, на воскресный пир любви! 🌸`,
  ];
  if (w?.note) lines.push("", `✨ ${esc(w.note)}`);
  for (const b of blocksOf(w).filter((b) => !b.off)) lines.push("", blockLine(b, w?.lecturer ?? null));
  lines.push("", `📍 ул. Чайковского, 82 — <a href="${ADDRESS_LINK}">как добраться</a>`, "В расписании возможны небольшие изменения.",
    `🔔 <a href="${BOT_LINK}?start=remind">Напомнить мне за 2 часа</a>`);
  return lines.join("\n");
}

// ---------------- афиша ----------------
const W = 1080, H = 1350;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const pick = <T>(r: R, xs: T[]) => xs[Math.floor(r() * xs.length)];
const uni = (r: R, a: number, b: number) => a + r() * (b - a);
const rint = (r: R, a: number, b: number) => Math.floor(uni(r, a, b + 1));

type Txt = { small: string; t1: string; t2: string; date: string; lect: string; acts: string; note: string[] };
type Col = { small: string; title: string; accent: string; body: string };

function textBlock(c: Col, t: Txt, align: "middle" | "start", x: number, y0: number) {
  const lx1 = align === "middle" ? x - 60 : x, lx2 = align === "middle" ? x + 60 : x + 120;
  const lsize = t.lect.length > 30 ? Math.max(24, Math.floor(34 * 30 / t.lect.length)) : 34;
  return `
  <text x="${x}" y="${y0}" text-anchor="${align}" font-family="Inter" font-weight="500" font-size="30" letter-spacing="7" fill="${c.small}">${esc(t.small)}</text>
  <text x="${x}" y="${y0 + 130}" text-anchor="${align}" font-family="Lora" font-style="italic" font-size="96" fill="${c.title}">${esc(t.t1)}</text>
  <text x="${x}" y="${y0 + 240}" text-anchor="${align}" font-family="Lora" font-style="italic" font-size="96" fill="${c.title}">${esc(t.t2)}</text>
  <line x1="${lx1}" y1="${y0 + 300}" x2="${lx2}" y2="${y0 + 300}" stroke="${c.accent}" stroke-width="3"/>
  <text x="${x}" y="${y0 + 380}" text-anchor="${align}" font-family="Inter" font-weight="600" font-size="44" fill="${c.body}">${esc(t.date)}</text>
  ${t.lect ? `<text x="${x}" y="${y0 + 450}" text-anchor="${align}" font-family="Inter" font-weight="400" font-size="${lsize}" fill="${c.body}" opacity="0.85">${esc(t.lect)}</text>` : ""}
  ${t.acts ? `<text x="${x}" y="${y0 + (t.lect ? 510 : 450)}" text-anchor="${align}" font-family="Inter" font-weight="400" font-size="28" letter-spacing="2" fill="${c.body}" opacity="0.65">${esc(t.acts)}</text>` : ""}
  ${t.note.map((l, i) => `<text x="${x}" y="${y0 + (t.lect ? 510 : 450) + (t.acts ? 80 : 20) + i * 50}" text-anchor="${align}" font-family="Lora" font-style="italic" font-size="40" fill="${c.accent}">${esc(l)}</text>`).join("")}`;
}

function lotus(r: R, t: Txt) {
  const bg = pick(r, ["#F6EFE3", "#F4ECE6", "#F7F1E8"]);
  const st = pick(r, ["#C2603A", "#B5543F", "#C9743A"]);
  const cx = 540 + rint(r, -40, 40), cy = 1240;
  const n = pick(r, [7, 9]);
  let petals = "";
  for (let i = 0; i < n; i++) {
    const k = (i / (n - 1)) * 2 - 1;
    const ang = k * uni(r, 68, 78);
    const L = 330 * (1 - 0.35 * Math.abs(k) ** 1.5) * uni(r, 0.96, 1.04);
    const w = 70 + 20 * (1 - Math.abs(k));
    const d = `M0,0 C${w},${-L * 0.35} ${w * 0.55},${-L * 0.85} 0,${-L} C${-w * 0.55},${-L * 0.85} ${-w},${-L * 0.35} 0,0 Z`;
    petals += `<path d="${d}" transform="translate(${cx},${cy}) rotate(${ang.toFixed(1)})" fill="${st}" fill-opacity="0.06" stroke="${st}" stroke-width="3"/>`;
  }
  let waves = "";
  for (let k = 0; k < 3; k++) {
    waves += `<path d="M${120 + k * 30},${cy + 40 + k * 28} Q540,${cy + 10 + k * 28} ${960 - k * 30},${cy + 40 + k * 28}" fill="none" stroke="${st}" stroke-opacity="${(0.5 - k * 0.12).toFixed(2)}" stroke-width="2.5"/>`;
  }
  const c = { small: st, title: "#3A2A22", accent: st, body: "#3A2A22" };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${petals}${waves}${textBlock(c, t, "middle", 540, 170)}</svg>`;
}

function peacock(r: R, t: Txt) {
  const bg = pick(r, ["#0E2A33", "#102530", "#13263A"]);
  const gold = "#D9B25F";
  const ang = uni(r, -28, -14);
  const ex = 790 + rint(r, -30, 30), ey = 800 + rint(r, -30, 30);
  let barbs = "";
  for (let k = 0; k < 70; k++) {
    const s = k / 70;
    const y = -170 + s * 620;
    const len = 210 * (1 - s) ** 0.6 + 20;
    for (const side of [-1, 1]) {
      const x2 = side * len * 0.95, y2 = y + len * 0.55;
      barbs += `<path d="M0,${y.toFixed(1)} Q${(x2 * 0.5).toFixed(1)},${(y + len * 0.05).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${gold}" stroke-opacity="${(0.18 + 0.22 * (1 - s)).toFixed(2)}" stroke-width="1.6" fill="none"/>`;
    }
  }
  const eye = `<ellipse cx="0" cy="0" rx="135" ry="180" fill="#2E7D6B" fill-opacity="0.55"/>
    <ellipse cx="0" cy="10" rx="105" ry="140" fill="#1B9AA0"/>
    <ellipse cx="0" cy="25" rx="78" ry="100" fill="#B8863B"/>
    <ellipse cx="0" cy="38" rx="58" ry="72" fill="#1D3F8F"/>
    <ellipse cx="0" cy="48" rx="34" ry="42" fill="#0B1B4A"/>`;
  const feather = `<g transform="translate(${ex},${ey}) rotate(${ang.toFixed(1)})">${barbs}<line x1="0" y1="-120" x2="0" y2="520" stroke="${gold}" stroke-width="3"/>${eye}</g>`;
  const c = { small: gold, title: "#F3EBD8", accent: gold, body: "#F3EBD8" };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${feather}${textBlock(c, t, "start", 100, 170)}</svg>`;
}

function sunset(r: R, t: Txt) {
  const top = pick(r, ["#F7D9B0", "#F5D2B8", "#F8DDB5"]);
  const mid = pick(r, ["#EFA27A", "#EC9A86", "#F0A870"]);
  const hz = 960 + rint(r, -20, 20);
  const sx = 540 + rint(r, -160, 160);
  let lines = "";
  for (let k = 0; k < 14; k++) {
    const y = hz + 30 + k * 26 + rint(r, -4, 4);
    const wl = (260 - k * 12) * uni(r, 0.7, 1.1);
    lines += `<line x1="${(sx - wl / 2).toFixed(0)}" y1="${y}" x2="${(sx + wl / 2).toFixed(0)}" y2="${y}" stroke="#F6C89A" stroke-opacity="${(0.7 - k * 0.04).toFixed(2)}" stroke-width="5" stroke-linecap="round"/>`;
  }
  const c = { small: "#8A3E2E", title: "#3B1F2B", accent: "#8A3E2E", body: "#3B1F2B" };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs><rect width="${W}" height="${hz}" fill="url(#sky)"/><circle cx="${sx}" cy="${hz + 10}" r="120" fill="#FFF1D6" fill-opacity="0.9"/><rect y="${hz}" width="${W}" height="${H - hz}" fill="#22405C"/>${lines}${textBlock(c, t, "middle", 540, 170)}</svg>`;
}

const THEMES = [lotus, peacock, sunset]; // по очереди, неделя за неделей

// На афишу: примечание, а если его нет — отмеченный праздник в само воскресенье
function posterNote(sunday: Date, w: Week | null) {
  return w?.note ?? "";
}
function wrap(s: string, n: number, maxLines: number) {
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(/\s+/)) {
    if ((cur + " " + word).trim().length > n && cur) { out.push(cur); cur = word; } else cur = (cur + " " + word).trim();
  }
  if (cur) out.push(cur);
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.?$/, "…"); }
  return out;
}

// Афиша: тема меняется по очереди (воскресенья — неделя за неделей, будни — день за днём)
type Poster = { seed: number; small?: string; t1: string; t2: string; date: string; lect?: string; acts: string; note?: string };
export function posterSvg(p: Poster) {
  const r = rng(p.seed * 7919 + 17);
  const theme = p.seed % THEMES.length;
  const t: Txt = {
    small: p.small ?? "ХАРЕ КРИШНА БАТУМИ", t1: p.t1, t2: p.t2, date: p.date, lect: p.lect ?? "", acts: p.acts,
    note: wrap(p.note ?? "", theme === 1 ? 21 : 26, 2),
  };
  return { svg: THEMES[theme](r, t), t };
}
function sundayPoster(sunday: Date, w: Week | null): Poster {
  const on = blocksOf(w).filter((b) => !b.off);
  return {
    seed: Math.floor(sunday.getTime() / (7 * DAY)), t1: "Воскресный", t2: "пир любви",
    date: `${human(sunday)} · с ${sundayStart(w)}`,
    lect: w?.lecturer && on.some((b) => b.lect) ? `Лекция: ${w.lecturer}` : "",
    acts: [...new Set(on.map((b) => b.tag).filter(Boolean))].join(" · "),
    note: posterNote(sunday, w),
  };
}

// Шрифты: Google Fonts отдаёт TTF-подмножество ровно под нужный текст.
const fontCache = new Map<string, Uint8Array>();
async function gfont(family: string, spec: string, text: string) {
  const key = family + spec + text;
  const hit = fontCache.get(key);
  if (hit) return hit;
  const css = await (await fetch(
    `https://fonts.googleapis.com/css2?family=${family}:${spec}&text=${encodeURIComponent(text)}`,
  )).text();
  const m = css.match(/src:\s*url\(([^)]+)\)/);
  if (!m) throw new Error("font css: " + css.slice(0, 200));
  const buf = new Uint8Array(await (await fetch(m[1])).arrayBuffer());
  fontCache.set(key, buf);
  return buf;
}

let wasmReady: Promise<void> | null = null;
const renderPng = (sunday: Date, w: Week | null) => renderPoster(sundayPoster(sunday, w));
async function renderPoster(p: Poster): Promise<Uint8Array> {
  wasmReady ??= initWasm(fetch("https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm"));
  const { svg, t } = posterSvg(p);
  const [lora, i500, i600, i400] = await Promise.all([
    gfont("Lora", "ital,wght@1,400", t.t1 + " " + t.t2 + " " + t.note.join(" ")),
    gfont("Inter", "wght@500", t.small),
    gfont("Inter", "wght@600", t.date),
    gfont("Inter", "wght@400", t.lect + " " + t.acts + " ."),
    wasmReady,
  ]) as Uint8Array[];
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontBuffers: [lora, i500, i600, i400], defaultFontFamily: "Inter", loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

// ---------------- вайшнавский календарь (из мини-приложения, время — для Батуми) ----------------
const CAL_URL = APP_URL + "calendar.json";
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WD_IN = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"];
const WD_FULL = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const festDay = (day: string) => { const d = dateOf(day); return `${WD[d.getUTCDay()]} ${human(d)}`; };
type CalEv = { kind: string; title: string; date: string; fast?: string; note?: string;
  parana?: { date: string; from: string; to?: string; fromNote?: string; toNote?: string } };

let calCache: { at: number; ev: CalEv[]; bot?: string } | null = null;
async function calendar() {
  if (calCache && Date.now() - calCache.at < 3600_000) return calCache;
  const d = await (await fetch(CAL_URL, { headers: { "cache-control": "no-cache" } })).json();
  calCache = { at: Date.now(), ev: d.events as CalEv[], bot: d.reminderBot };
  return calCache;
}
const ICON: Record<string, string> = { ekadashi: "🌙", major: "🔶", festival: "🌼", acharya: "•" };

function ekadashiPost(ev: CalEv, bot?: string) {
  const d = dateOf(ev.date);
  const p = ev.parana;
  const lines = [
    `🌙 <b>Завтра, ${WD_IN[d.getUTCDay()]} ${human(d)}, — ${esc(ev.title)}</b>`,
    "",
    "День поста: воздерживаемся от зерновых и бобовых, больше времени уделяем повторению святых имён и чтению.",
  ];
  if (p) {
    const pd = dateOf(p.date);
    lines.push("", `⏰ Выход из поста ${WD_IN[pd.getUTCDay()]} ${human(pd)}: ${p.to ? `с ${p.from} до ${p.to}` : `после ${p.from}`} (время Батуми).`);
  }
  if (bot) lines.push("", `🔔 Напоминания об экадаши: ${bot.replace("https://t.me/", "@")}`);
  lines.push("", "Харе Кришна! 🙏");
  return lines.join("\n");
}

// Накануне экадаши — пост в канал; накануне больших праздников — напоминание админам
async function festRemind(test = false) {
  const { ev, bot } = await calendar();
  const tomorrow = ymd(new Date(dayStart(nowTb()).getTime() + DAY));
  if (test) {
    const e = ev.find((x) => x.kind === "ekadashi" && x.date >= tomorrow);
    if (!e) return { ok: false, reason: "no ekadashi ahead" };
    await notifyAdmins(`🧪 Так будет выглядеть пост в канале накануне экадаши (${festDay(e.date)}):\n\n${ekadashiPost(e, bot)}`);
    return { ok: true, test: true };
  }
  const evs = ev.filter((x) => x.date === tomorrow);
  const ek = evs.find((x) => x.kind === "ekadashi");
  const out: string[] = [];
  if (ek && !(await done(`ek:${tomorrow}`))) {
    const r = await channelPost(null, ekadashiPost(ek, bot));
    if (r.ok) await markDone(`ek:${tomorrow}`, r.message_id);
    out.push(r.ok ? "ekadashi posted" : `ekadashi failed: ${r.description}`);
  }
  const key = evs.filter((x) => x.kind === "major" || x.kind === "ekadashi");
  if (key.length && !(await done(`fa:${tomorrow}`))) {
    await markDone(`fa:${tomorrow}`);
    await notifyAdmins(`🔶 <b>Завтра, ${festDay(tomorrow)} — особый день</b>\n\n` +
      evs.map((x) => `${ICON[x.kind] ?? "•"} ${esc(x.title)}${x.fast ? ` <i>(${esc(x.fast)})</i>` : ""}`).join("\n"));
    out.push("admins reminded");
  }
  return { ok: true, done: out };
}

// ---------------- вторник и четверг: прасад и киртан ----------------
type Day = { day: string; cancelled: boolean; time: string | null; note: string | null };
const WEEKDAY_START = "16:00";
const WEEKDAY_BLOCKS = [{ t: "16:00", text: "Прасад 🍚", tag: "прасад" }, { t: "17:00", text: "Киртан 🎶", tag: "киртан" }];
const isWeekday = (key: string) => [2, 4].includes(dateOf(key).getUTCDay());
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

async function getDay(key: string): Promise<Day | null> {
  const r = await sql`select day::text as day, cancelled, time, note from hk_days where day = ${key}`;
  return (r[0] as unknown as Day) ?? null;
}
async function saveDay(key: string, patch: Partial<Day>) {
  await sql`insert into hk_days (day) values (${key}) on conflict (day) do nothing`;
  await sql`update hk_days set ${sql({ ...patch, updated_at: new Date().toISOString() } as any)} where day = ${key}`;
}
function weekdayBlocks(d: Day | null) {
  const shift = toMin(d?.time ?? WEEKDAY_START) - toMin(WEEKDAY_START);
  return WEEKDAY_BLOCKS.map((b) => ({ ...b, t: fromMin(toMin(b.t) + shift) }));
}

function weekdayCaption(key: string, d: Day | null) {
  const date = dateOf(key);
  const lines = ["🙏 Харе Кришна, дорогие друзья!", "", `Сегодня, ${WD_IN[date.getUTCDay()]} ${human(date)}, ждём вас в храме! 🌸`];
  if (d?.note) lines.push("", `✨ ${esc(d.note)}`);
  for (const b of weekdayBlocks(d)) lines.push("", blockLine(b, null));
  lines.push("", `📍 ул. Чайковского, 82 — <a href="${ADDRESS_LINK}">как добраться</a>`,
    `🔔 <a href="${BOT_LINK}?start=remind">Напомнить мне за 2 часа</a>`);
  return lines.join("\n");
}
function weekdayPoster(key: string, d: Day | null): Poster {
  const date = dateOf(key);
  return {
    seed: Math.floor(date.getTime() / DAY), t1: "Прасад", t2: "и киртан",
    date: `${WD_FULL[date.getUTCDay()]}, ${human(date)} · ${d?.time ?? WEEKDAY_START}`,
    acts: "прасад · киртан", note: d?.note ?? "",
  };
}

// Пост в 10:00 в день программы
async function weekdayPost(key: string, force = false) {
  if (!isWeekday(key)) return { ok: false, reason: "not a program day" };
  if (!force && (await done(`wd:${key}`))) return { ok: false, reason: "already posted" };
  const d = await getDay(key);
  if (d?.cancelled) {
    if (!(await done(`wd:${key}`))) { await markDone(`wd:${key}`); await notifyAdmins(`⏸ Сегодня, ${human(dateOf(key))}, программы нет — пост в канал не публикую.`); }
    return { ok: false, reason: "cancelled" };
  }
  let png: Uint8Array | null = null;
  try { png = await renderPoster(weekdayPoster(key, d)); } catch (e) { console.error(e); }
  const r = await channelPost(png, weekdayCaption(key, d));
  if (!r.ok) {
    await notifyAdmins(`⚠️ Не удалось опубликовать пост о сегодняшней программе: ${esc(r.description ?? "ошибка")}. Попробую ещё раз через 15 минут.`);
    return { ok: false, reason: r.description };
  }
  await markDone(`wd:${key}`, r.message_id);
  return { ok: true, test: r.test ?? false };
}

// Ближайшие вторники и четверги — для админов
function nextWeekdays(n: number) {
  const out: string[] = [];
  const now = nowTb();
  let d = dayStart(now);
  if (now.getUTCHours() >= 18) d = new Date(d.getTime() + DAY);
  while (out.length < n) { if (isWeekday(ymd(d))) out.push(ymd(d)); d = new Date(d.getTime() + DAY); }
  return out;
}
const short = (key: string) => { const d = dateOf(key); return `${WD[d.getUTCDay()]} ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

async function showWeekdays(chatId: number, editMsgId?: number) {
  const days = nextWeekdays(4);
  const lines = ["📅 <b>Вторник и четверг — прасад и киртан</b>", "<i>Обычно в 16:00. В день программы в 10:00 выходит пост в канале, подписчикам — напоминание за 2 часа.</i>", ""];
  const kb: unknown[][] = [];
  for (const key of days) {
    const d = await getDay(key);
    const t = d?.time ?? WEEKDAY_START;
    lines.push(d?.cancelled ? `🚫 <s>${festDay(key)}, ${t}</s> — отменено` : `✅ <b>${festDay(key)}, ${t}</b>${d?.time ? " (время изменено)" : ""}${d?.note ? `\n     ✨ ${esc(d.note)}` : ""}`);
    kb.push([
      d?.cancelled ? { text: `↩️ Вернуть ${short(key)}`, callback_data: `dc:${key}` } : { text: `🚫 Отменить ${short(key)}`, callback_data: `dc:${key}` },
      { text: `✏️ ${short(key)}`, callback_data: `de:${key}` },
    ]);
  }
  lines.push("", "<i>✏️ — изменить время или добавить примечание (например, «Дамодараштака»).</i>");
  const text = lines.join("\n");
  if (editMsgId) {
    const r = await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    if (r.ok || String(r.description).includes("not modified")) return;
  }
  await say(chatId, text, { inline_keyboard: kb });
}

async function toggleWeekday(chatId: number, key: string) {
  const d = await getDay(key);
  const cancel = !d?.cancelled;
  await saveDay(key, { cancelled: cancel });
  const today = ymd(dayStart(nowTb()));
  if (key !== today) return;
  // Отмена/возврат в сам день: если пост уже вышел — сообщаем в канале и тем, кому ушло напоминание
  const posted = await done(`wd:${key}`);
  if (cancel && posted) {
    const r = await channelPost(null, `❗ <b>Сегодняшняя программа (${human(dateOf(key))}) отменяется.</b>\n\nПросим прощения! Следите за анонсами в канале. 🙏`);
    if (r.ok) await say(chatId, "📣 В канал отправлено сообщение об отмене.");
  }
  if (cancel && (await done(`rm:${key}`))) await notifySubs(`❗ Сегодняшняя программа в храме (${human(dateOf(key))}) отменяется. Просим прощения 🙏`);
  if (!cancel && posted) await say(chatId, "ℹ️ Сегодня уже выходило сообщение. Если нужно, напишите в канал, что программа всё-таки состоится.");
}

async function onWeekdayText(chatId: number, userId: number, key: string, text: string) {
  const m = text.trim().match(/^(\d{1,2})[:.](\d{2})\s*[—–-]?\s*([\s\S]*)$/);
  const patch: Partial<Day> = {};
  let rest = text.trim();
  if (m) {
    if (Number(m[1]) > 23 || Number(m[2]) > 59) return void (await say(chatId, "Не понял время. Пример: <code>17:00</code>", CANCEL));
    const t = `${m[1].padStart(2, "0")}:${m[2]}`;
    patch.time = t === WEEKDAY_START ? null : t;
    rest = m[3].trim();
  }
  if (rest === "-") patch.note = null;
  else if (rest) patch.note = rest.slice(0, 120);
  await setPending(userId, null);
  await saveDay(key, patch);
  await showWeekdays(chatId);
}

// ---------------- программы по дням (для напоминаний и мини-приложения) ----------------
const plain = (s: string) => s.replace(/[\p{Extended_Pictographic}️]/gu, "").replace(/\s+/g, " ").trim();
type Program = { date: string; id: string; title: string; start: string; end: string; cancelled: boolean; confirmed: boolean;
  lecturer: string | null; japa?: boolean; note: string | null; program: [string, string][] };

async function programOn(key: string): Promise<Program | null> {
  const wd = dateOf(key).getUTCDay();
  if (wd === 0) {
    const w = await getWeek(key);
    const on = blocksOf(w).filter((b) => !b.off);
    return {
      date: key, id: "sunday", title: "Воскресный пир любви", start: sundayStart(w), end: "18:00",
      cancelled: !!w?.skipped, confirmed: !!(w?.published_at || w?.lecturer || w?.blocks),
      lecturer: w?.lecturer || null, japa: japaOn(w), note: w?.note ?? null,
      program: on.map((b) => [b.t, plain(b.text) + (b.lect && w?.lecturer ? ` (${w.lecturer})` : "")]),
    };
  }
  if (wd === 2 || wd === 4) {
    const d = await getDay(key);
    const start = d?.time ?? WEEKDAY_START;
    return {
      date: key, id: wd === 2 ? "tuesday" : "thursday", title: "Прасад и киртан", start, end: fromMin(toMin(start) + 120),
      cancelled: !!d?.cancelled, confirmed: !!d || (await done(`wd:${key}`)), lecturer: null, note: d?.note ?? null,
      program: weekdayBlocks(d).map((b) => [b.t, plain(b.text)]),
    };
  }
  return null;
}

async function schedule() {
  const today = dayStart(nowTb());
  const items: Program[] = [];
  for (let i = 0; i < 14; i++) {
    const p = await programOn(ymd(new Date(today.getTime() + i * DAY)));
    if (p) items.push(p);
  }
  // live=false — бот в тестовом режиме, мини-приложение тогда показывает расписание из content.json
  return { ok: true, live: await isLive(), tz: "Asia/Tbilisi", updated: new Date().toISOString(), items };
}

// ---------------- подписчики: личные напоминания за 2 часа ----------------
async function isSub(userId: number) {
  return (await sql`select 1 from hk_subs where user_id = ${userId} and active`).length > 0;
}
async function setSub(user: any, chatId: number, on: boolean) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  await sql`insert into hk_subs (user_id, chat_id, name, username, active) values (${user.id}, ${chatId}, ${name}, ${user.username ?? null}, ${on})
    on conflict (user_id) do update set chat_id = excluded.chat_id, name = excluded.name, username = excluded.username, active = excluded.active, updated_at = now()`;
}
const SUB_TEXT = "🙏 Харе Кришна!\n\nЯ могу напоминать о программах храма в Батуми — за 2 часа до начала:\n• воскресенье — пир любви (киртан, лекция, прасад)\n• вторник и четверг — прасад и киртан\n\nЕсли программу отменят или перенесут, тоже сообщу.";
async function subKb(userId: number) {
  const on = await isSub(userId);
  return { inline_keyboard: [
    [on ? { text: "🔕 Не напоминать", callback_data: "unsub" } : { text: "🔔 Напоминать мне", callback_data: "sub" }],
    [{ text: "📱 Расписание и молитвы", web_app: { url: APP_URL } }],
  ] };
}
async function showSub(chatId: number, userId: number, editMsgId?: number) {
  const on = await isSub(userId);
  const text = SUB_TEXT + (on ? "\n\n✅ <b>Напоминания включены.</b>" : "");
  const kb = await subKb(userId);
  if (editMsgId) {
    const r = await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text, parse_mode: "HTML", reply_markup: kb });
    if (r.ok || String(r.description).includes("not modified")) return;
  }
  await say(chatId, text, kb);
}

async function notifySubs(text: string, kb?: unknown) {
  const subs = await sql`select user_id, chat_id from hk_subs where active`;
  let sent = 0;
  for (const s of subs) {
    const r = await say(Number(s.chat_id), text, kb);
    if (r.ok) sent++;
    else if (r.error_code === 403) await sql`update hk_subs set active = false where user_id = ${s.user_id}`; // бот заблокирован
    await new Promise((res) => setTimeout(res, 40)); // не больше ~25 сообщений в секунду
  }
  return sent;
}

async function personalReminders(now: Date) {
  const key = ymd(dayStart(now));
  const p = await programOn(key);
  if (!p || p.cancelled) return "no program";
  const nowM = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = toMin(p.start);
  if (nowM < start - 120 || nowM >= start - 30) return "not time";
  if (await done(`rm:${key}`)) return "already sent";
  await markDone(`rm:${key}`);
  const what = p.id === "sunday"
    ? `воскресная программа: ${p.program.map(([t, s]) => `${t} ${s.toLowerCase()}`).join(", ")}`
    : `прасад и киртан`;
  const sent = await notifySubs(
    `🔔 <b>Сегодня в ${p.start}</b> — ${esc(what)}.${p.note ? `\n✨ ${esc(p.note)}` : ""}\n\n📍 ул. Чайковского, 82 — <a href="${ADDRESS_LINK}">как добраться</a>\n\nЖдём вас! Харе Кришна 🙏`,
    { inline_keyboard: [[{ text: "🔕 Больше не напоминать", callback_data: "unsub" }]] },
  );
  return `sent ${sent}`;
}

// Раз в 15 минут (pg_cron): всё, что пора сделать
async function tick() {
  const now = nowTb();
  const h = now.getUTCHours(), wd = now.getUTCDay();
  const today = ymd(dayStart(now));
  const res: Record<string, unknown> = {};
  const run = async (name: string, f: () => Promise<unknown>) => {
    try { res[name] = await f(); } catch (e) { console.error(name, e); res[name] = String((e as Error)?.message ?? e); }
  };
  if (wd === 6 && h >= 14 && h < 17) await run("publish", () => publish());
  if ((wd === 5 && h === 19) || (wd === 6 && h === 11)) await run("remind", () => remind());
  if ((wd === 2 || wd === 4) && h >= 10 && h < 13) await run("weekday", () => weekdayPost(today));
  if (h >= 18 && h < 21) await run("fest", () => festRemind());
  await run("personal", () => personalReminders(now));
  return { ok: true, at: now.toISOString().slice(0, 16), ...res };
}

// ---------------- воскресный анонс ----------------
async function publish(force = false) {
  const now = nowTb();
  const h = now.getUTCHours();
  if (!force && !(now.getUTCDay() === 6 && h >= 14 && h < 17)) return { ok: false, reason: "not publish time" };
  const sunday = nextSunday(now);
  const key = ymd(sunday);
  const w = await getWeek(key);
  if (w?.published_at) return { ok: false, reason: "already published" };
  if (w?.skipped) {
    if (!(await done(`sk:${key}`))) {
      await markDone(`sk:${key}`);
      await notifyAdmins(`⏸ Анонс на ${human(sunday)} не публикуем — так было отмечено в боте.`);
    }
    return { ok: false, reason: "skipped" };
  }
  const final = h >= 15; // попытки каждые 15 минут с 14:00; с 15:00 — публикуем даже без афиши
  let png: Uint8Array | null = null;
  try { png = await renderPng(sunday, w); } catch (e) {
    if (!final) {
      await notifyAdmins(`⚠️ Не получилось подготовить афишу (${esc(String((e as Error)?.message ?? e))}). Попробую ещё раз через 15 минут.`);
      return { ok: false, reason: "render failed, will retry" };
    }
  }
  const res = await channelPost(png, caption(sunday, w));
  if (!res.ok) {
    await notifyAdmins(`⚠️ Не удалось опубликовать анонс: ${esc(res.description ?? "ошибка")}. ` +
      (final ? "Пожалуйста, опубликуйте его вручную." : "Попробую ещё раз через 15 минут."));
    return { ok: false, reason: res.description };
  }
  await saveWeek(key, { published_at: new Date().toISOString(), message_id: res.message_id });
  const url = postLink(res.message_id);
  const kb: unknown[][] = [[{ text: "✏️ Что-то поменялось? Исправить", callback_data: `wk:${key}` }]];
  if (url) kb.unshift([{ text: "🔗 Открыть пост", url }]);
  await notifyAdmins(
    `✅ Анонс на ${human(sunday)} ${res.test ? "подготовлен (тестовый режим — в канал не ушёл)" : "опубликован"}${w?.lecturer ? "" : " (без имени лектора)"}.\nСпасибо за служение! 🙏`,
    { inline_keyboard: kb },
  );
  return { ok: true, test: res.test ?? false };
}

async function remind() {
  const sunday = nextSunday(nowTb());
  const key = ymd(sunday);
  const w = await getWeek(key);
  if (w?.published_at || w?.skipped || w?.lecturer !== null && w?.lecturer !== undefined) return { ok: true, reason: "nothing to remind" };
  if (w?.reminded_at && Date.now() - Date.parse(w.reminded_at) < 3 * 3600 * 1000) return { ok: true, reason: "recently reminded" };
  await notifyAdmins(
    `🔔 <b>Воскресенье, ${human(sunday)}</b>\n\n🎤 Кто читает лекцию? Нажмите имя или пришлите новое сообщением.\n🧘 Сейчас: <b>${japaOn(w) ? "с джапой, начало в 13:00" : "без джапы, начало в 14:00"}</b> — можно переключить кнопкой.\n\nАнонс уйдёт в канал в субботу в 14:00.`,
    await lecturerKb(key, null, true),
  );
  await saveWeek(key, { reminded_at: new Date().toISOString() });
  return { ok: true, reason: "reminded" };
}

async function setup() {
  const hook = await tg("setWebhook", {
    url: FN_URL, secret_token: await secretToken(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
  });
  const cmds = await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Напоминания о программах храма" },
      { command: "remind", description: "Включить или выключить напоминания" },
    ],
  });
  return { webhook: hook.ok, webhook_info: hook.description, commands: cmds.ok };
}

// ---------------- общие кнопки и тексты ----------------
const B = { lect: "✏️ Лектор", prog: "🗓 Программа", card: "📋 Анонс недели", days: "📅 Вт и Чт", fest: "🌼 Праздники", help: "❓ Помощь" };
const OLD = { set: "✏️ Указать лектора", prog: "🗓 Программа недели", status: "📋 Статус", preview: "👁 Предпросмотр", clear: "🗑 Убрать имя", skip: "⏸ Пропустить неделю" };
const MENU = { keyboard: [[{ text: B.lect }, { text: B.prog }], [{ text: B.card }, { text: B.days }], [{ text: B.fest }, { text: B.help }]], resize_keyboard: true, is_persistent: true };
const CANCEL = { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "cancel" }]] };

const HELP = `🙏 Харе Кришна! Я веду анонсы программ храма в канале «Харе Кришна Батуми»:
• <b>воскресенье</b> — анонс с афишей в субботу в 14:00;
• <b>вторник и четверг</b> — пост «Сегодня прасад и киртан» в 10:00 в день программы;
• <b>накануне экадаши</b> — пост в 18:00 с временем выхода из поста для Батуми.
Подписчикам (/remind) я напоминаю о программе за 2 часа до начала.

<b>Кнопки внизу:</b>
${B.lect} — кто читает лекцию в воскресенье
${B.prog} — пункты воскресной программы, джапа, примечание
${B.card} — как выйдет воскресный анонс + все настройки недели
${B.days} — отменить, перенести или дополнить программу во вторник и четверг
${B.fest} — ближайшие праздники и экадаши (для себя). Накануне особых дней 🔶 пришлю напоминание
${B.help} — эта подсказка

🧘 Воскресенье бывает с джапой (начало в 13:00) и без неё (в 14:00) — переключается в карточке анонса.

Ошиблись — просто выберите или пришлите другое имя. Если анонс уже вышел, изменения сразу обновят пост в канале.

Если имя лектора не прислали, я напомню в пятницу в 19:00 и в субботу в 11:00.`;

const bytes = (s: string) => new TextEncoder().encode(s).length;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const visibleLen = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot);/g, "x").length;

async function recentLecturers(exclude: string | null, key: string): Promise<string[]> {
  const rows = await sql`select lecturer from hk_weeks where coalesce(lecturer, '') <> ''
    group by lecturer order by max(updated_at) desc limit 10`;
  return rows.map((r) => r.lecturer as string)
    .filter((n) => n !== exclude && bytes(`ln:${key}:${n}`) <= 64).slice(0, 4);
}

const japaRow = (key: string, on: boolean) => [
  { text: on ? "✅ С джапой (13:00)" : "🧘 С джапой (13:00)", callback_data: `jp:${key}:1` },
  { text: on ? "Без джапы (14:00)" : "✅ Без джапы (14:00)", callback_data: `jp:${key}:0` },
];

async function lecturerKb(key: string, current: string | null, withSkip = false) {
  const names = await recentLecturers(current, key);
  const rows: unknown[][] = [];
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((n) => ({ text: `🎤 ${n}`, callback_data: `ln:${key}:${n}` })));
  rows.push([{ text: "✏️ Другое имя", callback_data: `set:${key}` }, { text: "🙅 Без имени", callback_data: `cl:${key}` }]);
  if (withSkip) {
    rows.push(japaRow(key, japaOn(await getWeek(key))));
    rows.push([{ text: "⏸ Программы не будет", callback_data: `sk:${key}` }]);
  }
  return { inline_keyboard: rows };
}

// Недели, доступные в карточке: от опубликованного (ещё не прошедшего) воскресенья до +8 недель
async function weekBounds() {
  const target = await targetSunday();
  const pub = await publishedWeek();
  return { min: ymd(pub ? pub.sunday : target), target: ymd(target), max: ymd(new Date(target.getTime() + 8 * 7 * DAY)) };
}

async function publishedWeek(): Promise<{ sunday: Date; w: Week } | null> {
  const now = nowTb();
  const sunday = now.getUTCDay() === 0 ? dayStart(now) : nextSunday(now);
  const w = await getWeek(ymd(sunday));
  return w?.published_at && w.message_id ? { sunday, w } : null;
}

// ---------------- карточка недели (одно сообщение: афиша + текст + кнопки) ----------------
async function cardData(key: string) {
  const sunday = dateOf(key);
  const w = await getWeek(key);
  const head: string[] = [`📅 <b>Воскресенье, ${human(sunday)}</b>`];
  head.push(w?.published_at ? "✅ Уже в канале — изменения сразу обновят пост"
    : w?.skipped ? "⏸ <b>Анонс НЕ будет опубликован</b>"
    : `🕑 Выйдет в субботу, ${human(new Date(sunday.getTime() - DAY))}, в 14:00`);
  head.push(w?.lecturer ? `🎤 Лекция: <b>${esc(w.lecturer)}</b>` : w?.lecturer === "" ? "🎤 Без имени лектора" : "🎤 Лектор пока не указан");
  head.push(japaOn(w) ? "🧘 С джапой — начало в 13:00" : "🎶 Без джапы — начало в 14:00");
  if (w?.blocks || w?.note) head.push("🗓 Программа на эту неделю изменена");
  const post = caption(sunday, w);
  let cap = head.join("\n") + "\n\n<i>Так анонс выйдет в канале:</i>\n\n" + post;
  const long = visibleLen(cap) > 1024;
  if (long) cap = head.join("\n") + "\n\n<i>Текст анонса длинный — нажмите «📄 Текст анонса».</i>";

  const { min, max } = await weekBounds();
  const kb: unknown[][] = [];
  const names = await recentLecturers(w?.lecturer ?? null, key);
  for (let i = 0; i < names.length; i += 2) kb.push(names.slice(i, i + 2).map((n) => ({ text: `🎤 ${n}`, callback_data: `ln:${key}:${n}` })));
  const r2: unknown[] = [{ text: "✏️ Другое имя", callback_data: `set:${key}` }];
  if (w?.lecturer) r2.push({ text: "🙅 Без имени", callback_data: `cl:${key}` });
  else if (w?.prev_lecturer && bytes(`ln:${key}:${w.prev_lecturer}`) <= 64) r2.push({ text: `↩️ Вернуть: ${trunc(w.prev_lecturer, 18)}`, callback_data: `ln:${key}:${w.prev_lecturer}` });
  kb.push(r2);
  kb.push(japaRow(key, japaOn(w)));
  kb.push([{ text: "🗓 Программа", callback_data: `pg:${key}` }]);
  if (!w?.published_at) kb.push([w?.skipped ? { text: "▶️ Всё-таки публиковать", callback_data: `sk:${key}` } : { text: "⏸ Не публиковать на этой неделе", callback_data: `sk:${key}` }]);
  const nav: unknown[] = [];
  const prev = ymd(new Date(sunday.getTime() - 7 * DAY)), next = ymd(new Date(sunday.getTime() + 7 * DAY));
  if (prev >= min) nav.push({ text: `◀️ ${human(dateOf(prev))}`, callback_data: `wk:${prev}` });
  if (next <= max) nav.push({ text: `${human(dateOf(next))} ▶️`, callback_data: `wk:${next}` });
  if (nav.length) kb.push(nav);
  const extra: unknown[] = [];
  if (long) extra.push({ text: "📄 Текст анонса", callback_data: `tx:${key}` });
  if (w?.published_at && w.message_id) extra.push({ text: "🔗 Пост в канале", url: `https://t.me/${CHANNEL.slice(1)}/${w.message_id}` });
  if (extra.length) kb.push(extra);
  return { png: await renderPng(sunday, w), cap, kb: { inline_keyboard: kb } };
}

async function sendCard(chatId: number, key: string) {
  const c = await cardData(key);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("photo", new Blob([c.png as BlobPart], { type: "image/png" }), "afisha.png");
  fd.append("caption", c.cap);
  fd.append("parse_mode", "HTML");
  fd.append("reply_markup", JSON.stringify(c.kb));
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
}

async function editCard(chatId: number, msgId: number, key: string) {
  const c = await cardData(key);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("message_id", String(msgId));
  fd.append("media", JSON.stringify({ type: "photo", media: "attach://img", caption: c.cap, parse_mode: "HTML" }));
  fd.append("img", new Blob([c.png as BlobPart], { type: "image/png" }), "afisha.png");
  fd.append("reply_markup", JSON.stringify(c.kb));
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageMedia`, { method: "POST", body: fd })).json();
  if (!r.ok && !String(r.description).includes("not modified")) await sendCard(chatId, key);
}

// Показать карточку: если нажали кнопку под карточкой — обновить её, иначе прислать новую
async function showCard(chatId: number, key: string, msg?: any, done?: string) {
  if (msg?.photo) return await editCard(chatId, msg.message_id, key);
  if (msg?.message_id && done) await tg("editMessageText", { chat_id: chatId, message_id: msg.message_id, text: done, parse_mode: "HTML" });
  await sendCard(chatId, key);
}

async function editPublished(sunday: Date) {
  const w = await getWeek(ymd(sunday));
  if (!w?.message_id) return;
  const png = await renderPng(sunday, w);
  const fd = new FormData();
  fd.append("chat_id", CHANNEL);
  fd.append("message_id", String(w.message_id));
  fd.append("media", JSON.stringify({ type: "photo", media: "attach://img", caption: caption(sunday, w), parse_mode: "HTML" }));
  fd.append("img", new Blob([png as BlobPart], { type: "image/png" }), "afisha.png");
  const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageMedia`, { method: "POST", body: fd })).json();
  if (r.ok || String(r.description).includes("not modified")) return;
  // пост мог выйти текстом без афиши — тогда правим текст
  const t = await tg("editMessageText", { chat_id: CHANNEL, message_id: w.message_id, text: caption(sunday, w), parse_mode: "HTML", disable_web_page_preview: true });
  if (!t.ok && !String(t.description).includes("not modified")) throw new Error(r.description ?? "не удалось изменить пост");
}

// Сохранить изменения недели. Если анонс не влезает в Telegram — откатить. Если уже опубликован — обновить пост.
async function changeWeek(chatId: number, key: string, patch: Partial<Week>): Promise<boolean> {
  const before = await getWeek(key);
  await saveWeek(key, patch);
  const w = await getWeek(key);
  if (visibleLen(caption(dateOf(key), w)) > 1024) {
    const undo: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) undo[k] = (before as any)?.[k] ?? null;
    await saveWeek(key, undo as Partial<Week>);
    await say(chatId, "⚠️ Анонс получается длиннее, чем позволяет Telegram (1024 знака). Уберите что-нибудь — например, лишний праздник или примечание.");
    return false;
  }
  if (w?.published_at && w.message_id) await editPublished(dateOf(key));
  return true;
}

async function setLecturer(chatId: number, key: string, name: string) {
  const w = await getWeek(key);
  const patch: Partial<Week> = { lecturer: name };
  if (name === "" && w?.lecturer) patch.prev_lecturer = w.lecturer;
  if (name) patch.skipped = false;
  await changeWeek(chatId, key, patch);
}

async function askLecturer(chatId: number, userId: number, key: string) {
  await setPending(userId, `lec:${key}`);
  const w = await getWeek(key);
  await say(chatId, `🎤 Кто читает лекцию в воскресенье, ${human(dateOf(key))}?\nНажмите имя или пришлите новое сообщением.`,
    { inline_keyboard: [...(await lecturerKb(key, w?.lecturer ?? null)).inline_keyboard, [{ text: "✖️ Отмена", callback_data: "cancel" }]] });
}

// ---------------- праздники недели ----------------
// Ближайшие праздники — только для админов, в анонс не попадают
async function showUpcoming(chatId: number, fromKey: string, editMsgId?: number) {
  const from = dateOf(fromKey), to = new Date(from.getTime() + 13 * DAY);
  const { ev } = await calendar();
  const inRange = ev.filter((x) => x.date >= fromKey && x.date <= ymd(to));
  const lines = [`🌼 <b>Праздники ${human(from)} — ${human(to)}</b>`, "<i>по календарю ИСККОН для Батуми. 🔶 🌙 — особые дни: о них напомню накануне.</i>", ""];
  if (!inRange.length) lines.push("В эти дни праздников нет.");
  for (const day of [...new Set(inRange.map((x) => x.date))]) {
    const evs = inRange.filter((x) => x.date === day);
    const key = evs.some((x) => x.kind === "major" || x.kind === "ekadashi");
    lines.push(key ? `🔶 <b>${festDay(day)} — особый день</b>` : `<b>${festDay(day)}</b>`);
    for (const e of evs) {
      const p = e.parana ? ` (выход из поста ${human(dateOf(e.parana.date))}, ${e.parana.from}${e.parana.to ? "–" + e.parana.to : ""})` : "";
      lines.push(`${ICON[e.kind] ?? "•"} ${esc(e.title)}${p}`);
    }
    lines.push("");
  }
  const last = ev.at(-1)?.date;
  if (last && last < ymd(to)) lines.push(`<i>Календарь загружен до ${human(dateOf(last))}.</i>`);
  const today = ymd(dayStart(nowTb()));
  const nav: unknown[] = [];
  const prev = ymd(new Date(from.getTime() - 14 * DAY));
  if (fromKey > today) nav.push({ text: "◀️ Раньше", callback_data: `fu:${prev < today ? today : prev}` });
  nav.push({ text: "Дальше ▶️", callback_data: `fu:${ymd(new Date(to.getTime() + DAY))}` });
  const text = lines.join("\n").trim();
  const kb = { inline_keyboard: [nav] };
  if (editMsgId) {
    const r = await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text, parse_mode: "HTML", reply_markup: kb });
    if (r.ok || String(r.description).includes("not modified")) return;
  }
  await say(chatId, text, kb);
}

// ---------------- программа недели ----------------
async function showProgram(chatId: number, key: string, editMsgId?: number) {
  const w = await getWeek(key);
  const bl = blocksOf(w);
  const lines = [`🗓 <b>Программа на ${human(dateOf(key))}</b>`];
  if (w?.published_at) lines.push("<i>Анонс уже в канале — изменения сразу обновят пост.</i>");
  lines.push("");
  if (w?.note) lines.push(`✨ ${esc(w.note)}`, "");
  for (const b of bl) lines.push(b.off ? `🚫 <s>${b.t} — ${esc(b.text)}</s>` : `✅ ${b.t} — ${esc(b.text)}`);
  lines.push("", "<i>Изменения действуют только на это воскресенье.</i>");
  const kb: unknown[][] = bl.map((b, i) => {
    const row: unknown[] = [
      { text: `${b.off ? "↩️ Вернуть" : "🚫 Убрать"} ${b.t}`, callback_data: `bt:${key}:${i}` },
      { text: `✏️ Изменить ${b.t}`, callback_data: `be:${key}:${i}` },
    ];
    if (b.custom) row.push({ text: "🗑", callback_data: `bd:${key}:${i}` });
    return row;
  });
  kb.push([{ text: "➕ Добавить пункт", callback_data: `ba:${key}` }, { text: "✨ Примечание", callback_data: `bn:${key}` }]);
  const extra: unknown[] = [];
  if (w?.note) extra.push({ text: "❌ Убрать примечание", callback_data: `bnx:${key}` });
  if (w?.blocks) extra.push({ text: "↩️ Обычная программа", callback_data: `br:${key}` });
  if (extra.length) kb.push(extra);
  kb.push([{ text: "⬅️ Готово — к анонсу", callback_data: `wk:${key}` }]);
  const text = lines.join("\n");
  if (editMsgId) {
    const r = await tg("editMessageText", { chat_id: chatId, message_id: editMsgId, text, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    if (r.ok || String(r.description).includes("not modified")) return;
  }
  await say(chatId, text, { inline_keyboard: kb });
}

function parseItem(text: string): { t?: string; text: string } | null {
  const m = text.trim().match(/^(\d{1,2})[:.](\d{2})\s*[—–-]?\s*([\s\S]*)$/);
  if (m) {
    const h = Number(m[1]), mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return { t: `${String(h).padStart(2, "0")}:${m[2]}`, text: m[3].trim().slice(0, 150) };
  }
  return { text: text.trim().slice(0, 150) };
}

async function onProgramText(chatId: number, userId: number, pending: string, text: string) {
  const [kind, key, idx] = pending.split(":");
  const bl = blocksOf(await getWeek(key));
  if (kind === "bn") {
    await setPending(userId, null);
    await changeWeek(chatId, key, { note: text.trim().slice(0, 200) });
    return void (await showProgram(chatId, key));
  }
  const item = parseItem(text);
  if (!item || !item.text) return void (await say(chatId, "Не понял. Пришлите так: <code>18:00 — Просмотр фильма</code>", CANCEL));
  if (kind === "ba") {
    if (!item.t) return void (await say(chatId, "Нужно время в начале, например: <code>18:00 — Просмотр фильма</code>", CANCEL));
    bl.push({ t: item.t, text: item.text, custom: true });
  } else {
    const b = bl[Number(idx)];
    if (!b) { await setPending(userId, null); return void (await showProgram(chatId, key)); }
    if (item.t) b.t = item.t;
    b.text = item.text;
    b.off = false;
  }
  await setPending(userId, null);
  await changeWeek(chatId, key, { blocks: sortBlocks(bl) });
  await showProgram(chatId, key);
}

// ---------------- доступ и состояние ----------------
// Кроме админов канала, ботом могут управлять эти пользователи (username без @, в нижнем регистре)
const EXTRA_USERS = ["radhaprandas", "salesmaker"];
async function isAdmin(userId: number, username?: string) {
  if (username && EXTRA_USERS.includes(username.toLowerCase())) return true;
  const r = await tg("getChatMember", { chat_id: CHANNEL, user_id: userId });
  return r.ok && ["creator", "administrator"].includes(r.result.status);
}
async function getPending(userId: number): Promise<string | null> {
  const r = await sql`select pending from hk_admins where user_id = ${userId}`;
  return (r[0]?.pending as string) ?? null;
}
async function setPending(userId: number, v: string | null) {
  await sql`update hk_admins set pending = ${v} where user_id = ${userId}`;
}
const cleanName = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 60);

// ---------------- входящие сообщения ----------------
async function onMessage(msg: any) {
  if (!msg?.chat || msg.chat.type !== "private" || typeof msg.text !== "string") return;
  const chatId = msg.chat.id as number;
  const user = msg.from;
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";
  const arg = cmd ? text.split(/\s+/)[1] ?? "" : "";
  // Прихожане: только подписка на напоминания
  if (cmd === "/remind" || (cmd === "/start" && arg === "remind")) return void (await showSub(chatId, user.id));
  if (!(await isAdmin(user.id, user.username))) return void (await showSub(chatId, user.id));
  await saveAdmin(user.id, chatId, [user.first_name, user.last_name].filter(Boolean).join(" "));
  const target = ymd(await targetSunday());
  const isOld = Object.values(OLD).includes(text);

  if (cmd === "/start" || cmd === "/help" || text === B.help) {
    await setPending(user.id, null);
    await say(chatId, HELP, MENU);
    if (cmd === "/start") await sendCard(chatId, target);
    return;
  }
  if (isOld) await say(chatId, "Меню обновилось 👇", MENU);
  if (text === B.card || cmd === "/status" || text === OLD.status || text === OLD.preview) {
    await setPending(user.id, null);
    return void (await sendCard(chatId, target));
  }
  if (text === B.days) { await setPending(user.id, null); return void (await showWeekdays(chatId)); }
  if (text === B.fest) { await setPending(user.id, null); return void (await showUpcoming(chatId, ymd(dayStart(nowTb())))); }
  if (text === B.lect || text === OLD.set) return void (await askLecturer(chatId, user.id, target));
  if (text === B.prog || text === OLD.prog) { await setPending(user.id, null); return void (await showProgram(chatId, target)); }
  if (text === OLD.clear) { await setLecturer(chatId, target, ""); return void (await sendCard(chatId, target)); }
  if (text === OLD.skip || cmd === "/skip") { await changeWeek(chatId, target, { skipped: true }); return void (await sendCard(chatId, target)); }
  if (cmd) return void (await say(chatId, "Пользуйтесь кнопками внизу 👇", MENU));

  const pending = await getPending(user.id);
  if (pending && /^(be|ba|bn):/.test(pending)) return void (await onProgramText(chatId, user.id, pending, text));
  if (pending?.startsWith("wd:")) return void (await onWeekdayText(chatId, user.id, pending.slice(3), text));
  const name = cleanName(text);
  if (!name) return;
  const key = pending?.startsWith("lec:") ? pending.slice(4) : target;
  await setPending(user.id, null);
  await setLecturer(chatId, key, name);
  await sendCard(chatId, key);
}

async function onCallback(cq: any) {
  const msg = cq.message;
  const chatId = msg?.chat?.id as number;
  const user = cq.from;
  if (cq.data === "sub" || cq.data === "unsub") {
    const on = cq.data === "sub";
    await setSub(user, chatId, on);
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: on ? "🔔 Буду напоминать за 2 часа до программы" : "🔕 Напоминания выключены" });
    if (msg?.message_id) await showSub(chatId, user.id, msg.message_id);
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId || !(await isAdmin(user.id, user.username))) return;
  await saveAdmin(user.id, chatId, [user.first_name, user.last_name].filter(Boolean).join(" "));
  const d = cq.data as string;
  const [kind, key, ...rest] = d.split(":");
  const arg = rest.join(":");
  const idx = Number(arg);

  if (kind === "cancel") { await setPending(user.id, null); return void (await tg("editMessageText", { chat_id: chatId, message_id: msg.message_id, text: "Отменено." })); }
  if (kind === "wk") { await setPending(user.id, null); return void (await showCard(chatId, key, msg)); }
  if (kind === "jp") {
    const on = arg === "1";
    await changeWeek(chatId, key, { blocks: withJapa(await getWeek(key), on) });
    return void (await showCard(chatId, key, msg, `✅ ${human(dateOf(key))}: ${on ? "с джапой, начало в 13:00" : "без джапы, начало в 14:00"}.`));
  }
  if (kind === "dc") { await toggleWeekday(chatId, key); return void (await showWeekdays(chatId, msg.message_id)); }
  if (kind === "de") {
    await setPending(user.id, `wd:${key}`);
    return void (await say(chatId, `✏️ <b>${festDay(key)}</b>\n\nПришлите новое время и/или примечание, например:\n<code>17:00</code>\n<code>Киртан и Дамодараштака</code>\n<code>16:30 — Киртан и Дамодараштака</code>\n\nЧтобы убрать примечание, пришлите <code>-</code>.`, CANCEL));
  }
  if (kind === "ln") {
    await setPending(user.id, null);
    await setLecturer(chatId, key, arg);
    return void (await showCard(chatId, key, msg, `✅ Записал: ${human(dateOf(key))} лекцию читает <b>${esc(arg)}</b>.`));
  }
  if (kind === "cl") {
    await setPending(user.id, null);
    await setLecturer(chatId, key, "");
    return void (await showCard(chatId, key, msg, `✅ Анонс на ${human(dateOf(key))} выйдет без имени лектора.`));
  }
  if (kind === "set") return void (await askLecturer(chatId, user.id, key));
  if (kind === "sk") {
    const w = await getWeek(key);
    await changeWeek(chatId, key, { skipped: !w?.skipped });
    return void (await showCard(chatId, key, msg, w?.skipped ? "▶️ Анонс снова в расписании." : `⏸ Анонс на ${human(dateOf(key))} не будет опубликован.`));
  }
  if (kind === "tx") { const w = await getWeek(key); return void (await say(chatId, caption(dateOf(key), w))); }
  if (kind === "fu") return void (await showUpcoming(chatId, key, msg.message_id));
  // программа
  const w = await getWeek(key);
  const bl = blocksOf(w);
  if (kind === "pg") { await setPending(user.id, null); return void (await showProgram(chatId, key)); }
  if (kind === "bt" && bl[idx]) { bl[idx].off = !bl[idx].off; await changeWeek(chatId, key, { blocks: bl }); return void (await showProgram(chatId, key, msg.message_id)); }
  if (kind === "bd" && bl[idx]) { bl.splice(idx, 1); await changeWeek(chatId, key, { blocks: bl }); return void (await showProgram(chatId, key, msg.message_id)); }
  if (kind === "br") { await changeWeek(chatId, key, { blocks: null }); return void (await showProgram(chatId, key, msg.message_id)); }
  if (kind === "bnx") { await changeWeek(chatId, key, { note: null }); return void (await showProgram(chatId, key, msg.message_id)); }
  if (kind === "be" && bl[idx]) {
    await setPending(user.id, `be:${key}:${idx}`);
    return void (await say(chatId,
      `✏️ Пункт: <b>${bl[idx].t} — ${esc(bl[idx].text)}</b>\n\nПришлите новый текст. Если меняется время — с временем в начале, например:\n<code>13:30 — Час силы: совместная джапа-медитация.</code>`, CANCEL));
  }
  if (kind === "ba") {
    await setPending(user.id, `ba:${key}`);
    return void (await say(chatId, "➕ Пришлите новый пункт с временем, например:\n<code>18:00 — Просмотр фильма о Шриле Прабхупаде</code>", CANCEL));
  }
  if (kind === "bn") {
    await setPending(user.id, `bn:${key}`);
    return void (await say(chatId, "✨ Пришлите примечание — оно появится в анонсе и на афише. Например:\n<code>Празднуем Гита-джаянти!</code>", CANCEL));
  }
}

// ---------------- точка входа ----------------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  try {
    if (task === "schedule") {
      return Response.json(await schedule(), { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" } });
    }
    if (task && url.searchParams.get("key") !== (await cronKey())) return new Response("forbidden", { status: 403 });
    if (task === "tick") return Response.json(await tick());
    if (task === "weekday") return Response.json(await weekdayPost(url.searchParams.get("day") ?? ymd(dayStart(nowTb())), true));
    if (task === "publish") {
      try { return Response.json(await publish(url.searchParams.get("force") === "1")); } catch (e) {
        await notifyAdmins(`⚠️ Ошибка при публикации анонса: ${esc(String((e as Error)?.message ?? e))}`).catch(() => {});
        throw e;
      }
    }
    if (task === "remind") return Response.json(await remind());
    if (task === "setup") return Response.json(await setup());
    if (task === "festremind") return Response.json(await festRemind(url.searchParams.get("test") === "1"));
    if (req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== (await secretToken())) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await req.json();
      const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      const job = update.callback_query ? onCallback(update.callback_query) : onMessage(update.message);
      await job.catch(async (e) => {
        console.error(e);
        if (chat) await say(chat, "⚠️ Ошибка: " + esc(String(e?.message ?? e)));
      });
      return new Response("ok");
    }
    return new Response("hk-bot ok");
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
});
