// Screenshot a Squiz-style results table, fitted to 1920x1080.
// Usage: node shot.js <url> [--out file.png] [--selector "css"] [--padding 50]

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

// ── CONFIG. The slider* fields drive the page's own UI sliders so each
//    shot uses the same settings, regardless of what's saved in the browser.
const CONFIG = {
  viewport: { width: 1920, height: 1080 },
  padding: 50,            // min px of whitespace between panel and screenshot edge
  sliderFont: 140,        // value to set on the font-size slider; null = leave alone
  sliderWidth: "auto",    // explicit value, or "auto" to step down until panel fits, or null = leave alone
  fontSizeOverride: "1.4rem", // CSS override applied on top of the slider; null = none
  rowPaddingY: null,      // cell vertical padding: a value like "4px", or "auto" to compress until panel fits height; null = leave alone
  lineHeight: null,       // cell line-height; null = leave alone
  panelBorder: "2px solid rgba(255,255,255,0.22)", // CSS shorthand for the panel border. The site's own 1px border is too faint after downscaling. null = leave alone.
  background: null,       // composite bg colour (e.g. "#0c1116"); null = use page's body bg
  waitTimeout: 30000,
};

function parseArgs(argv) {
  const args = { url: null, out: null, selector: null, padding: CONFIG.padding };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") args.out = rest[++i];
    else if (a === "--selector") args.selector = rest[++i];
    else if (a === "--padding") args.padding = Number(rest[++i]);
    else if (!args.url && !a.startsWith("--")) args.url = a;
  }
  return args;
}

