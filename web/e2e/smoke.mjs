// Playwright smoke test. Usage: BASE=http://localhost:3000 node e2e/smoke.mjs [?query suffix]
// Default runs in mock mode. For the real backend: QUERY="" BASE=... node e2e/smoke.mjs  (mover/colour asserts are skipped unless MOCK).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const PW = process.env.PW_PATH || "/tmp/claude-0/-root/a8bcf302-aa8b-45ec-8621-86dfdbf2d5c2/scratchpad/pw/node_modules/playwright";
const { chromium } = require(PW);
const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.QUERY === undefined;
const Q = process.env.QUERY ?? "mock=1&detector=4";
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../shots");
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

async function canvasStats(page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid=viewer-canvas]');
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const w = c.width;
    const o = { colored: 0, coloredBox: 0, blue: 0, orange: 0, nonblack: 0 };
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const p = i / 4, x = p % w, y = (p / w) | 0;
      if (r + g + b > 60) o.nonblack++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 110 && mx - mn > 70) { o.colored++; if (x > 95 && x < 160 && y > 100 && y < 160) o.coloredBox++; }
      if (b > r + 60 && b > 90) o.blue++;
      if (r > b + 60 && r > 90) o.orange++;
    }
    // brightest pixel near the fixed bright star at (60,70): should be near white in rainbow mode
    let best = [0, 0, 0];
    for (let y = 65; y < 76; y++) for (let x = 55; x < 66; x++) { const i = (y * w + x) * 4; const s = d[i] + d[i + 1] + d[i + 2]; if (s > best[0] + best[1] + best[2]) best = [d[i], d[i + 1], d[i + 2]]; }
    o.star = best;
    return o;
  });
}
const loaded = (page) => page.waitForFunction(() => /(\d+) of \1 images loaded/.test(document.querySelector('[data-testid=progress]')?.textContent || "") , null, { timeout: 90000 });
const noOverflow = async (page, label) => {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  ok(sw <= iw, `${label}: no horizontal overflow (scrollWidth ${sw} <= ${iw})`);
};

