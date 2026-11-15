// Live-data-only acceptance checks. BASE and OUT select deployment and evidence directory.
import { chromium } from "playwright";
import { withCinemaNavigation } from "./cinema-navigation.mjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BASE = process.env.BASE || "http://127.0.0.1:3010";
const OUT = process.env.OUT || path.resolve("../hackathon-evidence");
fs.mkdirSync(OUT, { recursive: true });
const results = [], errors = [], failedResponses = [];
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
let raw, page;
const assert = (value, message) => { if (!value) throw new Error(message); };
const tid = id => page.getByTestId(id);
async function check(name, fn) {
  const started = Date.now();
  try { results.push({ name, status: "passed", detail: await fn(), ms: Date.now() - started }); }
  catch (e) { results.push({ name, status: "failed", detail: e.message, ms: Date.now() - started }); await raw.screenshot({path:path.join(OUT,`failure-${results.length}.png`),fullPage:true}).catch(()=>{}); }
  console.log(JSON.stringify(results.at(-1)));
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ base: BASE, results, errors, failedResponses }, null, 2));
}
async function bind(p) {
  raw = p; page = withCinemaNavigation(p); p.setDefaultTimeout(15000);
  p.on("pageerror", e => errors.push(e.message));
  p.on("response", r => { if (r.status() >= 400) failedResponses.push({ status:r.status(), url:r.url() }); });
}
async function loaded() {
  await raw.waitForFunction(() => {
    const p = document.querySelector('[data-testid=progress]')?.textContent || "";
    const m = p.match(/(\d+) of (\d+) images loaded/);
    return m && +m[1] > 1 && m[1] === m[2] && !p.includes("failed");
  }, null, { timeout: 45000 });
  assert(await tid("mock-banner").count() === 0, "App fell back to simulated data");
  assert(await tid("frames-error").count() === 0, "Archive error remains visible");
}
async function lit() { return tid("viewer-canvas").evaluate(c=>{const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>60)n++;return n}); }
try {
  await bind(await browser.newPage({viewport:{width:1440,height:1000}}));
  await check("Real default field loads without archive errors", async()=>{await raw.goto(BASE+"/?play=0");await loaded();return await tid("progress").innerText()});
  const targets=await (await raw.request.get(BASE+"/api/targets")).json();
  for(const t of targets) await check("Real target and spectrum: "+t.name,async()=>{
    await tid("target-"+t.id).click();await raw.waitForTimeout(350);await loaded();assert(await lit()>20,"Blank real sky image");
    await tid("spectrum").waitFor({timeout:20000});const n=await tid("spec-point").count();assert(n>=50,"Too few valid calibrated spectral channels: "+n);
    assert((await tid("spectrum-source").innerText()).includes("not a separate observing date"),"Mosaic provenance missing");
    await tid("mode-blink").click();await raw.screenshot({path:path.join(OUT,"real-"+t.id+".png"),fullPage:true});
    return {images:await tid("progress").innerText(),spectralChannels:n};
  });
  await check("All six SPHEREx wavelength bands render",async()=>{
    await tid("target-wise0855").click();await raw.waitForTimeout(350);await loaded();await tid("wise-toggle").uncheck();const bands=[];
    for(let d=1;d<=6;d++){await tid("detector").selectOption(String(d));await raw.waitForFunction(()=>/1 of 1 images loaded/.test(document.querySelector('[data-testid=progress]')?.textContent||""),null,{timeout:20000});assert(await lit()>10,"Blank band "+d);bands.push(d)}
    assert((await raw.locator(".screen-label").innerText()).includes("MOSAIC"),"Mosaic mislabeled as an exposure");await tid("wise-toggle").check();await loaded();return bands;
  });
  await check("Playback, Trail, Difference and image thumbnails",async()=>{
    await tid("mode-blink").click();const before=await tid("caption").innerText();await tid("play").click();await raw.waitForFunction(s=>document.querySelector('[data-testid=caption]')?.textContent!==s,before,{timeout:5000});await tid("play").click();
    for(const mode of ["rainbow","diff","blink"]){await tid("mode-"+mode).click();await raw.waitForTimeout(200);assert(await lit()>10,"Blank "+mode)}
    await tid("filmstrip").getByRole("button").first().click();assert(await tid("filmstrip").getByRole("button").count()>20,"Missing real dates");return "Real modes, dates and playback passed";
  });
  await check("WISE 0855 real motion recovery",async()=>{await tid("fm-run").click();await tid("fm-list").waitFor();const s=await tid("fm-list").innerText();assert(/8\.[12].*west/.test(s),"Expected westward mover missing: "+s);return s});
  for(const id of ["rwaur","rdra"]) await check("Real WISE brightness trend: "+id,async()=>{
    await tid("target-"+id).click();await raw.waitForTimeout(350);await loaded();await tid("lightcurve").waitFor();assert((await tid("lightcurve").innerText()).includes("not precision photometry"),"Quick-look limitation missing");await tid("lightcurve-data").locator("summary").click();const n=await tid("lightcurve-data").locator("tbody tr").count();assert(n>=15,"Missing real brightness dates");return {dates:n};
  });
  await check("Clicked spectrum completes and clears the spinner",async()=>{await tid("mode-blink").click();await tid("viewer-canvas").click({position:{x:200,y:200}});await raw.waitForFunction(()=>!document.querySelector('[data-testid=spectrum-loading]'),null,{timeout:20000});await tid("spectrum").waitFor();assert(await tid("spectrum-error").count()===0,"Clicked spectrum failed");return await tid("spec-point").count()});
  await check("Invalid coordinate input leaves the current field unchanged",async()=>{const u=raw.url();await tid("coord-input").fill("999 -999");await tid("coord-go").click();assert(await tid("coord-input").getAttribute("aria-invalid")==="true","Missing validation");assert(raw.url()===u,"Invalid input changed the sky");return "Accessible input validation passed"});
  await check("Live name lookup resolves Vega",async()=>{await tid("coord-input").fill("Vega");await tid("coord-go").click();await raw.waitForFunction(()=>new URL(location.href).searchParams.get("ra")?.startsWith("279.234"),null,{timeout:20000});return raw.url()});
  await check("Desktop automated accessibility",async()=>{await raw.addScriptTag({path:require.resolve("axe-core/axe.min.js")});const v=await raw.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))});fs.writeFileSync(path.join(OUT,"axe-desktop.json"),JSON.stringify(v,null,2));assert(v.length===0,JSON.stringify(v));return "No automated WCAG A/AA violations"});
  await check("Phone real data, reflow, inspectors and playback",async()=>{
    await raw.close();const c=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await bind(await c.newPage());await raw.goto(BASE+"/?play=0");await loaded();assert(await raw.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"Horizontal overflow");
    await tid("fov").scrollIntoViewIfNeeded();assert(await tid("fov").isVisible(),"Inspector does not open");await raw.getByRole("button",{name:"Close inspector",exact:true}).click();await tid("mode-blink").click();await tid("play").click();assert(await tid("play").getAttribute("aria-label")==="Pause","Phone playback failed");await tid("play").click();await raw.screenshot({path:path.join(OUT,"phone.png"),fullPage:true});return await tid("progress").innerText();
  });
  await check("No browser exceptions or failed HTTP responses",async()=>{assert(errors.length===0,errors.join("; "));assert(failedResponses.length===0,JSON.stringify(failedResponses));return "No JavaScript exceptions or HTTP failures"});
} finally {
  await browser.close();
  const esc=s=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  fs.writeFileSync(path.join(OUT,"report.html"),`<!doctype html><meta charset="utf-8"><title>Hackathon readiness</title><style>body{font:16px/1.5 system-ui;max-width:1100px;margin:40px auto;padding:20px}td,th{border:1px solid #aaa;padding:12px;text-align:left}table{border-collapse:collapse}pre{white-space:pre-wrap}.failed{color:#b00}</style><h1>Hackathon acceptance checks</h1><p>${esc(BASE)} · ${new Date().toISOString()} · ${results.filter(r=>r.status==="passed").length}/${results.length} passed. Real data only; no mocked network responses.</p><table>${results.map(r=>`<tr><th>${esc(r.name)}</th><td class="${r.status}">${r.status} (${r.ms}ms)</td><td><pre>${esc(typeof r.detail==="string"?r.detail:JSON.stringify(r.detail,null,2))}</pre></td></tr>`).join("")}</table><p>SPHEREx DR1 mosaics combine observing dates; WISE supplies time-resolved epochs. WISE brightness trends are quick-look previews, not precision photometry. Automated accessibility checks do not establish full accessibility conformance.</p>`);
}
if(results.some(r=>r.status==="failed"))process.exitCode=1;