function sanitizeFilename(s) {
  return (s || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function todayMMDD() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

// Build {MMDD}_{title}_{n}.png in cwd, picking the smallest free n.
function nextFreePath(base) {
  for (let n = 1; n < 10000; n++) {
    const p = path.resolve(`${base}_${n}.png`);
    if (!fs.existsSync(p)) return p;
  }
  return path.resolve(`${base}_overflow.png`);
}

async function resolveOutPath(page, requestedOut, url) {
  if (requestedOut) return path.resolve(requestedOut);
  const title = await page.evaluate(() => {
    const el = document.querySelector(".text-lg.text-foreground");
    if (!el) return "";
    // Strip out muted-foreground descendants — we only want the primary text.
    const cloned = el.cloneNode(true);
    cloned.querySelectorAll(".text-muted-foreground").forEach((n) => n.remove());
    return cloned.textContent;
  });
  let base = sanitizeFilename(title);
  if (!base) {
    const m = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    base = m ? m[0] : "screenshot";
  }
  return nextFreePath(`${todayMMDD()}_${base}`);
}

// Enumerate Radix-style sliders ([role="slider"]) plus native <input type="range">.
// Each entry has a guessed `label` from surrounding text.
async function listSliders(page) {
  return page.evaluate(() => {
    function getText(el) {
      if (!el) return "";
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 40) return t;
      return (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    }
    function labelFor(rootEl) {
      // Walk backward through preceding siblings looking for the nearest
      // bit of text that could be a label.
      let n = rootEl.previousElementSibling;
      while (n) {
        const t = getText(n);
        if (t) return t;
        n = n.previousElementSibling;
      }
      // No luck — climb up and try preceding siblings of each ancestor.
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
      // The thumb itself often has data-orientation; we want the track
      // container above it, not the thumb.
      let n = thumb.parentElement;
      while (n && n !== document.body) {
        if (n.matches("[data-orientation]")) return n;
        n = n.parentElement;
      }
      return thumb;
    }
    const out = [];
    document.querySelectorAll('[role="slider"]').forEach((thumb) => {
      const root = sliderRoot(thumb);
      out.push({
        kind: "radix",
        label: labelFor(root),
        min: parseFloat(thumb.getAttribute("aria-valuemin")) || 0,
        max: parseFloat(thumb.getAttribute("aria-valuemax")) || 100,
        value: parseFloat(thumb.getAttribute("aria-valuenow")) || 0,
      });
    });
    document.querySelectorAll('input[type="range"]').forEach((r) => {
      out.push({
        kind: "input",
        label: labelFor(r),
        min: parseFloat(r.min) || 0,
        max: parseFloat(r.max) || 100,
        value: parseFloat(r.value) || 0,
      });
    });
    return out.map((s, i) => ({ idx: i, ...s }));
  });
}

// Read current aria-valuenow for the i-th Radix thumb on the page.
async function radixValue(page, thumbIdx) {
  return page.evaluate((i) => {
    const t = document.querySelectorAll('[role="slider"]')[i];
    return t ? parseFloat(t.getAttribute("aria-valuenow")) : NaN;
  }, thumbIdx);
}

async function setRadixSlider(page, thumbIdx, target) {
  const thumb = page.locator('[role="slider"]').nth(thumbIdx);
  const info = await thumb.evaluate((el) => ({
    min: parseFloat(el.getAttribute("aria-valuemin")) || 0,
    max: parseFloat(el.getAttribute("aria-valuemax")) || 100,
    value: parseFloat(el.getAttribute("aria-valuenow")) || 0,
  }));
  await thumb.focus();
  if (target >= info.max) {
    await page.keyboard.press("End");
    await page.waitForTimeout(150);
    return;
  }
  if (target <= info.min) {
    await page.keyboard.press("Home");
    await page.waitForTimeout(150);
    return;
  }
  let cur = info.value;
  for (let i = 0; i < 400; i++) {
    if (cur === target) break;
    const before = cur;
    await page.keyboard.press(cur < target ? "ArrowRight" : "ArrowLeft");
    // React reflects the new value asynchronously — poll briefly.
    for (let p = 0; p < 10; p++) {
      await page.waitForTimeout(15);
      cur = await radixValue(page, thumbIdx);
      if (cur !== before) break;
    }
    if (cur === before) break; // step had no effect — at a bound
  }
}

// Apply a cell-padding override and report resulting panel height.
async function applyRowPadding(page, padY, lineHeight) {
  return page.evaluate(({ padY, lineHeight }) => {
    let s = document.getElementById("shot-row-fit");
    if (!s) {
      s = document.createElement("style");
      s.id = "shot-row-fit";
      document.head.appendChild(s);
    }
    const lh = lineHeight ? `line-height: ${lineHeight} !important;` : "";
    s.textContent = `
      [data-shot-target] tr { height: auto !important; min-height: 0 !important; }
      [data-shot-target] td, [data-shot-target] th {
        padding-top: ${padY}px !important;
        padding-bottom: ${padY}px !important;
        height: auto !important;
        min-height: 0 !important;
        ${lh}
      }
      [data-shot-target] td > *, [data-shot-target] th > * {
        margin-top: 0 !important;
        margin-bottom: 0 !important;
      }
    `;
    const el = document.querySelector("[data-shot-target]");
    return el ? el.getBoundingClientRect().height : 0;
  }, { padY, lineHeight });
}

// Compress cell vertical padding until the panel fits within targetHeight,
// or padding hits 0. Returns the final padding value used.
async function fitRowsToHeight(page, targetHeight, lineHeight) {
  // Start at a generous padding so we can also expand if there's room.
  for (let pad = 12; pad >= 0; pad--) {
    const h = await applyRowPadding(page, pad, lineHeight);
    await page.waitForTimeout(20);
    if (h <= targetHeight) return { pad, height: h };
  }
  const h = await applyRowPadding(page, 0, lineHeight);
  return { pad: 0, height: h };
}

// Find the «Команда» column inside [data-shot-target] and install a page-side
// predicate at window.__teamWraps() that returns true when any team-name cell
// is taller than its sibling reference cell — i.e. the name has wrapped to two
// lines. Returns the column index, or null if the header wasn't found (caller
// then falls back to frame-only width fit).
async function installTeamWrapCheck(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("[data-shot-target]");
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
    const bodies = table.tBodies && table.tBodies.length ? Array.from(table.tBodies) : [table];
    const bodyRows = [];
    for (const b of bodies) {
      for (const r of b.rows) {
        if (r === headerRow) continue;
        if (r.cells.length > colIdx) bodyRows.push(r);
      }
    }
    if (!bodyRows.length) return null;
    window.__teamWraps = () => {
      for (const row of bodyRows) {
        const name = row.cells[colIdx];
        if (!name) continue;
        let ref = null;
        for (let i = 0; i < row.cells.length; i++) {
          if (i !== colIdx) { ref = row.cells[i]; break; }
        }
        if (!ref) continue;
        if (name.offsetHeight > ref.offsetHeight + 2) return true;
      }
      return false;
    };
    return colIdx;
  });
}

