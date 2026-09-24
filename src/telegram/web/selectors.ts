/**
 * CSS-селекторы Telegram Web (версия K: web.telegram.org/k/).
 * Получены из бандла клиента; если Telegram поменяет вёрстку, их можно
 * переопределить в config.yaml → telegram.web.selectors без правки кода.
 */
export const defaultSelectors = {
  // --- вход ---
  qrCanvas: 'canvas[class*="qrCanvas"]',
  passwordInput: 'input[type="password"]',
  loggedIn: "#column-left, .chatlist-container",

  // --- чат ---
  /** Лента активного чата. Рядом есть пустой служебный .bubbles-remover.bubbles-inner — его исключаем */
  bubblesInner: ".chat.active .bubbles-scrollable .bubbles-inner",
  bubble: ".bubble[data-mid]",
  incomingClass: "is-in",
  outgoingClass: "is-out",
  messageText: ".message",
  /** Элементы внутри .message, которые не относятся к тексту */
  messageNoise: ".time, .reactions, .reply-markup, .bubble-beside-button, .clearfix, .time-inner",
  edited: ".time-edited",
  inlineMarkup: ".reply-markup",
  markupRow: ".reply-markup-row",
  markupButton: ".reply-markup-button",
  replyKeyboard: ".reply-keyboard",
  typing: ".chat-info .peer-typing, .top .peer-typing",
  /** У поля ввода есть невидимый двойник .input-field-input-fake (для расчёта высоты) */
  input: '.input-message-input[contenteditable="true"]:not(.input-field-input-fake)',
  sendButton: ".btn-send",
  /** Кнопки-«плашки» под чатом; кнопкой Start считается та, чей текст совпадает с startButtonText */
  startButton: ".chat-input-control .chat-input-control-button",
  startButtonText: "^(start|старт|запустить|начать)$",
  // --- всплывающие ответы бота на нажатие кнопки ---
  toast: ".toast",
  popupText: ".popup .popup-description",
  popupOk: ".popup .popup-buttons button",
} as const;

export type Selectors = { -readonly [K in keyof typeof defaultSelectors]: string };
