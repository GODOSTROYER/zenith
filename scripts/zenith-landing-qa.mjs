/** Supplemental production lab QA. Uses a fresh Chrome context; never signs in. */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';

const BASE = process.env.ZENITH_QA_URL || 'http://127.0.0.1:3401';
const OUT = path.resolve('.data-zenith-review');
const ART = path.join(OUT, process.env.ZENITH_QA_ARTIFACTS || 'supplemental');
const REPORT = path.join(OUT,process.env.ZENITH_QA_REPORT || 'qa-results.json');
await fs.mkdir(ART, { recursive: true });
const only = process.env.ZENITH_QA_ONLY?.split(',').map(value=>value.trim()).filter(Boolean);
const previous = only && !process.env.ZENITH_QA_FRESH ? JSON.parse(await fs.readFile(REPORT,'utf8')) : null;
const report = previous || { url: BASE, startedAt: new Date().toISOString(), labOnly: true, checks: [], errors: [], notes: ['CTA identity is emulated only at /api/me; no account submissions.', 'Performance is a production browser lab observation, not field Core Web Vitals or INP.'] };
if (only) report.reruns = [...(report.reruns || []), { at:new Date().toISOString(), matching:only }];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
report.environment={browser:'Chrome',version:browser.version(),platform:process.platform,os:os.version(),release:os.release(),defaultDeviceScaleFactor:1};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signedOut = { configured: true, signedIn: false, hasWorkspace: false };
const cases = [
  ['signed-out', signedOut, 'Create account', '/signup'],
  ['new-member', { configured: true, signedIn: true, hasWorkspace: false }, 'Start with Gimbal', '/onboarding'],
  ['member', { configured: true, signedIn: true, hasWorkspace: true }, 'Open Zenith', '/overview'],
];
async function check(name, run) {
  if (only && !only.some(filter=>name.includes(filter))) return;
  if (only) report.checks = report.checks.filter(check=>check.name!==name);
  const start = Date.now();
  try { const evidence = await run(); report.checks.push({ name, passed: true, durationMs: Date.now() - start, evidence }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, durationMs: Date.now() - start, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.message}`); }
  await fs.writeFile(REPORT, JSON.stringify(report, null, 2));
}
async function fresh(options = {}) {
  const { me = signedOut, delay = 0, fail = false, noWebGL = false, video = false, ...contextOptions } = options;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference', ...contextOptions, ...(video ? { recordVideo: { dir: path.join(ART, 'video'), size: { width: 1280, height: 900 } } } : {}) });
  let meRequests = 0;
  const external = [];
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(BASE).origin) { external.push(url.origin + url.pathname); return route.abort(); }
    if (!['GET','HEAD'].includes(route.request().method())) { report.errors.push({ kind:'unexpected-mutation', message:route.request().method()+' '+url.pathname }); return route.abort(); }
    return route.continue();
  });
  await ctx.route('**/api/me', async route => {
    meRequests++;
    if (delay) await sleep(delay);
    if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Intentional QA failure' }) });
    return route.fulfill({ json: me });
  });
  if (noWebGL) await ctx.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return /^(webgl2?|experimental-webgl)$/.test(kind) ? null : getContext.call(this, kind, ...args); };
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text(), expected: noWebGL && /WebGL|context/i.test(message.text()) || fail && /503/.test(message.text()) || /401/.test(message.text()) }); });
  return { ctx, page, requests: () => meRequests, external };
}
async function open(page) { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.locator('[data-zenith-cta]').first().waitFor({ state: 'attached' }); await page.locator('.zenith-hero [data-zenith-cta]').waitFor(); await page.getByRole('button', { name: /Switch to .* theme/ }).waitFor(); }
async function hydrated(page) { await page.locator('[data-zenith-cta] [aria-busy="true"]').first().waitFor({ state: 'detached' }); await page.evaluate(() => document.fonts.ready); }
async function ctaEvidence(page, label, href) {
  const links = page.locator('[data-zenith-cta]');
  assert.ok(await links.count() >= 3, 'Expected header, hero and closing CTA');
  const result = [];
  for (const link of await links.all()) {
    assert.equal(await link.getAttribute('href'), href);
    const visibleLabels = await link.locator('span.col-start-1').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).visibility !== 'hidden').map(node => node.textContent));
    assert.deepEqual(visibleLabels, [label]);
    result.push({ href, label, width: (await link.boundingBox())?.width });
  }
  return result;
}
async function demoFlow(page) {
  const demo = page.locator('#change-demo');
  const run = demo.getByRole('button', { name: 'Run simulation', exact: true });
  assert.ok(await run.isDisabled(), 'Approval must gate execution');
  assert.equal(await demo.getByText('Running simulation', { exact: false }).count(), 0);
  await demo.getByRole('button', { name: 'Current 08', exact: true }).click();
  assert.equal(await demo.locator('[data-phase="current"]').count(), 1);
  await demo.getByRole('button', { name: 'Proposed 09', exact: true }).click();
  assert.equal(await demo.locator('[data-phase="proposed"]').count(), 1);
  await demo.getByRole('checkbox').check();
  await run.click();
  await demo.getByRole('heading', { name: 'Active revision 09 recorded.' }).waitFor();
  await demo.getByRole('button', { name: 'View revision 08', exact: true }).click();
  assert.equal(await demo.locator('[data-phase="current"]').count(), 1);
  await demo.getByRole('heading', { name: 'Viewing historical revision 08' }).waitFor();
  await demo.getByRole('button', { name: 'View revision 09', exact: true }).click();
  assert.equal(await demo.locator('[data-phase="recorded"]').count(), 1);
  await demo.getByRole('button', { name: 'Current 09', exact: true }).click();
  await demo.getByRole('button', { name: 'Restore previous demo revision' }).click();
  await demo.getByRole('heading', { name: 'Active revision 10 keeps the history.' }).waitFor();
  assert.equal(await demo.getByRole('button', { name: 'View revision 09', exact: true }).count(), 1);
  assert.equal(await demo.locator('[data-phase="restored"]').count(), 1);
  await demo.getByRole('button', { name: 'Reset demonstration' }).click();
  await demo.getByRole('button', { name: 'Current 08', exact: true }).waitFor();
  assert.ok(await run.isDisabled());
  return 'Explicit approval → revision 09 → restored configuration in revision 10 retaining 09 → reset to 08';
}
try {
  for (const [name, me, label, href] of cases) await check(`CTA ${name}`, async () => {
    const t = await fresh({ me }); try { await open(t.page); await hydrated(t.page); const links = await ctaEvidence(t.page, label, href); assert.equal(t.requests(), 1); assert.deepEqual(t.external, []); return { links, meRequests: t.requests() }; } finally { await t.ctx.close(); }
  });
  for (const fail of [false, true]) await check(`CTA ${fail ? 'failed' : 'delayed'} response width`, async () => {
    const t = await fresh({ me: cases[2][1], delay: 4500, fail }); try {
      await open(t.page); await t.page.evaluate(() => document.fonts.ready);
      const before = await t.page.locator('[data-zenith-cta]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
      await hydrated(t.page); await ctaEvidence(t.page, fail ? 'Create account' : 'Open Zenith', fail ? '/signup' : '/overview');
      const after = await t.page.locator('[data-zenith-cta]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
      assert.equal(before.length, after.length); before.forEach((width, index) => assert.ok(Math.abs(width - after[index]) <= 1, `CTA ${index} shifted ${width} → ${after[index]}`)); assert.equal(t.requests(), 1); return { before, after, requests: t.requests() };
    } finally { await t.ctx.close(); }
  });
  await check('No WebGL fallback and usable controls', async () => {
    const t = await fresh({ noWebGL: true }); try { await open(t.page); await hydrated(t.page); await t.page.locator('#meet-gimbal').scrollIntoViewIfNeeded(); await sleep(1600); assert.ok(await t.page.locator('[data-phase][data-renderer="svg"]').count() >= 2); assert.equal(await t.page.locator('.gimbal-character').getAttribute('data-renderer'), 'static'); await t.page.getByRole('button', { name: 'Say hello to Gimbal' }).click(); await t.page.getByText('Hello. I’m here.', { exact: true }).waitFor(); await t.page.getByLabel('Motion', { exact: true }).selectOption('still'); await demoFlow(t.page); await t.page.screenshot({ path: path.join(ART, 'no-webgl.png'), fullPage: true }); return { fallback: 'SVG revision scenes and static Gimbal, greeting and complete simulation usable' }; } finally { await t.ctx.close(); }
  });
  await check('Reduced motion preserves explicit workflow', async () => { const t = await fresh({ reducedMotion: 'reduce' }); try { await open(t.page); await hydrated(t.page); await sleep(800); const flow = await demoFlow(t.page); return { media: await t.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), flow }; } finally { await t.ctx.close(); } });
  for (const width of [320, 390, 768, 1440]) await check(`Responsive and UI themes ${width}`, async () => {
    const t = await fresh({ viewport: { width, height: width < 500 ? 844 : 1000 } }); try { await open(t.page); await hydrated(t.page); const evidence = [];
      for (const theme of ['light', 'dark']) {
        const current = await t.page.evaluate(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
        if (current !== theme) await t.page.getByRole('button', { name: `Switch to ${theme} theme` }).click();
        assert.equal(await t.page.evaluate(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'), theme);
        const size = await t.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert.ok(size.document <= width + 1 && size.body <= width + 1, JSON.stringify(size)); evidence.push({ theme, ...size });
        await t.page.screenshot({ path: path.join(ART, `${width}-${theme}-hero.png`) });
        if ([390,1440].includes(width)) await t.page.screenshot({ path: path.join(ART, `${width}-${theme}-full.png`), fullPage: true });
      } return evidence;
    } finally { await t.ctx.close(); }
  });
  await check('Keyboard tabs Arrow/Home/End and visible focus', async () => {
    const t = await fresh(); try { await open(t.page); await hydrated(t.page); const tabs = t.page.getByRole('tab'); await tabs.first().focus(); const evidence = [];
      for (const [key,index] of [['ArrowRight',1],['End',3],['Home',0],['ArrowLeft',3]]) { await t.page.keyboard.press(key); const tab = tabs.nth(index); assert.equal(await tab.getAttribute('aria-selected'), 'true'); assert.ok(await tab.evaluate(node => node === document.activeElement)); const focus = await tab.evaluate(node => ({ visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth })); assert.ok(focus.visible && focus.outline !== 'none' && parseFloat(focus.width) > 0, JSON.stringify(focus)); evidence.push({ key, index, focus }); }
      await t.page.screenshot({ path: path.join(ART, 'keyboard-focus.png') }); return evidence;
    } finally { await t.ctx.close(); }
  });
  await check('Actual simulation motion video', async () => {
    const t = await fresh({ video: true, viewport: { width: 1280, height: 900 } }); let video;
    try { await open(t.page); await hydrated(t.page); await t.page.locator('#change-demo').scrollIntoViewIfNeeded(); await sleep(500); await demoFlow(t.page); await sleep(600); video = t.page.video(); } finally { await t.ctx.close(); }
    return { video: await video.path(), description: 'Actual browser capture of explicit run, recording, restore and reset; normal motion.' };
  });
  for(const width of [320,390,1440]) await check(`Final scene bounds across revisions ${width}`,async()=>{
    const t=await fresh({viewport:{width,height:width<500?844:1000},reducedMotion:'reduce'});
    try{
      await open(t.page);await hydrated(t.page);const demo=t.page.locator('#change-demo');const scene=demo.locator('[data-phase]');const samples=[];
      const measure=async state=>{const box=await scene.boundingBox();assert.ok(box);const scroll=await t.page.evaluate(()=>({x:scrollX,y:scrollY}));samples.push({state,...box,x:box.x+scroll.x,y:box.y+scroll.y});};
      await demo.getByRole('button',{name:'Current 08',exact:true}).click();await measure('current08');
      await demo.getByRole('button',{name:'Proposed 09',exact:true}).click();await measure('proposed09');
      await demo.getByRole('checkbox').check();await demo.getByRole('button',{name:'Run simulation',exact:true}).click();await demo.getByRole('heading',{name:'Active revision 09 recorded.'}).waitFor();await measure('recorded09');
      await demo.getByRole('button',{name:'View revision 08',exact:true}).click();await demo.getByRole('heading',{name:'Viewing historical revision 08'}).waitFor();await measure('historical08');
      await demo.getByRole('button',{name:'View revision 09',exact:true}).click();await measure('historical09');
      await demo.getByRole('button',{name:'Current 09',exact:true}).click();await demo.getByRole('button',{name:'Restore previous demo revision'}).click();await demo.getByRole('heading',{name:'Active revision 10 keeps the history.'}).waitFor();await measure('restored10');
      for(const box of samples) for(const key of ['x','y','width','height']) assert.ok(Math.abs(box[key]-samples[0][key])<=1,`${box.state} document ${key} changed ${samples[0][key]}→${box[key]}`);
      assert.ok(Math.abs(samples[0].height-(width<560?280:400))<=1,'Scene has the intended fixed height');
      await t.page.screenshot({path:path.join(ART,`${width}-restored-scene.png`)});return{viewport:{width,height:width<500?844:1000},deviceScaleFactor:1,samples};
    }finally{await t.ctx.close();}
  });
  await check('Final no-WebGL opening screenshot',async()=>{const t=await fresh({noWebGL:true,viewport:{width:390,height:844}});try{await open(t.page);await hydrated(t.page);assert.equal(await t.page.locator('.zenith-hero [data-renderer="svg"]').count(),1);await t.page.screenshot({path:path.join(ART,'390-no-webgl-opening.png')});return{viewport:{width:390,height:844},deviceScaleFactor:1,renderer:'SVG'};}finally{await t.ctx.close();}});
  for (const mobile of [false,true]) await check(`Performance lab ${mobile ? 'mobile-throttled' : 'desktop-cold'}`, async () => {
    const t = await fresh({ viewport: mobile ? { width:390,height:844 } : { width:1440,height:1000 } });
    try {
      await t.page.addInitScript(() => { window.__zenithPerf = { lcp: [], shifts: [], longTasks: [] }; for (const [type,key] of [['largest-contentful-paint','lcp'],['layout-shift','shifts'],['longtask','longTasks']]) try { new PerformanceObserver(list => window.__zenithPerf[key].push(...list.getEntries().map(e => ({ startTime:e.startTime,duration:e.duration,value:e.value,hadRecentInput:e.hadRecentInput,size:e.size,element:e.element?{tag:e.element.tagName,id:e.element.id,className:e.element.className,text:e.element.textContent?.slice(0,160)}:undefined,sources:e.sources?.map(s=>({node:s.node ? `${(s.node.nodeType===3?s.node.parentElement:s.node)?.tagName}#${(s.node.nodeType===3?s.node.parentElement:s.node)?.id}.${(s.node.nodeType===3?s.node.parentElement:s.node)?.className??''}` : null,previousRect:s.previousRect?.toJSON(),currentRect:s.currentRect?.toJSON()})) })))) .observe({type,buffered:true}); } catch {} });
      const cdp = await t.ctx.newCDPSession(t.page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
      if(mobile) { await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:1600000/8,uploadThroughput:750000/8}); await cdp.send('Emulation.setCPUThrottlingRate',{rate:4}); }
      await open(t.page); await hydrated(t.page); await sleep(mobile ? 10000 : 4000);
      const data = await t.page.evaluate(() => ({...window.__zenithPerf,navigation:performance.getEntriesByType('navigation')[0]?.toJSON(),resources:performance.getEntriesByType('resource').map(e => ({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,duration:e.duration}))}));
      const shifts = data.shifts.filter(e=>!e.hadRecentInput); let windowStart=0, previousShift=0, windowValue=0; data.cls=0;
      for(const shift of shifts) { if(shift.startTime-previousShift>1000 || shift.startTime-windowStart>5000) { windowStart=shift.startTime; windowValue=0; } windowValue+=shift.value; previousShift=shift.startTime; data.cls=Math.max(data.cls,windowValue); }
      data.totalLayoutShift = shifts.reduce((sum,e)=>sum+e.value,0); data.lcpMs = data.lcp.at(-1)?.startTime ?? null; data.maxLongTaskMs=Math.max(0,...data.longTasks.map(task=>task.duration));data.totalTransferBytes = data.resources.reduce((sum,e)=>sum+e.transferSize,0);data.viewport=mobile?{width:390,height:844}:{width:1440,height:1000};data.deviceScaleFactor=1; data.conditions = mobile ? '150 ms latency, 1.6 Mbps down, 0.75 Mbps up, 4× CPU' : 'Cold browser cache; no network or CPU throttling'; assert.ok(data.lcpMs !== null); return data;
    } finally { await t.ctx.close(); }
  });
  for(const width of [320,390]) await check(`Essential content with delayed fonts and renderer module ${width}`, async () => {
    const t = await fresh({viewport:{width,height:844}}); try {
      // Identify bootstrap chunks from real HTML; delay dynamically requested renderer chunks.
      const html = await (await t.ctx.request.get(BASE)).text();
      const initialScripts = new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => new URL(match[1], BASE).pathname));
      const delayed = [];
      await t.ctx.route('**/fonts/**', async route => { delayed.push(route.request().url()); await sleep(6500); await route.continue(); });
      await t.ctx.route('**/_next/static/**/*.js', async route => { if (!initialScripts.has(new URL(route.request().url()).pathname)) { delayed.push(route.request().url()); await sleep(6500); } await route.continue(); });
      await t.page.goto(BASE,{waitUntil:'commit'}); await t.page.locator('#zenith-title').waitFor();
      const initial = await t.page.evaluate(() => {const range=document.createRange();range.selectNodeContents(document.querySelector('h1 em'));return{ headline:document.querySelector('h1')?.textContent, cta:document.querySelector('[data-zenith-cta]')?.getAttribute('href'), fallback:!!document.querySelector('[data-phase][data-renderer="svg"] svg'), fontStatus:document.fonts.status,viewport:innerWidth,headingBounds:document.querySelector('h1').getBoundingClientRect().toJSON(),italicBounds:range.getBoundingClientRect().toJSON() };});
      assert.ok(initial.headline?.includes('See the change.')); assert.equal(initial.cta,'/signup'); assert.ok(initial.fallback); assert.equal(initial.fontStatus,'loading');
      assert.ok(initial.headingBounds.right<=width && initial.italicBounds.right<=width,'Fallback headline stays within the viewport');
      await t.page.waitForFunction(() => document.querySelector('[data-zenith-cta] [aria-busy="true"]') === null);
      assert.equal(await t.page.locator('.zenith-hero [data-renderer="svg"]').count(),1);
      await t.page.screenshot({path:path.join(ART,`${width}-delayed-fonts-first-content.png`),timeout:15000});
      // Font readiness now deliberately precedes renderer import by two frames.
      for(let attempt=0;attempt<100&&!delayed.some(url=>url.includes('/_next/'));attempt++) await sleep(50);
      assert.ok(delayed.some(url=>url.includes('/_next/')), 'Renderer chunk was intentionally delayed');
      return { initial, delayed, note:'First-content assertion precedes font completion; screenshot may wait for fonts. Dynamic renderer chunks and fonts were deliberately delayed 6.5 seconds.' };
    } finally { await t.ctx.close(); }
  });
} finally {
  await browser.close(); report.finishedAt = new Date().toISOString(); report.unexpectedErrors = report.errors.filter(error=>!error.expected); report.passed = report.checks.every(check => check.passed) && report.unexpectedErrors.length === 0; await fs.writeFile(REPORT,JSON.stringify(report,null,2)); console.log(JSON.stringify({checks:report.checks.length,failed:report.checks.filter(check=>!check.passed).map(check=>check.name),unexpectedErrors:report.unexpectedErrors.length})); if(!report.passed) process.exitCode=1;
}