// Width slider auto-fit: shrink past the 1820px frame limit until any team
// name wraps to two lines, then step back one tick. Falls back to frame-only
// behaviour when teamColIdx is null. Returns { width, reason }.
async function fitWidthSlider(page, thumbIdx, targetWidth, hasWrapCheck) {
  const thumb = page.locator('[role="slider"]').nth(thumbIdx);
  await thumb.focus();
  const measure = async () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-shot-target]");
      return el ? el.getBoundingClientRect().width : 0;
    });
  let lastW = await measure();
  for (let i = 0; i < 200; i++) {
    const w = await measure();
    lastW = w;
    if (w === 0) return { width: 0, reason: "no-panel" };
    if (w > targetWidth) {
      const before = await radixValue(page, thumbIdx);
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(30);
      if ((await radixValue(page, thumbIdx)) === before) return { width: w, reason: "slider-min-overflow" };
      continue;
    }
    if (!hasWrapCheck) return { width: w, reason: "frame-no-wrapcheck" };
    const wraps = await page.evaluate(() => window.__teamWraps && window.__teamWraps());
    if (wraps) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(30);
      return { width: await measure(), reason: "wrap" };
    }
    const before = await radixValue(page, thumbIdx);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(30);
    if ((await radixValue(page, thumbIdx)) === before) return { width: w, reason: "slider-min" };
  }
  return { width: lastW, reason: "iter-cap" };
}

async function findPanel(page, userSelector) {
  return page.evaluate((userSelector) => {
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
    let el = null;
    if (userSelector) el = document.querySelector(userSelector);
    if (!el) el = pickLargest(document.querySelectorAll("table"));
    if (!el) el = pickLargest(document.querySelectorAll('[role="table"], [class*="table" i], [class*="Table"]'));
    if (!el) return null;

    if (!userSelector) {
      // Walk up to find the FIRST visually-styled ancestor (border / radius /
      // shadow / non-transparent bg). That's the immediate panel wrapper.
      // Stop as soon as we find one — going further usually grabs page chrome.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let panel = el;
      for (let n = el.parentElement, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
        const r = n.getBoundingClientRect();
        if (r.width >= vw && r.height >= vh * 0.9) break; // page-level wrapper
        const cs = getComputedStyle(n);
        const radius = Math.max(
          parseFloat(cs.borderTopLeftRadius) || 0,
          parseFloat(cs.borderTopRightRadius) || 0
        );
        const bg = cs.backgroundColor;
        const hasBg = bg && bg !== "transparent" && !/^rgba\(0,\s*0,\s*0,\s*0\)/.test(bg);
        const hasShadow = cs.boxShadow && cs.boxShadow !== "none";
        const hasBorder = parseFloat(cs.borderTopWidth) > 0;
        if (radius >= 4 || hasBorder || hasShadow || hasBg) {
          panel = n;
          break;
        }
      }
      el = panel;
    }
    el.setAttribute("data-shot-target", "1");
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, classes: el.className, width: r.width, height: r.height };
  }, userSelector);
}

