// Real data, layout, interrupted requests and touch scrolling.
// Usage: PW_PATH=/path/to/playwright node e2e/readiness.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || "playwright");
const base = process.env.BASE || "http://localhost:3000";
const out = process.env.OUT || "/tmp/spherex-readiness";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failures = 0;
const ok = (condition, text) => { console.log(`${condition ? "PASS" : "FAIL"} ${text}`); if (!condition) failures++; };
const loaded = (page) => page.waitForFunction(() => {
  const match = document.querySelector('[data-testid=progress]')?.textContent.match(/(\d+) of (\d+) images loaded/);
  return match && +match[1] > 0 && match[1] === match[2];
}, null, { timeout: 90000 });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [], imageRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("/wise/image/")) imageRequests.push(request.url()); });
  // Refresh metadata while image downloads are still in flight.
  await page.route("**/frames?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("probe") === "true") await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.route("**/wise/image/**", async (route) => { await new Promise((r) => setTimeout(r, 300)); await route.continue(); });
  const start = Date.now();
  await page.goto(base);
  await loaded(page);
  if (await page.getByTestId("mock-banner").count()) throw new Error("Start the real backend before running readiness checks.");
  ok(true, "real backend is connected");
  console.log(`All default images loaded in ${Date.now() - start}ms (includes injected network delays)`);
  ok(imageRequests.length === new Set(imageRequests).size, `metadata refresh did not duplicate WISE downloads (${imageRequests.length} requests)`);
  const play = await page.getByTestId("play").boundingBox();
  const shortcut = await page.getByTestId("find-shortcut").boundingBox();
  ok(play.y + play.height <= 720 && shortcut.y + shortcut.height <= 720, "playback and Find movers shortcut are visible on a laptop");
  await page.screenshot({ path: `${out}/desktop.png` });
  await page.getByTestId("find-shortcut").click();
  await page.getByTestId("fm-run").click();
  await page.getByTestId("fm-list").waitFor();
  ok(/8\.2.*west/.test(await page.getByTestId("fm-list").innerText()), "real WISE 0855 finder still recovers the mover");
  // Hold clicked measurements so timeout/cancellation paths are deterministic.
  await page.route("**/spectrum?**", () => {});
  await page.clock.install();
  const clickSpot = async () => { await page.getByTestId("viewer-canvas").click({ position: { x: 100, y: 100 } }); await page.clock.runFor(500); };
  await clickSpot();
  await page.getByTestId("spectrum-cancel").click();
  ok(/cancelled/.test(await page.getByTestId("spectrum-error").innerText()), "Cancel exits the spectrum spinner");
  await page.getByTestId("spectrum-retry").click();
  await page.clock.runFor(31000);
  ok(/longer than 30 seconds/.test(await page.getByTestId("spectrum-error").innerText()), "a stalled spectrum stops after 30 seconds and offers retry");
  await page.getByTestId("spectrum-retry").click();
  await page.getByTestId("target-rwaur").click();
  await page.clock.runFor(1000);
  ok(await page.getByTestId("spectrum-loading").count() === 0 && await page.getByTestId("spectrum-error").count() === 0, "changing targets clears the previous spectrum request and error");
  ok(errors.length === 0, `no desktop page errors (${errors.join(", ")})`);
  await page.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await mobile.goto(base);
  await loaded(mobile);
  ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "phone has no horizontal page overflow");
  await mobile.screenshot({ path: `${out}/phone.png`, fullPage: true });
  await mobile.getByTestId("viewer-canvas").scrollIntoViewIfNeeded();
  const before = await mobile.evaluate(() => scrollY);
  const urlBefore = mobile.url();
  const rect = await mobile.getByTestId("viewer-canvas").boundingBox();
  const client = await phone.newCDPSession(mobile);
  const x = rect.x + rect.width / 2, y = Math.min(650, rect.y + rect.height * .75);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 20 }] });
    await mobile.waitForTimeout(30);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForTimeout(500);
  ok(await mobile.evaluate(() => scrollY) > before + 60 && mobile.url() === urlBefore, "swiping over the sky scrolls the page without changing the sky position");
  await mobile.getByTestId("touch-pan").click();
  ok(await mobile.getByTestId("viewer-canvas").evaluate((c) => getComputedStyle(c).touchAction === "none"), "Move sky by touch explicitly enables sky gestures");
  await mobile.getByTestId("viewer-canvas").scrollIntoViewIfNeeded();
  const skyBefore = mobile.url();
  const panRect = await mobile.getByTestId("viewer-canvas").boundingBox();
  const panX = panRect.x + panRect.width / 2, panY = panRect.y + panRect.height / 2;
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: panX, y: panY }] });
  for (let i = 1; i <= 6; i++) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: panX + i * 10, y: panY + i * 3 }] });
    await mobile.waitForTimeout(30);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await mobile.waitForTimeout(600);
  ok(mobile.url() !== skyBefore && await mobile.getByTestId("pick-ring").count() === 0, "touch movement pans the sky without selecting a spectrum");
  await mobile.getByTestId("touch-pan").click();
  ok(await mobile.getByTestId("viewer-canvas").evaluate((c) => getComputedStyle(c).touchAction.includes("pan-y")), "Done moving sky restores page scrolling");
  await phone.close();
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
