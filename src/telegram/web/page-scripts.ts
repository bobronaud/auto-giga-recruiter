/**
 * Скрипты, выполняемые внутри страницы Telegram Web.
 * Хранятся строками, чтобы сборщик (esbuild/tsx) не подмешал в них свои хелперы
 * вроде __name, которых нет в браузере.
 */

/** (sel) => Snapshot: сообщения открытого чата, клавиатура, «печатает…», состояние поля ввода. */
export const SNAPSHOT_JS = String.raw`(sel) => {
  function visible(el) { return !!el && el.offsetParent !== null; }
  function rowsOf(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(sel.markupRow)).map(function (r) {
      return Array.from(r.querySelectorAll(sel.markupButton)).map(function (b) {
        return { text: (b.innerText || "").trim(), url: b.tagName === "A" ? b.href : undefined };
      });
    });
  }
  var root = document.querySelector(sel.bubblesInner);
  var bubbles = [];
  if (root) {
    Array.from(root.querySelectorAll(sel.bubble)).forEach(function (el) {
      var mid = Number(el.dataset.mid);
      // mid <= 0 — карточка описания бота («What can this bot do?»), а не сообщение
      if (!isFinite(mid) || mid <= 0 || el.classList.contains("service")) return;
      var text = "";
      var msg = el.querySelector(sel.messageText);
      if (msg) {
        var clone = msg.cloneNode(true);
        clone.querySelectorAll(sel.messageNoise).forEach(function (n) { n.remove(); });
        text = (clone.innerText || clone.textContent || "").trim();
      }
      var media;
      if (el.querySelector("audio-element, .audio")) media = el.classList.contains("voice") ? "voice" : "audio";
      else if (el.classList.contains("photo") || el.querySelector(".media-photo")) media = "photo";
      else if (el.classList.contains("video") || el.querySelector(".media-video")) media = "video";
      else if (el.querySelector(".document, document-element")) media = "document";
      bubbles.push({
        mid: mid,
        out: el.classList.contains(sel.outgoingClass),
        text: text,
        rows: rowsOf(el.querySelector(sel.inlineMarkup)),
        edited: !!el.querySelector(sel.edited),
        media: media,
        ts: Number(el.dataset.timestamp) || 0
      });
    });
  }
  var startRe = new RegExp(sel.startButtonText, "i");
  var startBtn = Array.from(document.querySelectorAll(sel.startButton)).find(function (b) {
    return visible(b) && startRe.test((b.innerText || "").trim());
  });
  var kb = document.querySelector(sel.replyKeyboard);
  var titleEl = document.querySelector(".chat-info .peer-title, .top .peer-title");
  return {
    ok: !!root,
    bubbles: bubbles,
    keyboard: kb && !kb.classList.contains("hide") ? rowsOf(kb) : [],
    typing: !!document.querySelector(sel.typing),
    startVisible: !!startBtn,
    inputVisible: visible(document.querySelector(sel.input)),
    title: titleEl ? (titleEl.innerText || "").trim() : ""
  };
}`;

/** (sel) => string: HTML последних сообщений и области ввода для отладки селекторов. */
export const DEBUG_DUMP_JS = String.raw`(sel) => {
  var parts = [];
  Array.from(document.querySelectorAll(sel.bubble)).slice(-8).forEach(function (b) { parts.push(b.outerHTML); });
  var input = document.querySelector(".chat-input");
  if (input) parts.push(input.outerHTML);
  return parts.join("\n\n<!-- ---- -->\n\n");
}`;

/** Вызвать функцию-строку в странице с аргументом. */
export function call(fnSource: string, arg: unknown): string {
  return "(" + fnSource + ")(" + JSON.stringify(arg) + ")";
}