function pickSlider(sliders, regex) {
  const idx = sliders.findIndex((s) => regex.test(s.label));
  return idx >= 0 ? idx : -1;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error('Usage: node shot.js <url> [--out file.png] [--selector "css"] [--padding 50]');
    process.exit(1);
  }
  const browser = await chromium.launch();
  // Source page rendered at 2x DPR so the panel screenshot has 2x detail —
  // gives sharper text and visible 1px borders after downscaling in the composite.
  const sourceCtx = await browser.newContext({ viewport: CONFIG.viewport, deviceScaleFactor: 2 });
  const page = await sourceCtx.newPage();

  console.log(`Opening ${args.url}`);
  await page.goto(args.url, { waitUntil: "networkidle", timeout: CONFIG.waitTimeout });

  const out = await resolveOutPath(page, args.out, args.url);

  // Materialize virtualized rows.
  await page.evaluate(async () => {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle", { timeout: CONFIG.waitTimeout }).catch(() => {});

  const sliders = await listSliders(page);
  if (sliders.length) {
    console.log("Sliders:");
    for (const s of sliders) {
      console.log(`  [${s.idx}] ${s.kind} "${s.label}" range=${s.min}..${s.max} value=${s.value}`);
    }
  } else {
    console.log("No sliders detected on the page.");
  }

  let fontIdx = pickSlider(sliders, /(шрифт|font|размер|^t($|\s))/i);
  let widthIdx = pickSlider(sliders, /(ширин|width)/i);
  // Fallback: if there are exactly two Radix sliders and we couldn't
  // disambiguate by label, assume DOM order is [font, width].
  const radixSliders = sliders.filter((s) => s.kind === "radix");
  if (radixSliders.length === 2) {
    if (fontIdx < 0 && widthIdx < 0) {
      fontIdx = sliders.indexOf(radixSliders[0]);
      widthIdx = sliders.indexOf(radixSliders[1]);
      console.log("Falling back to DOM order: [0]=font, [1]=width");
    } else if (fontIdx < 0) {
      fontIdx = sliders.indexOf(radixSliders.find((s) => sliders.indexOf(s) !== widthIdx));
    } else if (widthIdx < 0) {
      widthIdx = sliders.indexOf(radixSliders.find((s) => sliders.indexOf(s) !== fontIdx));
    }
  }

  if (CONFIG.sliderFont != null) {
    if (fontIdx >= 0 && sliders[fontIdx].kind === "radix") {
      console.log(`Setting font slider [${sliders[fontIdx].label}] = ${CONFIG.sliderFont}`);
      await setRadixSlider(page, sliders.slice(0, fontIdx + 1).filter((s) => s.kind === "radix").length - 1, CONFIG.sliderFont);
    } else if (fontIdx >= 0) {
      console.warn(`Font slider is ${sliders[fontIdx].kind}, not a Radix thumb — skipping.`);
    } else {
      console.warn("Font slider not found by label.");
    }
  }

  // Give the SPA time to recompute layout (font-size affects every cell).
  await page.waitForTimeout(300);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Find the panel (table's bordered/rounded wrapper).
  const panel = await findPanel(page, args.selector);
  if (!panel) {
    console.error('No table-like element found. Pass --selector "<css>".');
    await browser.close();
    process.exit(2);
  }
  console.log(`Panel: <${panel.tag}> ${Math.round(panel.width)}×${Math.round(panel.height)} px`);

  // Wait for the panel to populate.
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-shot-target]");
    if (!el) return false;
    if (el.tagName === "TABLE") return el.rows && el.rows.length > 1;
    return el.querySelector("tr, [role='row']") || (el.children && el.children.length > 1);
  }, { timeout: CONFIG.waitTimeout });

  // Optional CSS font-size override (lets you go past the slider's max).
  if (CONFIG.fontSizeOverride) {
    console.log(`Applying font-size override: ${CONFIG.fontSizeOverride}`);
    await page.evaluate((fs) => {
      const style = document.createElement("style");
      style.id = "shot-font-override";
      style.textContent = `[data-shot-target], [data-shot-target] * { font-size: ${fs} !important; }`;
      document.head.appendChild(style);
    }, CONFIG.fontSizeOverride);
    await page.waitForTimeout(200);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  // Force a visible border around the panel — the site's 1px is too faint
  // and washes out after the composite downscales the 2x DPR buffer.
  if (CONFIG.panelBorder) {
    console.log(`Applying panel border: ${CONFIG.panelBorder}`);
    await page.evaluate((b) => {
      const style = document.createElement("style");
      style.id = "shot-panel-border";
      // Box-sizing keeps the panel's outer dimensions stable so width
      // auto-fit doesn't have to redo work.
      style.textContent = `[data-shot-target] { border: ${b} !important; box-sizing: border-box !important; }`;
      document.head.appendChild(style);
    }, CONFIG.panelBorder);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  // Sample the page background so the panel itself has fill inside its
  // rounded shape (otherwise on Squiz the card is transparent and only the
  // body provides colour — which we strip with omitBackground below).
  const pageBg = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    return bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#0c1116";
  });
  const bg = CONFIG.background || pageBg;

  // Paint the panel's own background + clip children to the rounded corners
  // (so the table header doesn't poke out past the rounded frame). Mirrors
  // the userscript so both produce identical screenshots.
  await page.evaluate((bg) => {
    const style = document.createElement("style");
    style.id = "shot-panel-bg";
    style.textContent = `[data-shot-target] { background-color: ${bg} !important; overflow: hidden !important; }`;
    document.head.appendChild(style);
  }, bg);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // Row-padding control: explicit value, "auto" (compress to fit height), or null.
  if (CONFIG.rowPaddingY != null) {
    const targetH = CONFIG.viewport.height - 2 * args.padding;
    if (CONFIG.rowPaddingY === "auto") {
      console.log(`Auto-compressing row padding until panel ≤ ${targetH}px tall`);
      const r = await fitRowsToHeight(page, targetH, CONFIG.lineHeight);
      console.log(`  cell padY=${r.pad}px, panel.height=${Math.round(r.height)}px`);
    } else {
      const padY = parseFloat(CONFIG.rowPaddingY) || 0;
      const h = await applyRowPadding(page, padY, CONFIG.lineHeight);
      console.log(`Cell padY=${padY}px, panel.height=${Math.round(h)}px`);
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }

  // Width slider: explicit, "auto" (step down to fit), or null (skip).
  if (CONFIG.sliderWidth != null && widthIdx >= 0 && sliders[widthIdx].kind === "radix") {
    const radixIdx = sliders.slice(0, widthIdx + 1).filter((s) => s.kind === "radix").length - 1;
    if (CONFIG.sliderWidth === "auto") {
      const target = CONFIG.viewport.width - 2 * args.padding;
      const teamColIdx = await installTeamWrapCheck(page);
      if (teamColIdx == null) {
        console.warn("Team-name column not found — falling back to frame-fit only.");
      } else {
        console.log(`Team column idx=${teamColIdx}; auto-fit width ≤ ${target}px (stop on wrap)`);
      }
      const res = await fitWidthSlider(page, radixIdx, target, teamColIdx != null);
      console.log(`  panel.width = ${Math.round(res.width)} px (stop: ${res.reason})`);
    } else {
      console.log(`Setting width slider [${sliders[widthIdx].label}] = ${CONFIG.sliderWidth}`);
      await setRadixSlider(page, radixIdx, CONFIG.sliderWidth);
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  } else if (CONFIG.sliderWidth != null && widthIdx < 0) {
    console.warn("Width slider not found by label.");
  }

  // Element screenshot of just the panel — omitBackground strips the body
  // bg, so the rectangular bbox outside the rounded shape is transparent.
  // The panel's own bg (injected above) fills inside the rounded shape.
  const panelBuf = await page.locator("[data-shot-target]").screenshot({ omitBackground: true });

  // Composite onto a 1920×1080 canvas at 1x DPR so the final PNG is
  // exactly viewport-sized. The browser downscales the 2x panel buffer to
  // fit, which keeps text crisp. Body has no background — combined with
  // omitBackground the area around the panel stays transparent in the PNG.
  const composeCtx = await browser.newContext({ viewport: CONFIG.viewport, deviceScaleFactor: 1 });
  const composer = await composeCtx.newPage();
  const maxW = CONFIG.viewport.width - 2 * args.padding;
  const maxH = CONFIG.viewport.height - 2 * args.padding;
  // Box is fixed to the inner frame (1820×980 with padding=50). object-fit:
  // contain handles aspect: the narrower-than-frame panel is upscaled until
  // one side hits the box, the other is letterboxed. Panel buffer was taken
  // at 2x DPR so moderate upscale stays sharp.
  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; width: ${CONFIG.viewport.width}px; height: ${CONFIG.viewport.height}px; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; }
    img { width: ${maxW}px; height: ${maxH}px; object-fit: contain; image-rendering: -webkit-optimize-contrast; }
  </style></head><body><img src="data:image/png;base64,${panelBuf.toString("base64")}" /></body></html>`;
  await composer.setContent(html);
  await composer.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await composer.screenshot({
    path: out,
    omitBackground: true,
    clip: { x: 0, y: 0, width: CONFIG.viewport.width, height: CONFIG.viewport.height },
  });
  console.log(`Saved ${out}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
