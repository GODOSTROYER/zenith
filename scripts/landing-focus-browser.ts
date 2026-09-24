import assert from "node:assert/strict";
import type { Browser } from "playwright-core";

/** Verify focus interruption with native WAAPI, not mocked Animation callbacks. */
export async function verifyLandingFocus(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const original = Element.prototype.animate;
      const owned: Animation[] = [];
      Element.prototype.animate = function (keyframes, options) {
        const animation = original.call(this, keyframes, options);
        const card = this.closest<HTMLElement>("[data-bento]");
        if (card?.id === "before" && options && typeof options === "object" && options.fill === "backwards") {
          owned.push(animation);
          if (owned.length === 3) queueMicrotask(() => {
            Element.prototype.animate = original;
            const control = card.querySelector<HTMLButtonElement>('[data-micro-group="view"] button');
            const before = owned.map((item) => item.playState);
            control?.focus({ preventScroll: true });
            document.documentElement.dataset.landingFocusResult = JSON.stringify({
              before,
              after: owned.map((item) => item.playState),
              focused: document.activeElement === control,
              count: owned.length,
            });
          });
        }
        return animation;
      };
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.locator(".zenith-header .zenith-home").click({ trial: true });
    await page.locator("#before").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !!document.documentElement.dataset.landingFocusResult, undefined, { timeout: 15000 });
    const result = await page.evaluate(() => JSON.parse(document.documentElement.dataset.landingFocusResult!) as {
      before: string[]; after: string[]; focused: boolean; count: number;
    });
    assert.equal(result.count, 3, "Observe the real surface, heading and artwork reveals");
    assert.deepEqual(result.before, ["running", "running", "running"], "Focus must interrupt active, not already-finished animations");
    assert.deepEqual(result.after, ["idle", "idle", "idle"], "Native focus must synchronously settle all three owned reveals");
    assert.equal(result.focused, true, "The native control keeps focus");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-bento]")?.id), "before", "Keyboard navigation continues to the next map control");
    return result;
  } finally {
    await context.close();
  }
}
