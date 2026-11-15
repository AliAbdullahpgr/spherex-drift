import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || '/root/spherex-ui-review';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const results = [];
let page;
const assert = (value, message) => { if (!value) throw new Error(message); };
async function check(name, action) {
  try { const detail = await action(); results.push({name, status:'passed', detail:detail || ''}); }
  catch(error) { results.push({name,status:'failed',detail:error.message});await page?.screenshot({path:`${OUT}/failure-${results.length}.png`}).catch(()=>{}); }
  console.log(JSON.stringify(results.at(-1)));
  fs.writeFileSync(`${OUT}/results.json`,JSON.stringify(results,null,2));
}
async function loaded() { await page.waitForFunction(()=>{const m=document.querySelector('[data-testid=progress]')?.textContent.match(/(\d+) of (\d+) images loaded/);return m&&+m[1]>0&&m[1]===m[2]},null,{timeout:90000}); }
async function openPanel(panel) {
  if (await page.locator('.app.desktop-controls').count() && panel !== 'about') return;
  if (!await page.locator('.inspector').isVisible()) await page.getByTestId(panel==='analyze'?'open-analysis':'open-view').click();
  await page.locator('.inspector-nav').getByRole('button',{name:panel==='view'?'View':panel==='analyze'?'Analyze':'Notes',exact:true}).click();
}
async function closePanel(){if(await page.locator('.inspector').isVisible())await page.getByRole('button',{name:'Close inspector',exact:true}).click();}
async function tool(name){await openPanel('analyze');await page.locator(`#analysis-tab-${name}`).click();}
try {
  page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE+'/?mock=1&play=0');await loaded();
  await check('Five compact targets; one unambiguous active target',async()=>{
    assert(await page.locator('.target-card').count()===5,'missing target cards');
    assert(await page.locator('.target-card.active').count()===1,'active target ambiguous');
    assert(await page.locator('.target-card.active').getAttribute('data-testid')==='target-wise0855','wrong default active target');
    const styles=await page.locator('.target-card.active').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,weight:getComputedStyle(e.querySelector('.target-name')).fontWeight}));
    assert(styles.bg!==await page.locator('.target-card:not(.active)').first().evaluate(e=>getComputedStyle(e).backgroundColor),'active field lacks contrasting card');
    assert(!await page.locator('body').innerText().then(t=>t.includes('Test targets')),'test wording remains');
  });
  await check('Desktop: large square image and compact controls in one viewport',async()=>{
    const frame=await page.getByTestId('viewer-canvas').boundingBox();const dock=await page.getByTestId('transport').boundingBox();
    assert(frame.width>=630 && Math.abs(frame.width-frame.height)<1,'image is small or distorted');
    assert(dock.y+dock.height<=900,'controls below viewport');assert(dock.width<=860,'controls too dispersed');
    assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),'desktop page unexpectedly scrolls');
    assert((await page.locator('.control-rail p:visible').allTextContents()).every(text=>text.trim().split(/\s+/).length<=30),'side controls contain long explanatory paragraphs');
    await page.screenshot({path:`${OUT}/desktop.png`});return `Image ${Math.round(frame.width)}px square; dock ${Math.round(dock.width)}px.`;
  });
  await check('Video seek bar: drag, keyboard stepping, pause and matching date',async()=>{
    const seek=page.getByTestId('seek');await seek.focus();await page.keyboard.press('End');
    assert(+await seek.inputValue()===+await seek.getAttribute('max'),'End did not seek to last date');
    assert(await page.getByTestId('play').getAttribute('aria-label')==='Play','seek did not pause');
    await page.keyboard.press('Home');assert(await seek.inputValue()==='0','Home did not seek to beginning');
    const box=await seek.boundingBox();await page.mouse.click(box.x+box.width*.55,box.y+box.height/2);
    assert(+await seek.inputValue()>0,'clicking track did not seek');
    const value=+await seek.inputValue();await page.getByRole('button',{name:'Next date',exact:true}).click();assert(+await seek.inputValue()===value+1,'next frame not synchronized with seek');
    await page.getByRole('button',{name:'Previous date',exact:true}).click();assert(+await seek.inputValue()===value,'previous frame not synchronized');
  });
  await check('Speed, loop end-stop and restarting playback',async()=>{
    await page.getByTestId('speed').selectOption('6');await page.getByTestId('loop-toggle').click();
    await page.getByTestId('seek').focus();await page.keyboard.press('End');await page.getByTestId('play').click();
    assert(await page.getByTestId('seek').inputValue()==='0','Play at end did not restart');
    await page.getByTestId('play').click();await page.getByTestId('seek').focus();await page.keyboard.press('End');
    await page.locator('main').focus();await page.keyboard.press('Space');assert(await page.getByTestId('seek').inputValue()==='0','Space at end did not restart');
    await page.getByTestId('play').click();await page.getByTestId('loop-toggle').click();await page.getByTestId('speed').selectOption('2');
  });
  await check('Frames are deliberate: gallery toggle, selection, current frame kept in view',async()=>{
    await page.getByTestId('frames-toggle').click();await page.getByTestId('filmstrip').getByRole('button').last().click();
    const count=await page.getByTestId('filmstrip').getByRole('button').count();assert(+await page.getByTestId('seek').inputValue()===count-1,'thumbnail does not seek');
    await page.getByTestId('frames-toggle').click();assert(!await page.getByTestId('filmstrip').isVisible(),'gallery did not collapse');
    await page.getByTestId('frames-toggle').click();await page.waitForTimeout(400);
    assert(await page.getByTestId('filmstrip').evaluate(e=>{const b=e.querySelector('.active')?.getBoundingClientRect(),r=e.getBoundingClientRect();return b&&b.left>=r.left&&b.right<=r.right}),'active frame not scrolled into view');
    await page.getByTestId('frames-toggle').click();
  });
  await check('Desktop controls: visible on both sides, readable typography, no blocking modal',async()=>{
    assert(await page.getByTestId('view-rail').isVisible()&&await page.getByTestId('analysis-rail').isVisible(),'side controls are hidden');
    assert(+await page.getByLabel('Crosshair',{exact:true}).evaluate(e=>parseFloat(getComputedStyle(e.closest('label')).fontSize))>=14,'labels too small');
    await page.getByTestId('wise-toggle').uncheck();await page.getByTestId('detector').selectOption('4');await page.getByTestId('invert-toggle').check();await loaded();
    assert(!await page.locator('.inspector').isVisible(),'desktop view settings opened a blocking dialog');
    assert(await page.locator('.frame.inv').count()===1,'setting did not reach image');
    await page.getByTestId('invert-toggle').uncheck();await page.getByTestId('wise-toggle').check();await loaded();
  });
  await check('Display modes and difference comparison remain functional',async()=>{
    await page.getByTestId('mode-rainbow').click();assert(await page.getByTestId('rainbow-help').isVisible(),'trail key missing');
    await page.getByTestId('mode-diff').click();await page.getByTestId('diff-pair').click();assert(await page.getByTestId('diff-a').inputValue()!==await page.getByTestId('diff-b').inputValue(),'identical compare dates');
    await page.getByTestId('diff-each').click();await page.getByTestId('mode-blink').click();
  });
  await check('Click-to-spectrum opens and pauses the inspector',async()=>{
    await page.getByTestId('viewer-canvas').click({position:{x:240,y:240}});await page.getByTestId('spectrum').waitFor();
    assert(await page.locator('#analysis-tab-spectrum').getAttribute('aria-selected')==='true','spectrum tab not selected');
    assert(await page.getByTestId('play').getAttribute('aria-label')==='Play','image kept playing while inspecting');
    await closePanel();
  });
  await check('Motion analysis: finder, stacking and results survive closing inspector',async()=>{
    await tool('motion');await page.getByTestId('fm-run').click();await page.getByTestId('fm-list').waitFor();
    assert(await page.getByTestId('fm-list').getByRole('button',{name:'Show',exact:true}).count()>0,'finder returned no demo mover');
    await page.getByTestId('sa-catalog').click();await page.getByTestId('sa-result').waitFor();await closePanel();
    await tool('motion');assert(await page.getByTestId('sa-result').isVisible(),'closing inspector discarded result');await closePanel();
  });
  await check('Simulation inspector: injection, custom motion, disclosure and reveal',async()=>{
    await tool('planet');await page.getByTestId('px-toggle').check();await page.getByTestId('px-kind-custom').click();await page.getByTestId('px-reveal').click();await closePanel();
    assert(await page.getByTestId('px-note').isVisible(),'simulation disclosure hidden with panel');
    assert(await page.getByTestId('pm-mark').filter({hasText:'simulated'}).count()>0,'reveal not drawn');
    await tool('planet');await page.getByTestId('px-toggle').uncheck();await closePanel();
  });
  await check('Fullscreen enters and exits',async()=>{
    await page.getByTestId('fullscreen').click();assert(await page.evaluate(()=>!!document.fullscreenElement),'fullscreen did not enter');
    await page.getByTestId('fullscreen').click();assert(await page.evaluate(()=>!document.fullscreenElement),'fullscreen did not exit');
  });
  await check('Accessibility: main player and native dialog',async()=>{
    await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const scan=async()=>page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}})).violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})));
    const root=await scan();assert(!root.length,JSON.stringify(root));await openPanel('view');const inspector=await scan();assert(!inspector.length,JSON.stringify(inspector));
    await page.screenshot({path:`${OUT}/workbench.png`});await closePanel();
  });
  await check('No browser exceptions',async()=>assert(errors.length===0,errors.join('\n')));
  await page.close();
  for (const [name,width,height] of [['laptop',1280,720],['phone',390,844],['narrow',320,740]]) {
    page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600});await page.goto(BASE+'/?mock=1&play=0');await loaded();
    await check(`${name}: player, active target and image fit without overflow`,async()=>{
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),'viewport overflow');
      const box=await page.getByTestId('transport').boundingBox();assert(box.y+box.height<=height,'player off screen');
      const target=await page.locator('.target-card.active').boundingBox();assert(target.x>=0&&target.x+target.width<=width,'active target not visible');
      const image=await page.getByTestId('viewer-canvas').boundingBox();if(name==='laptop')assert(image.width>=460,'laptop image did not grow');else assert(image.width>=width-2,'phone image is not edge-to-edge');
      await page.screenshot({path:`${OUT}/${name}.png`});return `Image ${Math.round(image.width)}px.`;
    });
    if(width<600)await check(`${name}: bottom-sheet settings, target switching and accessibility`,async()=>{
      await page.getByTestId('open-view').click();const dialog=await page.locator('.inspector').boundingBox();assert(Math.abs(dialog.y+dialog.height-height)<2,'inspector is not a bottom sheet');
      await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});const violations=await page.evaluate(async()=> (await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(v=>v.id));assert(!violations.length,JSON.stringify(violations));
      await closePanel();await page.getByTestId('target-rdra').click();await loaded();assert(await page.getByTestId('target-rdra').getAttribute('aria-current')==='true','new active target not announced');
    });
    await page.close();
  }
  page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(BASE+'/?play=0');await loaded();
  await check('Real archive: target navigation, spectrum and no demo fallback',async()=>{
    assert(await page.getByTestId('mock-banner').count()===0,'real backend unavailable');
    for(const id of ['barnard','epsindib','wise0855','rwaur','rdra']){await page.getByTestId('target-'+id).click();await loaded();assert(await page.getByTestId('target-'+id).getAttribute('aria-current')==='true','wrong target');}
    await openPanel('analyze');assert(await page.locator('#analysis-tab-brightness').getAttribute('aria-selected')==='true','variable star did not default to brightness');
    await page.getByTestId('lightcurve').waitFor({timeout:45000});await closePanel();await page.screenshot({path:`${OUT}/real-desktop.png`});
  });
} finally { await browser.close(); }
if(results.some(r=>r.status==='failed'))process.exitCode=1;
