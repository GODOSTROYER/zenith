/** Supplemental production lab QA for the landing. Uses a fresh Chrome context; never signs in. */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';

const BASE = process.env.ZENITH_QA_URL || 'http://127.0.0.1:3401';
const OUT = path.resolve('.data-zenith-review');
const ART = path.join(OUT, process.env.ZENITH_QA_ARTIFACTS || 'supplemental');
const REPORT = path.join(OUT, process.env.ZENITH_QA_REPORT || 'qa-results.json');
await fs.mkdir(ART, { recursive: true });
const only = process.env.ZENITH_QA_ONLY?.split(',').map(value => value.trim()).filter(Boolean);
const previous = only && !process.env.ZENITH_QA_FRESH ? JSON.parse(await fs.readFile(REPORT, 'utf8')) : null;
const report = previous || { url: BASE, startedAt: new Date().toISOString(), labOnly: true, checks: [], errors: [], notes: ['CTA identity is emulated only at /api/me; no account submissions.', 'Performance is a production browser lab observation, not field Core Web Vitals or INP.', 'Gimbal answers are a curated guide; no model is called.'] };
if (only) report.reruns = [...(report.reruns || []), { at: new Date().toISOString(), matching: only }];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
report.environment = { browser: 'Chrome', version: browser.version(), platform: process.platform, os: os.version(), release: os.release(), defaultDeviceScaleFactor: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signedOut = { configured: true, signedIn: false, hasWorkspace: false };
const cases = [
  ['signed-out', signedOut, 'Create account', '/signup'],
  ['new-member', { configured: true, signedIn: true, hasWorkspace: false }, 'Start with Gimbal', '/onboarding'],
  ['member', { configured: true, signedIn: true, hasWorkspace: true }, 'Open Zenith', '/overview'],
];
async function check(name, run) {
  if (only && !only.some(filter => name.includes(filter))) return;
  if (only) report.checks = report.checks.filter(check => check.name !== name);
  const start = Date.now();
  try { const evidence = await run(); report.checks.push({ name, passed: true, durationMs: Date.now() - start, evidence }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, durationMs: Date.now() - start, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.message}`); }
  await fs.writeFile(REPORT, JSON.stringify(report, null, 2));
}
async function fresh(options = {}) {
  const { me = signedOut, delay = 0, fail = false, noWebGL = false, ...contextOptions } = options;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference', ...contextOptions });
  let meRequests = 0;
  const external = [];
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(BASE).origin) { external.push(url.origin + url.pathname); return route.abort(); }
    if (!['GET', 'HEAD'].includes(route.request().method())) { report.errors.push({ kind: 'unexpected-mutation', message: route.request().method() + ' ' + url.pathname, expected: url.pathname.startsWith('/__nextjs') }); return route.abort(); }
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
  // A development server adds its own indicator in a corner; hide it so it never intercepts a click meant for Gimbal.
  await ctx.addInitScript(() => { const style = document.createElement('style'); style.textContent = 'nextjs-portal{display:none!important}'; document.addEventListener('DOMContentLoaded', () => document.head.append(style)); });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text(), expected: noWebGL && /WebGL|context/i.test(message.text()) || fail && /503/.test(message.text()) || /401/.test(message.text()) || /ERR_FAILED/.test(message.text()) }); });
  return { ctx, page, requests: () => meRequests, external };
}
/** Gimbal stays out of the opening; scroll past it before asking anything of the character. */
async function revealGimbal(page) {
  await page.evaluate(() => document.querySelector('#before')?.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.locator('[data-mood]:not([data-hidden])').waitFor();
  await page.waitForTimeout(700);
}
async function open(page) { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.locator('[data-zenith-cta]').first().waitFor({ state: 'attached' }); await page.locator('[data-zenith-cta]:visible').first().waitFor(); await page.locator('#zenith-title').waitFor(); }
async function hydrated(page, timeout = 15000) { await page.locator('[data-zenith-cta] [aria-busy="true"]').first().waitFor({ state: 'detached', timeout }); await page.evaluate(() => document.fonts.ready); }
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
/** The plan chapter: switch views, inspect a part, read the product plan. Nothing may run. */
async function planFlow(page) {
  const before = page.locator('#before');
  await before.scrollIntoViewIfNeeded();
  await before.getByRole('button', { name: 'Current system', exact: true }).click();
  await before.getByText('parts running today').waitFor();
  assert.equal(await before.locator('[data-node="process-jobs"]').count(), 0);
  await before.getByRole('button', { name: 'Proposed change', exact: true }).click();
  assert.equal(await before.locator('[data-node="process-jobs"]').count(), 1);
  await before.getByText('What the plan says, item by item').click();
  await before.getByText('Provisions a message queue', { exact: false }).waitFor();
  await before.locator('button[data-node="results"]').click();
  await before.getByText('Results database · Stores what each job produced.').waitFor();
  // The estimate counts up over 0.7 s; wait for it to settle.
  await before.getByText('$30.00', { exact: true }).waitFor();
  await before.getByText('+$8.00', { exact: false }).first().waitFor();
  assert.equal(await page.locator('pre, code').count(), 0, 'No source code on the page');
  return 'Current → proposed → inspect results → plan and estimate read; nothing executed';
}
/** Gimbal: open, answer a chip, type a question, close with Escape, focus restored. */
async function gimbalFlow(page) {
  await revealGimbal(page);
  const launcher = page.getByRole('button', { name: 'Ask Gimbal', exact: true });
  await launcher.click({ force: true });
  const dialog = page.getByRole('dialog', { name: 'Ask Gimbal' });
  await dialog.waitFor();
  await dialog.getByText('Answers from the Zenith team').waitFor();
  // Suggested questions follow the chapter in view; answer whichever comes first.
  const context = await dialog.locator('[class*="_context__"]').textContent();
  const chip = dialog.locator('[class*="chips"] button').first();
  const chipLabel = (await chip.textContent())?.trim();
  await chip.click();
  await dialog.locator('[class*="question"]', { hasText: chipLabel }).first().waitFor();
  await dialog.getByLabel('Ask Gimbal a question').fill('can I export my infrastructure');
  await dialog.getByRole('button', { name: 'Send question' }).click();
  await dialog.getByText('operations guide', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Ask Gimbal'), 'Focus returns to the character');
  return { context, chip: chipLabel, note: 'Panel opened, curated chip and typed question answered, Escape closed and restored focus' };
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
    const t = await fresh({ noWebGL: true }); try { await open(t.page); await hydrated(t.page); await sleep(1600); await revealGimbal(t.page); assert.equal(await t.page.locator('.gimbal-character').getAttribute('data-renderer'), 'static'); assert.ok(await t.page.locator('.gimbal-character .gimbal-static').isVisible()); await gimbalFlow(t.page); await planFlow(t.page); await t.page.screenshot({ path: path.join(ART, 'no-webgl.png'), fullPage: true }); return { fallback: 'Static Gimbal, question panel and plan chapter usable without WebGL' }; } finally { await t.ctx.close(); }
  });
  await check('Reduced motion preserves the explicit workflow', async () => { const t = await fresh({ reducedMotion: 'reduce' }); try { await open(t.page); await hydrated(t.page); await sleep(800); const flow = await planFlow(t.page); const walkthrough = await t.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches); return { media: walkthrough, flow }; } finally { await t.ctx.close(); } });
  for (const width of [320, 390, 768, 1440]) await check(`Responsive and UI themes ${width}`, async () => {
    const t = await fresh({ viewport: { width, height: width < 500 ? 844 : 1000 } }); try { await open(t.page); await hydrated(t.page); const evidence = [];
      for (const theme of ['composed']) {
        const size = await t.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert.ok(size.document <= width + 1 && size.body <= width + 1, JSON.stringify(size)); evidence.push({ theme, ...size });
        // The opening's entrance takes about two seconds; reveals below play as the page scrolls into view.
        await sleep(2600);
        await t.page.screenshot({ path: path.join(ART, `${width}-hero.png`) });
        if ([390, 1440].includes(width)) {
          await t.page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.5) { window.scrollTo(0, y); await new Promise((resolve) => setTimeout(resolve, 140)); } });
          await sleep(1200);
          await t.page.evaluate(() => window.scrollTo(0, 0)); await sleep(900);
          await t.page.screenshot({ path: path.join(ART, `${width}-full.png`), fullPage: true });
        }
      }
      // Gimbal keeps out of the opening; once shown, it must not cover the primary CTA or the navigation.
      const hiddenOnOpening = await t.page.locator('[data-mood][data-hidden]').count();
      assert.equal(hiddenOnOpening, 1, 'Gimbal is hidden while the opening is on screen');
      await revealGimbal(t.page);
      const overlap = await t.page.evaluate(() => {
        const gimbal = document.querySelector('.gimbal-character')?.getBoundingClientRect(); if (!gimbal) return null;
        const hits = (selector) => [...document.querySelectorAll(selector)].filter(node => { const r = node.getBoundingClientRect(); return r.width > 0 && !(r.right < gimbal.left || r.left > gimbal.right || r.bottom < gimbal.top || r.top > gimbal.bottom); }).map(node => node.textContent?.trim().slice(0, 40));
        return { cta: hits('[data-zenith-cta]'), nav: hits('.zenith-header a, .zenith-header button') };
      });
      assert.deepEqual(overlap, { cta: [], nav: [] }, 'Gimbal overlaps a primary control once shown');
      return { evidence, overlap, hiddenOnOpening: true };
    } finally { await t.ctx.close(); }
  });
  await check('Keyboard: autonomy explorer and Gimbal dialog', async () => {
    const t = await fresh(); try { await open(t.page); await hydrated(t.page);
      const levels = t.page.locator('#gimbal [aria-label="Explore the five autonomy levels"] button');
      await levels.first().focus(); const evidence = [];
      for (let index = 0; index < 5; index++) {
        if (index) await t.page.keyboard.press('Tab');
        await t.page.keyboard.press('Space');
        const level = levels.nth(index);
        assert.equal(await level.getAttribute('aria-pressed'), 'true');
        const focus = await level.evaluate(node => ({ visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth }));
        assert.ok(focus.visible && focus.outline !== 'none' && parseFloat(focus.width) > 0, JSON.stringify(focus)); evidence.push({ index, focus });
      }
      await t.page.screenshot({ path: path.join(ART, 'keyboard-focus.png') });
      const flow = await gimbalFlow(t.page);
      return { evidence, flow };
    } finally { await t.ctx.close(); }
  });
  await check('Walkthrough is presentation only and restores the selection', async () => {
    const t = await fresh(); try { await open(t.page); await hydrated(t.page);
      const before = t.page.locator('#before'); await before.scrollIntoViewIfNeeded();
      await before.locator('button[data-node="results"]').click();
      await revealGimbal(t.page);
      await t.page.getByRole('button', { name: 'Ask Gimbal', exact: true }).click({ force: true });
      const dialog = t.page.getByRole('dialog', { name: 'Ask Gimbal' });
      await dialog.getByLabel('Ask Gimbal a question').fill('what happens before deployment');
      await dialog.getByRole('button', { name: 'Send question' }).click();
      await dialog.getByRole('button', { name: /Read the plan with me/ }).click();
      const callout = t.page.getByRole('dialog', { name: /Walkthrough/ });
      await callout.waitFor();
      assert.equal(await before.locator('[data-node="process-jobs"]').getAttribute('data-hot'), 'true');
      assert.equal(await before.locator('[data-node="results"]').getAttribute('data-soft'), 'true');
      await callout.getByRole('button', { name: 'Next' }).click();
      await callout.getByRole('button', { name: 'Next' }).click();
      await callout.getByRole('button', { name: 'Done' }).click();
      await callout.waitFor({ state: 'detached' });
      assert.equal(await before.locator('[data-node="results"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await before.locator('[data-node="results"]').getAttribute('data-soft'), null);
      await t.page.screenshot({ path: path.join(ART, 'walkthrough-restored.png') });
      return 'Walkthrough emphasised the plan, then restored the visitor’s selection';
    } finally { await t.ctx.close(); }
  });
  await check('Contextual suggestion after settled reading, dismissed for the session', async () => {
    const t = await fresh(); try { await open(t.page); await hydrated(t.page);
      await t.page.locator('#before').scrollIntoViewIfNeeded(); await sleep(400);
      const bubble = t.page.getByRole('status').filter({ hasText: 'why this system uses a queue' });
      await bubble.waitFor({ timeout: 20000 });
      const elapsed = Date.now();
      await bubble.getByRole('button', { name: 'Not now' }).click();
      await bubble.waitFor({ state: 'detached' });
      await t.page.locator('#hero, [data-chapter="hero"]').first().scrollIntoViewIfNeeded(); await sleep(300);
      await t.page.locator('#before').scrollIntoViewIfNeeded(); await sleep(15000);
      assert.equal(await bubble.count(), 0, 'A dismissed suggestion stays dismissed');
      return { dismissedAt: new Date(elapsed).toISOString() };
    } finally { await t.ctx.close(); }
  });
  await check('Mobile Gimbal sheet and virtual keyboard clearance', async () => {
    const t = await fresh({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); try { await open(t.page); await hydrated(t.page);
      await revealGimbal(t.page);
      await t.page.getByRole('button', { name: 'Ask Gimbal', exact: true }).click({ force: true });
      const dialog = t.page.getByRole('dialog', { name: 'Ask Gimbal' }); await dialog.waitFor();
      const box = await dialog.boundingBox(); assert.ok(box.width >= 388 && box.x <= 1, 'Panel spans the viewport as a sheet');
      assert.ok(box.height <= 844 * 0.8, 'Sheet leaves the page visible above it');
      await t.page.screenshot({ path: path.join(ART, '390-gimbal-sheet.png') });
      await t.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      return { sheet: box };
    } finally { await t.ctx.close(); }
  });
  await check('Final no-WebGL opening screenshot', async () => { const t = await fresh({ noWebGL: true, viewport: { width: 390, height: 844 } }); try { await open(t.page); await hydrated(t.page); await sleep(1200); await revealGimbal(t.page); assert.equal(await t.page.locator('.gimbal-character').getAttribute('data-renderer'), 'static'); await t.page.screenshot({ path: path.join(ART, '390-no-webgl-opening.png') }); return { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, renderer: 'SVG' }; } finally { await t.ctx.close(); } });
  for (const mobile of [false, true]) await check(`Performance lab ${mobile ? 'mobile-throttled' : 'desktop-cold'}`, async () => {
    const t = await fresh({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    try {
      await t.page.addInitScript(() => { window.__zenithPerf = { lcp: [], shifts: [], longTasks: [] }; for (const [type, key] of [['largest-contentful-paint', 'lcp'], ['layout-shift', 'shifts'], ['longtask', 'longTasks']]) try { new PerformanceObserver(list => window.__zenithPerf[key].push(...list.getEntries().map(e => ({ startTime: e.startTime, duration: e.duration, value: e.value, hadRecentInput: e.hadRecentInput, size: e.size, element: e.element ? { tag: e.element.tagName, id: e.element.id, className: e.element.className, text: e.element.textContent?.slice(0, 160) } : undefined })))).observe({ type, buffered: true }); } catch {} });
      const cdp = await t.ctx.newCDPSession(t.page); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (mobile) { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1600000 / 8, uploadThroughput: 750000 / 8 }); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
      await open(t.page); await hydrated(t.page, mobile ? 60000 : 15000); await sleep(mobile ? 10000 : 4000);
      const data = await t.page.evaluate(() => ({ ...window.__zenithPerf, navigation: performance.getEntriesByType('navigation')[0]?.toJSON(), resources: performance.getEntriesByType('resource').map(e => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, duration: e.duration })) }));
      const shifts = data.shifts.filter(e => !e.hadRecentInput); let windowStart = 0, previousShift = 0, windowValue = 0; data.cls = 0;
      for (const shift of shifts) { if (shift.startTime - previousShift > 1000 || shift.startTime - windowStart > 5000) { windowStart = shift.startTime; windowValue = 0; } windowValue += shift.value; previousShift = shift.startTime; data.cls = Math.max(data.cls, windowValue); }
      data.totalLayoutShift = shifts.reduce((sum, e) => sum + e.value, 0); data.lcpMs = data.lcp.at(-1)?.startTime ?? null; data.maxLongTaskMs = Math.max(0, ...data.longTasks.map(task => task.duration)); data.totalTransferBytes = data.resources.reduce((sum, e) => sum + e.transferSize, 0); data.viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }; data.deviceScaleFactor = 1; data.conditions = mobile ? '150 ms latency, 1.6 Mbps down, 0.75 Mbps up, 4× CPU' : 'Cold browser cache; no network or CPU throttling'; assert.ok(data.lcpMs !== null); return data;
    } finally { await t.ctx.close(); }
  });
  for (const width of [320, 390]) await check(`Essential content with delayed fonts and renderer module ${width}`, async () => {
    const t = await fresh({ viewport: { width, height: 844 } }); try {
      const html = await (await t.ctx.request.get(BASE)).text();
      const initialScripts = new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => new URL(match[1], BASE).pathname));
      const delayed = [];
      await t.ctx.route('**/fonts/**', async route => { delayed.push(route.request().url()); await sleep(6500); await route.continue(); });
      await t.ctx.route('**/_next/static/**/*.js', async route => { if (!initialScripts.has(new URL(route.request().url()).pathname)) { delayed.push(route.request().url()); await sleep(6500); } await route.continue(); });
      await t.page.goto(BASE, { waitUntil: 'commit' }); await t.page.locator('#zenith-title').waitFor();
      const initial = await t.page.evaluate(() => ({ headline: document.querySelector('h1')?.textContent, cta: document.querySelector('[data-zenith-cta]')?.getAttribute('href'), nodes: document.querySelectorAll('#before [data-node]').length, fontStatus: document.fonts.status, viewport: innerWidth, headingBounds: document.querySelector('h1').getBoundingClientRect().toJSON() }));
      assert.ok(initial.headline?.includes('Zenith')); assert.equal(initial.cta, '/signup'); assert.equal(initial.nodes, 6); assert.equal(initial.fontStatus, 'loading');
      assert.ok(initial.headingBounds.right <= width + 1, 'The wordmark stays within the viewport');
      await t.page.waitForFunction(() => document.querySelector('[data-zenith-cta] [aria-busy="true"]') === null);
      await t.page.screenshot({ path: path.join(ART, `${width}-delayed-fonts-first-content.png`), timeout: 15000 });
      for (let attempt = 0; attempt < 100 && !delayed.some(url => url.includes('/_next/')); attempt++) await sleep(50);
      return { initial, delayed, note: 'Headline, CTA and the six example parts are readable before fonts and the deferred chunks arrive.' };
    } finally { await t.ctx.close(); }
  });
} finally {
  await browser.close(); report.finishedAt = new Date().toISOString(); report.unexpectedErrors = report.errors.filter(error => !error.expected); report.passed = report.checks.every(check => check.passed) && report.unexpectedErrors.length === 0; await fs.writeFile(REPORT, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ checks: report.checks.length, failed: report.checks.filter(check => !check.passed).map(check => check.name), unexpectedErrors: report.unexpectedErrors.length })); if (!report.passed) process.exitCode = 1;
}
