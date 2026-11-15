import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const root = css.match(/:root\s*\{([\s\S]*?)\}/)![1];
const light = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\}/)![1];
const amoled = css.match(/\[data-theme="amoled"\]\s*\{([\s\S]*?)\}/)![1];
const themes = { dark: "", light, amoled };
type Theme = keyof typeof themes;
const colors = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
it.each(Object.keys(themes) as Theme[])("keeps %s body, metadata and action labels readable", (theme) => {
  const tokens = { ...colors(root), ...colors(themes[theme]) };
  for (const foreground of ["ink", "ink-mute", "ink-faint", "signal", "ok", "warn", "err", "info", "prod", "nav-accent"])
    for (const background of ["bg0", "bg1", "bg2", "bg3"])
      expect(contrast(tokens[foreground], tokens[background]), `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
  for (const background of ["signal", "signal-strong"])
    expect(contrast(tokens["on-signal"], tokens[background])).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens["on-danger"], tokens.err)).toBeGreaterThanOrEqual(4.5);
});

function composite(color: string, background: string) {
  if (color.startsWith("#")) return color;
  const [r, g, b, alpha] = color.match(/[\d.]+/g)!.map(Number);
  const base = background.slice(1).match(/../g)!.map((part) => parseInt(part, 16));
  return "#" + [r, g, b].map((channel, i) => Math.round(channel * alpha + base[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

it.each(Object.keys(themes) as Theme[])("keeps %s status chips and selected labels readable on tinted surfaces", (theme) => {
  const block = root + themes[theme];
  const values = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
  for (const [foreground, tint] of [["signal", "signal-dim"], ["ok", "ok-dim"], ["warn", "warn-dim"], ["err", "err-dim"], ["info", "info-dim"], ["nav-accent", "nav-dim"], ["prod", "warn-dim"]]) {
    for (const surface of ["bg0", "bg1", "bg2", "bg3"]) {
      expect(contrast(values[foreground], composite(values[tint], values[surface])), `${theme}: ${foreground} on ${tint}/${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

it("distinguishes AMOLED controls, essential diagram lines and keyboard focus from every surface", () => {
  const tokens = { ...colors(root), ...colors(amoled) };
  expect(tokens.bg0).toBe("#000000");
  expect(new Set([tokens.bg0, tokens.bg1, tokens.bg2, tokens.bg3]).size).toBe(4);
  for (const foreground of ["control-line", "line-strong", "signal", "nav-accent"])
    for (const background of ["bg0", "bg1", "bg2", "bg3"])
      expect(contrast(tokens[foreground], tokens[background]), `${foreground} against ${background}`).toBeGreaterThanOrEqual(3);
});

it("keeps AMOLED brand and status accents identical to Dark", () => {
  const overrides = colors(amoled);
  for (const token of ["signal", "signal-strong", "nav-accent", "ok", "warn", "err", "info", "prod"])
    expect(overrides[token], `${token} inherits Dark`).toBeUndefined();
});
