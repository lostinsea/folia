/**
 * Custom Language Module
 * - Adds Ukrainian (uk) to the UI_STRINGS table (accessible as a global
 *   since renderer.js is a non-module script sharing the same JS context)
 * - Patches the Language submenu: removes Turkish, adds Ukrainian for both
 *   Interface language section
 *
 * Overlay file — never touched by upstream merges.
 * Load after renderer.js in index.html.
 */

(function initCustomLanguage() {
  "use strict";

  // ── Ukrainian UI strings ───────────────────────────────────────────────────
  // Keys mirror the en/tr objects in renderer.js UI_STRINGS.
  // UI_STRINGS is a top-level const in renderer.js and therefore accessible
  // here (all non-module <script> tags share the same global scope).
  const uk = {
    open: "Відкрити",
    edit: "Редагувати",
    pdf: "PDF",
    word: "Word",
    file: "Файл",
    "title.file": "Файл",
    openFile: "Відкрити файл",
    export: "Експорт",
    exportPdf: "Експорт як PDF",
    exportWord: "Експорт як Word",
    history: "Історія",
    editMode: "Режим редагування",
    allNotes: "Всі нотатки",
    noNotes: "Нотаток не знайдено",
    view: "Вигляд",
    "title.view": "Вигляд",
    tools: "Інструменти",
    darkMode: "Темний режим",
    fullscreen: "На весь екран",
    showNotes: "Показати нотатки",
    save: "Зберегти",
    reload: "Оновити",
    dismiss: "Закрити",
    cancel: "Скасувати",
    find: "Знайти",
    later: "Пізніше",
    exit: "Вихід",
    "title.open": "Відкрити файл (Ctrl+O)",
    "title.recent": "Останні файли",
    "title.toc": "Зміст",
    "title.edit": "Перемкнути режим редагування",
    "title.exitEdit": "Вийти з режиму редагування",
    "title.pdf": "Експорт в PDF",
    "title.word": "Експорт в Word",
    "title.zoomOut": "Зменшити (Ctrl+-)",
    "title.zoomReset": "Скинути масштаб (Ctrl+0)",
    "title.zoomIn": "Збільшити (Ctrl++)",
    "title.darkMode": "Перемкнути темний режим",
    "title.tools": "Інструменти",
    "title.fullscreen": "На весь екран (F11)",
    "title.back": "Назад (Стрілка вліво)",
    "title.forward": "Вперед (Стрілка вправо)",
    "title.refresh": "Оновити документ (Ctrl+R)",
    "title.save": "Зберегти (Ctrl+S)",
    "title.clearRecent": "Очистити всі останні файли",
    "title.searchPrev": "Попередній (Shift+Enter)",
    "title.searchNext": "Наступний (Enter)",
    "title.searchClose": "Закрити (Esc)",
    "title.removeRecent": "Видалити з останніх файлів",
    "title.note": "Заголовок",
    recentFiles: "Останні файли",
    tableOfContents: "Зміст",
    rawMarkdown: "Вихідний Markdown",
    loading: "Завантаження...",
    searchPlaceholder: "Пошук у документі...",
    noRecentFiles: "Немає останніх файлів",
    noHeaders: "Заголовків не знайдено",
    unsaved: "● Незбережено",
    editorPlaceholder: "Почніть вводити markdown...",
    "welcome.title": "Ласкаво просимо до Folia",
    "welcome.subtitle": "Натисніть Ctrl+O, щоб відкрити файл markdown",
    "welcome.features": "Можливості",
    fileUpdated: "Файл оновлено",
    fileModifiedExternally: "Цей файл було змінено зовні",
    updateAvailable: "Доступне оновлення",
    newVersionAvailable: "Доступна нова версія",
    downloadUpdate: "Завантажити оновлення",
    restartInstall: "Перезапустити та встановити",
    "ctx.copy": "Копіювати",
    "ctx.copyPlain": "Копіювати як текст",
    "ctx.bold": "Жирний",
    "ctx.italic": "Курсив",
    "ctx.code": "Блок коду",
    "ctx.list": "Зробити список",
    "ctx.removeFormat": "Прибрати форматування",
    "ctx.editText": "Редагувати текст",
    "ctx.addNote": "Додати нотатку",
    "ctx.editNote": "Редагувати нотатку",
    "ctx.deleteNote": "Видалити нотатку",
    "ctx.findNote": "Знайти нотатку",
    "ctx.insertImage": "Вставити зображення",
    "ctx.deleteImage": "Видалити зображення",
    "ctx.selectAll": "Вибрати все",
    "ctx.openFolder": "Відкрити папку",
    "ctx.copyPath": "Копіювати шлях",
    "ctx.removeRecent": "Видалити з останніх",
    addNote: "Додати нотатку",
    editNote: "Редагувати нотатку",
    label: "Мітка",
    labelPlaceholder: "Назва мітки...",
    color: "Колір",
    note: "Нотатка",
    noteTitlePlaceholder: "Заголовок нотатки...",
    notePlaceholder: "Напишіть нотатку...",
    findNote: "Знайти нотатку",
    idOrTitle: "ID або заголовок",
    findNotePlaceholder: "#1 або заголовок нотатки...",
    searchNotes: "Пошук нотаток",
    notesSearchPlaceholder: "#ID або заголовок...",
    editText: "Редагувати текст",
    editTextLabel: "Редагувати вибраний текст:",
    "notif.textEdited": "Текст оновлено",
    zoom: "Масштаб",
    language: "Мова",
    "notif.sectionNotFound": "Розділ не знайдено: ",
    "notif.fileNotFound": "Файл не знайдено: ",
    "notif.preparingWord": "Підготовка Word-файлу...",
    "notif.pdfExported": "PDF збережено: ",
    "notif.wordExported": "Word збережено: ",
    "notif.copyFailed": "Не вдалося скопіювати в буфер обміну",
    "notif.fileDeleted": "Увага: Відкритий файл видалено з диска",
    "notif.fileReloaded": "Файл успішно оновлено",
    "notif.reloadFailed": "Не вдалося оновити файл: ",
    "notif.noTextSelected": "Текст не вибрано",
    "notif.copied": "Скопійовано в буфер обміну",
    "notif.copyError": "Помилка копіювання: ",
    "notif.copiedPlain": "Скопійовано як звичайний текст",
    "notif.textNotFound": "Не знайдено в вихідному тексті",
    "notif.boldApplied": "Застосовано жирний шрифт",
    "notif.italicApplied": "Застосовано курсив",
    "notif.codeApplied": "Застосовано форматування коду",
    "notif.listApplied": "Застосовано форматування списку",
    "notif.formatRemoved": "Форматування прибрано",
    "notif.noteRemoved": "Нотатку видалено",
    "notif.noteNotFound": "Нотатку не знайдено в джерелі",
    "notif.enterLabel": "Будь ласка, введіть назву мітки",
    "notif.enterTitleOrContent":
      "Будь ласка, введіть заголовок або вміст нотатки",
    "notif.noteUpdated": "Нотатку оновлено",
    "notif.noteAdded": "Нотатку додано",
    "notif.imageNotFound": "Зображення не знайдено в джерелі",
    "notif.noteAddedToImage": "Нотатку додано до зображення",
    "notif.enterNoteId": "Будь ласка, введіть ID або заголовок нотатки",
    "notif.noteSearchNotFound": 'Нотатку "${val}" не знайдено',
    "notif.openFileFirst": "Будь ласка, спочатку відкрийте файл",
    "notif.imageInserted": "Зображення вставлено",
    "notif.imageInsertedCompressed": "Зображення вставлено (${from} → ${to})",
    "notif.imageFailed": "Не вдалося завантажити зображення: ",
    "notif.imageProcessFailed": "Не вдалося обробити зображення",
    "notif.imageDeleted": "Зображення видалено",
    "notif.pathCopied": "Шлях скопійовано в буфер обміну",
    "notif.pathCopiedCheck": "✓ Шлях скопійовано в буфер обміну",
    "confirm.unsavedOpen":
      "Є незбережені зміни. Відкинути зміни та відкрити новий файл?",
    "confirm.unsavedRefresh":
      "Є незбережені зміни. Відкинути зміни та оновити з диска?",
    "confirm.unsavedExit": "Є незбережені зміни. Вихід з режиму редагування ВІДХИЛИТЬ їх. Все одно вийти?",
    "confirm.unsavedOpenFile":
      'Є незбережені зміни. Відкинути зміни та відкрити "${name}"?',
    "confirm.clearRecent": "Очистити всі останні файли?",
    "alert.openFirst":
      "Будь ласка, відкрийте файл markdown перед експортом у PDF.",
    "alert.openFirstWord":
      "Будь ласка, відкрийте файл markdown перед експортом у Word.",
    "alert.noFileOpen": "Наразі немає відкритих файлів.",
    "alert.pdfFailed": "Помилка експорту PDF: ",
    "alert.wordFailed": "Помилка експорту Word: ",
    "alert.saveFailed": "Помилка збереження файлу: ",
    "alert.wordError": "Помилка Word: ",
    "update.downloading": "Завантаження оновлення",
    "update.ready": "Оновлення готове",
    "update.error": "Помилка оновлення",
    "update.versionReady": "Версія ${version} готова до завантаження",
    "update.versionInstall": "Версія ${version} готова до встановлення",
    "update.failed": "Не вдалося перевірити оновлення",
    "update.download": "Завантажити",
    "update.openDownloadPage": "Відкрити сторінку завантаження",
    "search.counter": "${current} / ${total}",
    "search.zero": "0 / 0",
    "mermaid.error": "Не вдалося конвертувати діаграму в зображення.",
  };

  // ── Patch UI_STRINGS (global from renderer.js) ────────────────────────────

  function patchUIStrings() {
    if (typeof UI_STRINGS === "undefined") return false;
    UI_STRINGS.uk = uk;
    // Remove Turkish so it's no longer a selectable interface language
    delete UI_STRINGS.tr;
    return true;
  }

  // ── Patch Language submenu DOM ────────────────────────────────────────────
  // Remove Turkish items, add Ukrainian to the Interface section.

  function makeLangItem(lang, label, section, isActive) {
    const el = document.createElement("div");
    el.className = "tools-submenu-item" + (isActive ? " active" : "");
    el.dataset.lang = lang;
    el.dataset.section = section;
    el.innerHTML = `<span>${label}</span><span class="lang-check">✓</span>`;

    // renderer.js registers click handlers only on items present at startup,
    // so we must attach ours manually using the same top-level functions.
    el.addEventListener("click", () => {
      // Close the tools menu (mirrors renderer.js behaviour)
      const toolsMenu = document.getElementById("toolsMenu");
      if (toolsMenu) toolsMenu.classList.remove("visible");

      // applyInterfaceLang is a top-level function in renderer.js
      if (section === "ui" && typeof applyInterfaceLang === "function") {
        applyInterfaceLang(lang);
      }
    });

    return el;
  }

  function patchLangMenu() {
    const submenu = document.getElementById("langSubmenu");
    if (!submenu) return;

    // Remove Turkish items (data-lang="tr")
    submenu.querySelectorAll('[data-lang="tr"]').forEach((el) => el.remove());

    // Add Ukrainian to Interface section (after English ui item)
    const enUiItem = submenu.querySelector(
      '[data-lang="en"][data-section="ui"]',
    );
    if (enUiItem) {
      const ukUi = makeLangItem("uk", "Українська / Ukrainian", "ui", false);
      enUiItem.after(ukUi);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    const patched = patchUIStrings();
    patchLangMenu();
    if (patched) {
      console.log("[CustomLanguage] Ukrainian added, Turkish removed");
    } else {
      console.warn(
        "[CustomLanguage] UI_STRINGS not found — load after renderer.js",
      );
    }
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(init, 50);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
