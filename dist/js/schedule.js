// Расписание: время в Батуми, развёртка регулярных программ, вычисление статусов.

const TZ = 'Asia/Tbilisi';
const DEFAULT_DURATION = 120; // минут, если у события не указан конец

/** Текущие дата и минуты по времени Батуми, независимо от часового пояса устройства. */
export function nowInBatumi(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export const toMinutes = hhmm => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

/** Календарная арифметика на строках YYYY-MM-DD через UTC, чтобы не зависеть от пояса устройства. */
const parseDay = iso => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => {
  const d = parseDay(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const weekday = iso => parseDay(iso).getUTCDay();
export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 864e5);

const fmt = opts => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...opts });
const fmtDayMonth = fmt({ day: 'numeric', month: 'long' });
const fmtWeekday = fmt({ weekday: 'long' });
const fmtWeekdayShort = fmt({ weekday: 'short' });
const fmtMonthShort = fmt({ month: 'short' });

export const formatDayMonth = iso => fmtDayMonth.format(parseDay(iso));
export const formatWeekday = iso => fmtWeekday.format(parseDay(iso));
export const formatWeekdayShort = iso => fmtWeekdayShort.format(parseDay(iso)).replace('.', '');
export const formatMonthShort = iso => fmtMonthShort.format(parseDay(iso)).replace('.', '');
export const dayNumber = iso => parseDay(iso).getUTCDate();

/** «Сегодня», «Завтра», «Вчера» или «понедельник, 16 ноября». */
export function relativeDay(iso, today) {
  const diff = daysBetween(today, iso);
  const label = { 0: 'Сегодня', 1: 'Завтра', [-1]: 'Вчера' }[diff];
  const full = `${formatWeekday(iso)}, ${formatDayMonth(iso)}`;
  return label ? `${label}, ${formatDayMonth(iso)}` : full.charAt(0).toUpperCase() + full.slice(1);
}

// Для прихожанина различаем только то, что важно: объявлено ли событие в канале.
// regular и tentative выглядят одинаково, но tentative даёт более осторожное пояснение.
export const STATUS = {
  confirmed: { label: 'Анонсировано', chip: 'confirmed', hint: 'Храм объявил эту программу в канале.' },
  regular: { label: 'Обычно в это время', chip: 'regular', hint: 'Регулярная программа. Анонс с точным временем обычно выходит в канале утром в день проведения.' },
  tentative: { label: 'Обычно в это время', chip: 'regular', hint: 'Регулярная программа, но время бывает другим. Проверьте анонс в канале в день проведения.' },
  moved: { label: 'Перенесено', chip: 'moved', hint: 'Программа перенесена на другой день.' },
  cancelled: { label: 'Отменено', chip: 'cancelled', hint: 'Программа не состоится.' },
  completed: { label: 'Прошло', chip: 'completed', hint: 'Программа уже прошла.' },
};

/** Ссылка «Добавить в Google Календарь». Время передаётся как местное с поясом Батуми. */
export function calendarUrl(e, location) {
  const stamp = (date, hhmm) => `${date.replaceAll('-', '')}T${hhmm.replace(':', '')}00`;
  const endMin = toMinutes(e.end) ?? toMinutes(e.start) + DEFAULT_DURATION;
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  const p = new URLSearchParams({
    action: 'TEMPLATE', text: e.title, dates: `${stamp(e.date, e.start)}/${stamp(e.date, end)}`,
    ctz: 'Asia/Tbilisi', location, details: 'Храм Харе Кришна, Батуми. Перед выходом проверьте анонс в канале: t.me/harekrishnabatumi',
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

/**
 * Собирает список событий на период: дата-события из content.events +
 * регулярные программы, развёрнутые по дням. Событие с полем series и той же датой
 * заменяет регулярное (например, перенос или праздник вместо обычного вторника).
 */
export function buildEvents(content, { from, to }) {
  const dated = content.events.map(e => ({ ...e, sources: e.sources || [] }));
  const overridden = new Set(dated.filter(e => e.series).map(e => `${e.series}|${e.date}`));
  const generated = [];

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const wd = weekday(day);
    for (const r of content.regular) {
      if (!(r.weekdays || [r.weekday]).includes(wd) || overridden.has(`${r.id}|${day}`)) continue;
      generated.push({ ...r, id: `${r.id}-${day}`, series: r.id, date: day, sources: [], generated: true });
    }
  }

  return [...dated.filter(e => e.date >= from && e.date <= to), ...generated]
    .sort((a, b) => a.date.localeCompare(b.date) || toMinutes(a.start) - toMinutes(b.start));
}

/** Итоговый статус с учётом текущего времени: прошедшие программы становятся «Завершено». */
export function effectiveStatus(event, now) {
  if (event.status === 'cancelled' || event.status === 'moved') return event.status;
  const end = toMinutes(event.end) ?? (toMinutes(event.start) ?? 0) + DEFAULT_DURATION;
  const isPast = event.date < now.date || (event.date === now.date && now.minutes >= end);
  if (isPast) return event.generated ? null : 'completed'; // прошедшие регулярные без анонса не показываем
  return event.status;
}

/** Идёт ли программа прямо сейчас. */
export function isLive(event, now) {
  // «Идёт сейчас» показываем только для подтверждённых анонсом программ
  if (event.date !== now.date || event.status !== 'confirmed') return false;
  const start = toMinutes(event.start);
  const end = toMinutes(event.end) ?? start + DEFAULT_DURATION;
  return now.minutes >= start && now.minutes < end;
}

export const timeRange = e => (e.end ? `${e.start}–${e.end}` : `с ${e.start}`);
