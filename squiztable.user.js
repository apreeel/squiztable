// ==UserScript==
// @name         Squiz Results To PNG
// @namespace    https://github.com/apreeel/squiztable
// @version      0.3.1
// @description  Один клик — PNG 1920×1080 с турнирной таблицей squiz, готовый к вставке на слайд
// @author       apreeel
// @match        https://my.squiz.ru/results/*
// @require      https://cdn.jsdelivr.net/npm/modern-screenshot@4.7.0/dist/index.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

/* global modernScreenshot */
(function () {
  "use strict";

  // ── CONFIG. Те же ручки, что в shot.js. Меняй прямо здесь.
  const CONFIG = {
    viewport: { width: 1920, height: 1080 },
    padding: 50,
    // выставится через End на font-thumb
    sliderFont: 140,
    // ArrowLeft пока панель ≤ viewport.width − 2·padding; число — конкретное value; null — не трогать
    sliderWidth: "auto",
    // CSS поверх слайдера; null — не трогать
    fontSizeOverride: "1.4rem",
    // принудительная видимая рамка; null — не трогать
    panelBorder: "2px solid rgba(255,255,255,0.22)",
    // фон композита; null — взять цвет body со страницы
    background: null,
    buttonLabel: "Скачать PNG",
  };

  // ── Утилиты
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function todayMMDD() {
    const d = new Date();
    return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }

  function sanitizeFilename(s) {
    return (s || "")
      .replace(/[\/\\:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  // Берём текст .text-lg.text-foreground без потомков с .text-muted-foreground —
  // т.е. только основное название турнира, без даты/места/подзаголовка.
  function getTitle() {
    const el = document.querySelector(".text-lg.text-foreground");
    if (!el) return "";
    const cloned = el.cloneNode(true);
    cloned.querySelectorAll(".text-muted-foreground").forEach((n) => n.remove());
    return cloned.textContent;
  }

  function buildFilename() {
    let base = sanitizeFilename(getTitle());
    if (!base) {
      const m = location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      base = m ? m[0] : "screenshot";
    }
    const fullBase = `${todayMMDD()}_${base}`;
    const key = `counter:${fullBase}`;
    const next = (parseInt(GM_getValue(key, 0), 10) || 0) + 1;
    GM_setValue(key, next);
    return `${fullBase}_${next}.png`;
  }

  function pageBg() {
    if (CONFIG.background) return CONFIG.background;
    const candidates = [
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(document.documentElement).backgroundColor,
    ];
    for (const c of candidates) {
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
    }
    return "#0c1116";
  }

  function injectStyle(id, css) {
    let s = document.getElementById(id);
    if (!s) {
      s = document.createElement("style");
      s.id = id;
      document.head.appendChild(s);
    }
    s.textContent = css;
  }

  // shot.js всегда снимает в Chromium с viewport 1920×1080 — поэтому CLI
  // стабилен. В userscript'е окно/DPR — какие есть у пользователя; в узком окне
  // layout таблицы получается уже, чем рассчитан 1.4rem fontSizeOverride → имена
  // команд переносятся на две строки.
  //
  // Расширяем layout до 1920px через width + transform:
  //   • html.width = 1920px — страница раскладывается так, будто окно широкое
  //     (панель/таблица получают место);
  //   • transform: scale(real/1920) — чисто визуально вписывает раскладку в окно.
  //
  // Почему НЕ zoom: под zoom modern-screenshot читает рассогласованные
  // computed-стили (ширина «как нарисовано», font-size в layout-px — поведение
  // зависит от версии Chrome) и клон в foreignObject переносит текст. transform
  // — операция отрисовки, layout-значения getComputedStyle не трогает, поэтому
  // реконструкция стабильна во всех версиях Chrome.
  function applyVirtualViewport() {
    const real = window.innerWidth;
    if (real >= CONFIG.viewport.width) return null;
    const html = document.documentElement;
    const prev = {
      width: html.style.width,
      transform: html.style.transform,
      transformOrigin: html.style.transformOrigin,
      overflow: html.style.overflow,
    };
    const z = real / CONFIG.viewport.width;
    html.style.width = CONFIG.viewport.width + "px";
    html.style.transformOrigin = "0 0";
    html.style.transform = `scale(${z})`;
    html.style.overflow = "hidden";
    console.log(`[squiztable] virtual viewport: innerWidth=${real}, layout=${CONFIG.viewport.width}px, scale=${z.toFixed(3)}`);
    return prev;
  }

  function restoreVirtualViewport(prev) {
    if (!prev) return;
    const html = document.documentElement;
    html.style.width = prev.width;
    html.style.transform = prev.transform;
    html.style.transformOrigin = prev.transformOrigin;
    html.style.overflow = prev.overflow;
  }

  // ── Слайдеры (Radix UI: [role="slider"] с aria-valuenow)

  function listSliders() {
    function getText(el) {
      if (!el) return "";
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 40) return t;
      return (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    }
    function labelFor(rootEl) {
      let n = rootEl.previousElementSibling;
      while (n) {
        const t = getText(n);
        if (t) return t;
        n = n.previousElementSibling;
      }
      for (let p = rootEl.parentElement; p && p !== document.body; p = p.parentElement) {
        let s = p.previousElementSibling;
        while (s) {
          const t = getText(s);
          if (t) return t;
          s = s.previousElementSibling;
        }
      }
      return "";
    }
    function sliderRoot(thumb) {
      // У самого thumb обычно тоже есть data-orientation; ищем контейнер ВЫШЕ.
      let n = thumb.parentElement;
      while (n && n !== document.body) {
        if (n.matches("[data-orientation]")) return n;
        n = n.parentElement;
      }
      return thumb;
    }
    return Array.from(document.querySelectorAll('[role="slider"]')).map((thumb, i) => ({
      idx: i,
      thumb,
      label: labelFor(sliderRoot(thumb)),
      min: parseFloat(thumb.getAttribute("aria-valuemin")) || 0,
      max: parseFloat(thumb.getAttribute("aria-valuemax")) || 100,
      value: parseFloat(thumb.getAttribute("aria-valuenow")) || 0,
    }));
  }

  function radixValue(thumb) {
    return parseFloat(thumb.getAttribute("aria-valuenow")) || 0;
  }

  function pressKey(target, key) {
    const opts = { key, code: key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function setRadixSlider(thumb, target) {
    const min = parseFloat(thumb.getAttribute("aria-valuemin")) || 0;
    const max = parseFloat(thumb.getAttribute("aria-valuemax")) || 100;
    thumb.focus();
    if (target >= max) { pressKey(thumb, "End"); await sleep(150); return; }
    if (target <= min) { pressKey(thumb, "Home"); await sleep(150); return; }
    let cur = radixValue(thumb);
    for (let i = 0; i < 400; i++) {
      if (cur === target) break;
      const before = cur;
      pressKey(thumb, cur < target ? "ArrowRight" : "ArrowLeft");
      for (let p = 0; p < 10; p++) {
        await sleep(15);
        cur = radixValue(thumb);
        if (cur !== before) break;
      }
      if (cur === before) break; // упёрлись в границу
    }
  }

  // Находит колонку «Команда» в таблице внутри панели и возвращает объект с
  // методом wrapsNow(): true, если хоть одно имя команды разъехалось на две
  // строки. Считаем через Range.getClientRects() — по одному прямоугольнику
  // на каждую визуальную строку текста. >1 rect ⇒ перенос.
  //
  // Почему НЕ сравнение offsetHeight ячеек: внутри одной <tr> все <td>
  // принудительно тянутся до высоты строки. Когда имя перенеслось на 2
  // строки, соседняя числовая ячейка тоже становится высотой 2 строки,
  // и сравнение всегда False. Range мерит сам текст, а не бокс ячейки.
  //
  // Возвращает null, если заголовок «Команда»/«Team» не найден — тогда
  // вызывающий код откатывается на старое поведение (стоп на первом ≤ 1820).
  function setupTeamWrapCheck(panel) {
    if (!panel) return null;
    const table = panel.tagName === "TABLE" ? panel : panel.querySelector("table");
    if (!table) return null;
    const headerRow = (table.tHead && table.tHead.rows[0]) || table.rows[0];
    if (!headerRow) return null;
    let colIdx = -1;
    for (let i = 0; i < headerRow.cells.length; i++) {
      const t = (headerRow.cells[i].textContent || "").trim().toLowerCase();
      if (/команда|team/.test(t)) { colIdx = i; break; }
    }
    if (colIdx < 0) return null;
    const bodyRows = [];
    const bodies = table.tBodies && table.tBodies.length ? Array.from(table.tBodies) : [table];
    for (const b of bodies) {
      for (const r of b.rows) {
        if (r === headerRow) continue;
        if (r.cells.length > colIdx) bodyRows.push(r);
      }
    }
    if (!bodyRows.length) return null;
    return {
      colIdx,
      wrapsNow() {
        for (const row of bodyRows) {
          const cell = row.cells[colIdx];
          if (!cell || !cell.firstChild) continue;
          const range = document.createRange();
          range.selectNodeContents(cell);
          if (range.getClientRects().length > 1) return true;
        }
        return false;
      },
    };
  }

  async function fitWidthSlider(thumb, targetWidth, wrapCheck) {
    thumb.focus();
    // Сначала на максимум — иначе если страница инициализировала слайдер на
    // маленьком значении, мы вернёмся сразу с узкой панелью и таблица будет
    // сжата.
    pressKey(thumb, "End");
    await sleep(150);
    const panelEl = () => document.querySelector("[data-shot-target]");
    // offsetWidth — настоящая layout-ширина, не зависит от transform
    // виртуального viewport (getBoundingClientRect под scale вернул бы
    // уменьшенную и сравнение с target пошло бы в «нарисованных» px).
    const measure = () => { const p = panelEl(); return p ? p.offsetWidth : 0; };
    let lastW = measure();
    for (let i = 0; i < 200; i++) {
      const w = measure();
      lastW = w;
      if (w === 0) return { width: 0, reason: "no-panel" };
      if (w > targetWidth) {
        // Ещё шире кадра — обязаны сужать, wrap не проверяем.
        const before = radixValue(thumb);
        pressKey(thumb, "ArrowLeft");
        await sleep(30);
        if (radixValue(thumb) === before) return { width: w, reason: "slider-min-overflow" };
        continue;
      }
      // Влезли в кадр. Если wrap-чек недоступен — поведение как раньше:
      // стоп на первом тике, где panel ≤ targetWidth (макс. ширина в кадре).
      if (!wrapCheck) return { width: w, reason: "frame-no-wrapcheck" };
      if (wrapCheck.wrapsNow()) {
        // Имена уже переносятся — откатываемся на тик назад.
        pressKey(thumb, "ArrowRight");
        await sleep(30);
        return { width: measure(), reason: "wrap" };
      }
      // Влезли и не wraps — пробуем уже.
      const before = radixValue(thumb);
      pressKey(thumb, "ArrowLeft");
      await sleep(30);
      if (radixValue(thumb) === before) return { width: w, reason: "slider-min" };
    }
    return { width: lastW, reason: "iter-cap" };
  }

  // ── Поиск панели

  function findPanel() {
    function area(el) {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    }
    function pickLargest(nodes) {
      let best = null, bestArea = 0;
      for (const n of nodes) {
        const a = area(n);
        if (a > bestArea) { best = n; bestArea = a; }
      }
      return best;
    }
    let el = pickLargest(document.querySelectorAll("table"));
    if (!el) el = pickLargest(document.querySelectorAll('[role="table"], [class*="table" i], [class*="Table"]'));
    if (!el) return null;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let panel = el;
    for (let n = el.parentElement, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
      const r = n.getBoundingClientRect();
      if (r.width >= vw && r.height >= vh * 0.9) break;
      const cs = getComputedStyle(n);
      const radius = Math.max(parseFloat(cs.borderTopLeftRadius) || 0, parseFloat(cs.borderTopRightRadius) || 0);
      const bg = cs.backgroundColor;
      const hasBg = bg && bg !== "transparent" && !/^rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
      const hasShadow = cs.boxShadow && cs.boxShadow !== "none";
      const hasBorder = parseFloat(cs.borderTopWidth) > 0;
      if (radius >= 4 || hasBorder || hasShadow || hasBg) {
        panel = n;
        break;
      }
    }
    panel.setAttribute("data-shot-target", "1");
    return panel;
  }

  // ── Поток съёмки

  async function capture(button) {
    const setLabel = (txt, dis) => {
      button.textContent = txt;
      button.disabled = !!dis;
    };
    setLabel("Снимаю…", true);

    let savedViewport = null;
    try {
      savedViewport = applyVirtualViewport();
      await raf();

      // Материализуем виртуализированные строки.
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(300);
      window.scrollTo(0, 0);
      await raf();

      // Слайдеры: font / width.
      const sliders = listSliders();
      console.log("[squiztable] sliders:", sliders.map((s) => `[${s.idx}] "${s.label}" ${s.min}..${s.max}=${s.value}`));
      let fontSlider = sliders.find((s) => /(шрифт|font|размер|^t($|\s))/i.test(s.label));
      let widthSlider = sliders.find((s) => /(ширин|width)/i.test(s.label));
      // Фолбэк: 2 Radix-слайдера в DOM-порядке = [font, width].
      if (sliders.length === 2) {
        if (!fontSlider && !widthSlider) {
          fontSlider = sliders[0]; widthSlider = sliders[1];
          console.log("[squiztable] DOM-order fallback: 0=font, 1=width");
        } else if (!fontSlider) {
          fontSlider = sliders.find((s) => s !== widthSlider);
        } else if (!widthSlider) {
          widthSlider = sliders.find((s) => s !== fontSlider);
        }
      }

      if (CONFIG.sliderFont != null && fontSlider) {
        console.log(`[squiztable] font slider [${fontSlider.label}] → ${CONFIG.sliderFont}`);
        await setRadixSlider(fontSlider.thumb, CONFIG.sliderFont);
      }
      await sleep(300);
      await raf();

      // Панель.
      const panel = findPanel();
      if (!panel) throw new Error("panel not found");
      const r0 = panel.getBoundingClientRect();
      console.log(`[squiztable] panel <${panel.tagName}> ${Math.round(r0.width)}×${Math.round(r0.height)}`);

      // Шрифт через CSS (за пределы максимума слайдера).
      if (CONFIG.fontSizeOverride) {
        injectStyle("shot-font-override", `[data-shot-target], [data-shot-target] * { font-size: ${CONFIG.fontSizeOverride} !important; }`);
        await raf();
      }
      // Видимая рамка.
      if (CONFIG.panelBorder) {
        injectStyle("shot-panel-border", `[data-shot-target] { border: ${CONFIG.panelBorder} !important; box-sizing: border-box !important; }`);
        await raf();
      }
      // Заливка под самой панелью + клиппинг к скруглениям (иначе фон шапки торчит за углами).
      injectStyle("shot-panel-bg", `[data-shot-target] { background-color: ${pageBg()} !important; overflow: hidden !important; }`);
      await raf();

      // Auto-fit ширины.
      if (CONFIG.sliderWidth != null && widthSlider) {
        if (CONFIG.sliderWidth === "auto") {
          const target = CONFIG.viewport.width - 2 * CONFIG.padding;
          const wrapCheck = setupTeamWrapCheck(panel);
          if (!wrapCheck) {
            console.warn("[squiztable] team-name column not found — falling back to frame-fit only");
          } else {
            console.log(`[squiztable] team column idx=${wrapCheck.colIdx}, auto-fit width ≤ ${target}px (stop on wrap)`);
          }
          const res = await fitWidthSlider(widthSlider.thumb, target, wrapCheck);
          console.log(`[squiztable] panel.width = ${Math.round(res.width)} px (stop: ${res.reason})`);
        } else {
          await setRadixSlider(widthSlider.thumb, CONFIG.sliderWidth);
        }
        await raf();
      }
      await sleep(150);

      // Скрываем кнопку, чтобы не попала в кадр (она вне панели, но на всякий).
      button.style.visibility = "hidden";

      // modern-screenshot рендерит через SVG <foreignObject> — браузер сам
      // делает layout, так что вертикальное выравнивание текста в таблице,
      // тени, скругления и т.п. — пиксель-в-пиксель.
      //
      // Под transform виртуального viewport getBoundingClientRect отдаёт
      // визуально уменьшенные (отмасштабированные) размеры — если отдать их
      // авто-детекту библиотеки, SVG будет меньше клона и кадр обрежется.
      // offsetWidth/offsetHeight — настоящий layout border-box в CSS-px,
      // не зависящий от transform, поэтому передаём их явно.
      const panelCanvas = await modernScreenshot.domToCanvas(panel, {
        scale: 2,
        backgroundColor: null,
        width: panel.offsetWidth,
        height: panel.offsetHeight,
      });

      // Композит на 1920×1080 с фоном страницы и ≥ padding по краям.
      const out = document.createElement("canvas");
      out.width = CONFIG.viewport.width;
      out.height = CONFIG.viewport.height;
      const ctx = out.getContext("2d");

      const maxW = CONFIG.viewport.width - 2 * CONFIG.padding;
      const maxH = CONFIG.viewport.height - 2 * CONFIG.padding;
      // Без кэпа ≤ 1: панель, найденная по «no-wrap минимуму», обычно уже
      // 1820×980 — апскейлим её до кадра. modern-screenshot рендерил при
      // scale:2, так что апскейл в ~1.3-1.5× ещё остаётся резким.
      const scale = Math.min(maxW / panelCanvas.width, maxH / panelCanvas.height);
      const drawW = panelCanvas.width * scale;
      const drawH = panelCanvas.height * scale;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(panelCanvas, (out.width - drawW) / 2, (out.height - drawH) / 2, drawW, drawH);

      // Скачивание.
      const filename = buildFilename();
      const blob = await new Promise((r) => out.toBlob(r, "image/png"));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);

      console.log(`[squiztable] saved ${filename}`);
      setLabel("✓ скачано", true);
      setTimeout(() => setLabel(CONFIG.buttonLabel, false), 2000);
    } catch (err) {
      console.error("[squiztable]", err);
      setLabel("✗ ошибка (см. консоль)", false);
      setTimeout(() => setLabel(CONFIG.buttonLabel, false), 3000);
    } finally {
      // Любой исход — снимаем zoom и возвращаем кнопку, иначе пользователь
      // остаётся со сжатой страницей и/или невидимой кнопкой.
      button.style.visibility = "";
      restoreVirtualViewport(savedViewport);
    }
  }

  // ── Кнопка

  function injectButton() {
    if (document.getElementById("squiztable-btn")) return;
    if (!document.body) return;
    const btn = document.createElement("button");
    btn.id = "squiztable-btn";
    btn.type = "button";
    btn.textContent = CONFIG.buttonLabel;
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      padding: 12px 18px;
      background: #1f2937;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      transition: background 120ms ease;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.background = "#374151"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#1f2937"; });
    btn.addEventListener("click", () => capture(btn));
    document.body.appendChild(btn);
  }

  // SPA рендерится асинхронно — ждём body, потом инжектим. На client-side
  // навигации (router) кнопка может пропасть — переинжектим.
  function ready() {
    if (document.body) injectButton();
    else setTimeout(ready, 50);
  }
  ready();

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(injectButton, 500);
    } else if (!document.getElementById("squiztable-btn")) {
      injectButton();
    }
  }, 1500);
})();
