// Тонкая обёртка над Telegram Web App SDK. Вне Telegram всё деградирует до обычного браузера.

const tg = window.Telegram?.WebApp;
export const inTelegram = Boolean(tg?.initData);
const supports = version => inTelegram && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(version);

export function initTelegram({ onBack }) {
  if (!inTelegram) return;
  document.documentElement.classList.add('is-telegram');
  tg.ready();
  tg.expand();
  if (supports('7.7')) tg.disableVerticalSwipes(); // чтобы прокрутка вверх не сворачивала приложение
  applyTheme();
  tg.onEvent('themeChanged', applyTheme);
  if (supports('6.1')) tg.BackButton.onClick(onBack);
}

/** Тема Telegram (светлая/тёмная) → наши токены; цвет шапки Telegram совпадает с фоном приложения. */
function applyTheme() {
  document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg').trim();
  try {
    // Цвет шапки в hex поддерживается с 6.9; в более старых клиентах SDK бросает исключение
    if (supports('6.9')) tg.setHeaderColor(bg);
    if (supports('6.1')) tg.setBackgroundColor(bg);
    if (supports('7.10')) tg.setBottomBarColor(css.getPropertyValue('--surface').trim());
  } catch { /* оформление не критично для работы */ }
}

export function setBackButton(visible) {
  if (!supports('6.1')) return;
  visible ? tg.BackButton.show() : tg.BackButton.hide();
}

/** Параметр startapp из ссылки t.me/<bot>?startapp=donate — открывает нужный раздел. */
export const startParam = () => tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('tgWebAppStartParam') || '';

/** Ссылки t.me открываются внутри Telegram без закрытия приложения, остальные — во встроенном браузере. */
export function openLink(url) {
  if (inTelegram && /^https:\/\/t\.me\//.test(url) && supports('6.1')) tg.openTelegramLink(url);
  else if (inTelegram) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function haptic(kind) {
  if (!supports('6.1')) return;
  if (kind === 'select') tg.HapticFeedback.selectionChanged();
  else tg.HapticFeedback.notificationOccurred(kind);
}
