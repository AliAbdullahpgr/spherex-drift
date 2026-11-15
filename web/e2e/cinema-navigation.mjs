// Navigate the real inspector before exercising a control. This keeps existing
// feature tests useful after moving controls out of the permanent page layout.
const isView = id => /^(coord-|fov$|detector$|src$|wise-toggle$|ov-|gaia-status$|known-status$|sharp-toggle$|invert-toggle$|stretch|bp$|wp$|win$|ends$|flags$|mark-toggle$|cell-|pad$)/.test(id);
const analysisTab = id => /^(px-|planetx)/.test(id) ? 'planet' : /^(lightcurve|lc-line)/.test(id) ? 'brightness' : /^(context|link-)/.test(id) ? 'context' : /^(spectrum|spec-)/.test(id) ? 'spectrum' : /^(fm-|sa-|ml-|motion)/.test(id) ? 'motion' : null;
const isNotes = id => /^(measured|about-target|walk)/.test(id);
const isRoot = id => /^(target-|mode-|diff-|each-|rainbow-help|viewer|play$|frame-count|caption|progress|transport|readout|seek|fullscreen|loop-toggle|frames-toggle|find-shortcut|open-)/.test(id);
function idFrom(selector) { if (/aria-label=["'](?:Next|Previous) date/.test(selector || "")) return "play"; return selector?.match(/data-testid\s*=\s*["']?([\w-]+)/)?.[1]; }
export function withCinemaNavigation(raw) {
  let navigation = Promise.resolve();
  async function navigate(id) {
    if (!id) return;
    const tab = analysisTab(id);
    let desired = isView(id) ? 'view' : isNotes(id) ? 'about' : tab ? 'analyze' : null;
    const root = isRoot(id) || id === 'filmstrip' || id === 'timeline';
    if (!desired && !root) return;
    navigation = navigation.catch(()=>{}).then(async () => {
      const dialog = raw.locator('dialog.inspector');
      if (root) {
        if (await dialog.isVisible()) await raw.getByRole('button', {name:'Close inspector',exact:true}).click();
        if ((id === 'filmstrip' || id === 'timeline') && await raw.getByTestId('frames-toggle').getAttribute('aria-expanded') === 'false') await raw.getByTestId('frames-toggle').click();
      } else {
        const docked = await raw.locator('.app.desktop-controls').count() > 0;
        if (docked) {
          if (await dialog.isVisible()) await raw.getByRole('button',{name:'Close inspector',exact:true}).click();
          if (desired === 'about') await raw.getByRole('button',{name:'Field notes and help',exact:true}).click();
        } else {
          if (!await dialog.isVisible()) await raw.getByTestId(desired === 'analyze' ? 'open-analysis' : 'open-view').click();
          const labels = {view:'View',analyze:'Analyze',about:'Notes'};
          const section = raw.locator('.inspector-nav').getByRole('button',{name:labels[desired],exact:true});
          if (!await section.getAttribute('aria-current')) await section.click();
        }
        if (tab) { const button = raw.locator(`#analysis-tab-${tab}`); if (await button.getAttribute('aria-selected')!=='true') await button.click(); }
      }
    });
    await navigation;
  }
  const actions = new Set(['click','dblclick','fill','check','uncheck','selectOption','focus','press','hover','scrollIntoViewIfNeeded','boundingBox','evaluate','waitFor']);
  const chains = new Set(['locator','getByRole','getByText','getByLabel','getByTestId','first','last','nth','filter']);
  function wrap(locator,id) { return new Proxy(locator,{get(target,key){const value=target[key];if(typeof value!=='function')return value;if(chains.has(key))return(...args)=>wrap(value.apply(target,args),id);if(actions.has(key))return async(...args)=>{await navigate(id);return value.apply(target,args)};return value.bind(target)}}); }
  return new Proxy(raw,{get(target,key){const value=target[key];if(typeof value!=='function')return value;
    if(key==='getByTestId')return id=>wrap(id==='find-shortcut'?target.locator('[data-testid=open-analysis], .desktop-controls #controls-analyze'):target.getByTestId(id),id);
    if(key==='locator')return(selector,...args)=>wrap(value.call(target,selector,...args),idFrom(selector));
    if(key==='getByLabel')return(...args)=>wrap(value.apply(target,args),'fov');
    if(key==='getByText')return(text,...args)=>wrap(value.call(target,text,...args),text==='Brightness and contrast'?'stretch':null);
    if(key==='getByRole')return(role,options)=>wrap(value.call(target,role,options),role==='button'&&['Reset','Use all passes'].includes(options?.name)?'fov':role==='button'&&options?.name==='Next date'?'play':null);
    if(['click','fill','check','uncheck','selectOption','hover','$','$eval'].includes(key))return async(selector,...args)=>{await navigate(idFrom(selector));return value.call(target,selector,...args)};
    return value.bind(target);
  }});
}
