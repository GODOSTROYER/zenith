/** Rebuild the original vector identity from the shared master geometry. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZENITH_SYMBOL_PATHS, ZENITH_LETTER_PATHS } from "../src/components/shell/brand-geometry";

const output = path.join(process.cwd(), "public/brand");
const paths = (values: readonly string[]) => values.map((d) => `<path d="${d}" fill-rule="evenodd"/>`).join("");
const svg = (viewBox: string, content: string, color = "#20211f") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}" role="img" aria-label="Zenith">${content}</svg>\n`;
async function build() {
  await mkdir(output, { recursive: true });
  const mark = paths(ZENITH_SYMBOL_PATHS);
  const letters = paths(ZENITH_LETTER_PATHS);
  const lockup = `<g transform="translate(0 3) scale(1.875)">${mark}</g><g transform="translate(82 0)">${letters}</g>`;
  const assets = {
    "zenith-symbol.svg": svg("0 0 32 32", mark),
    "zenith-symbol-inverse.svg": svg("0 0 32 32", mark, "#f4f3ee"),
    "zenith-symbol-vermilion.svg": svg("0 0 32 32", mark, "#cc3d25"),
    "zenith-wordmark.svg": svg("0 0 256 66", letters),
    "zenith-lockup.svg": svg("0 0 338 66", lockup),
    "zenith-lockup-inverse.svg": svg("0 0 338 66", lockup, "#f4f3ee"),
    "zenith-symbol-16.svg": svg("0 0 16 16", '<path d="M1 2H15L11 6H1ZM10 7H15L8 14H1L5 10H7Z"/>'),
    "zenith-symbol-24.svg": svg("0 0 24 24", `<g transform="scale(.75)">${mark}</g>`),
    "zenith-symbol-32.svg": svg("0 0 32 32", mark),
  };
  await Promise.all(Object.entries(assets).map(([name, content]) => writeFile(path.join(output, name), content)));
  console.log(`Wrote ${Object.keys(assets).length} original Zenith vector assets.`);
}
void build();