const browser = await chromium.launch();
for (const [name, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: name === "phone" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", (r) => { if (r.status() >= 400 && !/\/(health|targets|frames|wise|image|stack|spectrum)/.test(r.url())) errors.push("http " + r.status() + " " + r.url()); });

  await page.goto(`${BASE}/?${Q}`);
  await page.waitForSelector('[data-testid=viewer-canvas]');
  await loaded(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-blink.png`, fullPage: true });
  await noOverflow(page, `${name} blink`);

  // blink: step changes the caption; play toggles
  const cap0 = await page.textContent('[data-testid=caption]');
  await page.click('[aria-label="Next date"]');
  const cap1 = await page.textContent('[data-testid=caption]');
  ok(cap0 !== cap1, `${name}: stepping changes the shown epoch ("${cap0.slice(0, 30)}" -> "${cap1.slice(0, 30)}")`);
  await page.click('[data-testid=play]');
  await page.waitForTimeout(1200);
  const cap2 = await page.textContent('[data-testid=caption]');
  ok(cap2 !== cap1, `${name}: play advances frames`);
  await page.click('[data-testid=play]');
  if (name === "desktop") {
    await page.hover('[data-testid=viewer-canvas]');
    await page.mouse.move(500, 300);
    ok(/RA \d\dh/.test(await page.textContent('[data-testid=readout]')), "desktop: RA/Dec readout on hover");
  }

  // rainbow
  await page.click('[data-testid=mode-rainbow]');
  await loaded(page); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-rainbow.png`, fullPage: true });
  await noOverflow(page, `${name} rainbow`);
  const rb = await canvasStats(page);
  console.log("  rainbow stats", JSON.stringify(rb));
  if (MOCK) {
    ok(rb.coloredBox >= 15, `${name}: rainbow shows a coloured streak near the mover (${rb.coloredBox} px)`);
    const [r, g, b] = rb.star;
    ok(Math.max(r, g, b) - Math.min(r, g, b) < 70 && g > 150, `${name}: stationary bright star is ~white (${rb.star})`);
  }

  // diff
  await page.click('[data-testid=mode-diff]');
  await loaded(page); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-diff.png`, fullPage: true });
  await noOverflow(page, `${name} diff`);
  const a = await page.inputValue('[data-testid=diff-a]'), b = await page.inputValue('[data-testid=diff-b]');
  ok(a !== b, `${name}: diff default A (${a}) != B (${b})`);
  const df = await canvasStats(page);
  console.log("  diff stats", JSON.stringify(df));
  if (MOCK) ok(df.blue > 20 && df.orange > 20, `${name}: diff has blue (${df.blue}) and orange (${df.orange}) pixels`);
  ok(df.nonblack > 50, `${name}: diff is not blank`);
  ok(!(await page.$('[data-testid=diff-warning]')), `${name}: no wavelength warning for same-detector diff`);
  if (MOCK) {
    await page.check('[data-testid=wise-toggle]');
    await page.waitForTimeout(400);
    ok(!!(await page.$('[data-testid=diff-warning]')), `${name}: mismatched wavelength warning appears with WISE included`);
    await page.uncheck('[data-testid=wise-toggle]');
  }

  // pad
  await page.click('[data-testid=mode-blink]');
  const cell = await page.$('[data-testid=cell-2-2]');
  await cell.scrollIntoViewIfNeeded();
  const c1 = await page.$('[data-testid=cell-5-1]'), c3 = await page.$('[data-testid=cell-5-3]');
  const b1 = await c1.boundingBox(), b3 = await c3.boundingBox();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const urlA = page.url();
  ok(/detector=5/.test(urlA) && /pf=1/.test(urlA) && /pt=3/.test(urlA), `${name}: pad drag selects detector 5 passes 1-3 (${urlA.split("?")[1]})`);
  await page.screenshot({ path: `${OUT}/${name}-pad.png`, fullPage: true });

  // spectrum
  const cv = await page.$('[data-testid=viewer-canvas]');
  // click through the element (not raw screen coordinates) so it works wherever the image sits on the page
  const bb = await cv.boundingBox();
  await cv.click({ position: { x: bb.width * (96.5 / 256), y: bb.height * (168.5 / 256) } }); // variable star
  await page.waitForSelector('[data-testid=spectrum]', { timeout: 20000 });
  ok((await page.$$('[data-testid=spec-marker]')).length === 3, `${name}: spectrum has 3 line markers`);
  ok((await page.$$('[data-testid=spec-point]')).length > 10, `${name}: spectrum has points`);
  await (await page.$('[data-testid=spectrum]')).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${name}-spectrum.png`, fullPage: true });
  await noOverflow(page, `${name} spectrum`);

  // coordinate input
  await page.click('[data-testid=target-barnard]');
  await page.waitForTimeout(500);
  await page.fill('[data-testid=coord-input]', "08h55m10.831s -07d14m42.53s");
  await page.click('[data-testid=coord-go]');
  await page.waitForTimeout(600);
  let u = new URL(page.url());
  ok(Math.abs(+u.searchParams.get("ra") - 133.7951) < 2e-4 && Math.abs(+u.searchParams.get("dec") + 7.2451) < 2e-4, `${name}: sexagesimal WISE 0855 -> ${u.searchParams.get("ra")}, ${u.searchParams.get("dec")}`);
  await page.fill('[data-testid=coord-input]', "Orion Nebula");
  await page.click('[data-testid=coord-go]');
  const m1 = await page.textContent('[data-testid=coord-msg]');
  ok(/not one of the quick-pick/.test(m1), `${name}: "Orion Nebula" gives a clear no-match message`);
  await page.fill('[data-testid=coord-input]', "r");
  await page.click('[data-testid=coord-go]');
  ok(/not one of the quick-pick/.test(await page.textContent('[data-testid=coord-msg]')), `${name}: "r" does not match R Draconis`);
  await page.fill('[data-testid=coord-input]', "R Draconis");
  await page.click('[data-testid=coord-go]');
  await page.waitForTimeout(500);
  u = new URL(page.url());
  ok(Math.abs(+u.searchParams.get("dec") - 66.7586) < 1e-3, `${name}: R Draconis resolves`);
  await page.click('[data-testid=target-wise0855]');
  await page.waitForTimeout(400);
  ok(Math.abs(+new URL(page.url()).searchParams.get("ra") - 133.795129) < 1e-4, `${name}: quick-pick WISE 0855`);

  // URL state round trip + embed
  await page.goto(`${BASE}/?${Q}&mode=rainbow&fov=10&stretch=log&wise=1&embed=1`);
  await page.waitForSelector('[data-testid=viewer-canvas]');
  await loaded(page);
  ok(await page.$eval('[data-testid=mode-rainbow]', (e) => e.getAttribute("aria-selected") === "true"), `${name}: mode restored from URL`);
  ok(!(await page.$("header.top")), `${name}: embed hides header`);
  await page.screenshot({ path: `${OUT}/${name}-embed-wise-rainbow.png`, fullPage: true });
  await noOverflow(page, `${name} embed`);

  // no coverage message path is backend dependent; skip
  ok(errors.length === 0, `${name}: no console/page errors${errors.length ? " -> " + errors.slice(0, 3).join(" | ") : ""}`);
  await ctx.close();
}
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
