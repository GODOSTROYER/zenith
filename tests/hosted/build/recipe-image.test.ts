/**
 * The image builds are the last place a package is installed at all, so they
 * are the last place a supply-chain control can be dropped without anyone
 * noticing. Nothing here runs Docker — these are assertions over the committed
 * build inputs, which is exactly the part that can be checked on every machine.
 *
 * What is deliberately NOT claimed: that either image builds. `docker build`
 * evidence is recorded separately; see `docs/hosted/PROVIDERS.md`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RECIPE_V1 } from "@/lib/hosted/contracts";

const ROOT = process.cwd();
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const recipePackage = JSON.parse(read("docker", "recipe", "package.json")) as {
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const recipeLock = JSON.parse(read("docker", "recipe", "package-lock.json")) as {
  lockfileVersion: number;
  packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};
const recipeDockerfile = read("docker", "recipe", "Dockerfile");
const appDockerfile = read("Dockerfile");

/** Every `RUN`/`COPY` line, with continuations folded into one logical line. */
function instructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

const installLines = (dockerfile: string): string[] =>
  instructions(dockerfile).filter((line) => /\bnpm\s+(ci|install)\b/.test(line));

describe("the recipe toolchain is pinned in one place", () => {
  it("declares exactly the recipe packages at the RECIPE_V1 versions", () => {
    expect(recipePackage.dependencies).toEqual({
      vite: RECIPE_V1.vite,
      "@vitejs/plugin-react": RECIPE_V1.pluginReact,
      react: RECIPE_V1.react,
      "react-dom": RECIPE_V1.react,
    });
    // A devDependency would be installed by `npm ci` and shipped in the image.
    expect(recipePackage.devDependencies ?? {}).toEqual({});
  });

  it("has a lockfile that resolves those exact versions", () => {
    expect(recipeLock.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(recipeLock.packages[""]?.dependencies).toEqual(recipePackage.dependencies);
    expect(recipeLock.packages["node_modules/vite"]?.version).toBe(RECIPE_V1.vite);
    expect(recipeLock.packages["node_modules/@vitejs/plugin-react"]?.version).toBe(RECIPE_V1.pluginReact);
    expect(recipeLock.packages["node_modules/react"]?.version).toBe(RECIPE_V1.react);
    expect(recipeLock.packages["node_modules/react-dom"]?.version).toBe(RECIPE_V1.react);
  });

  it("locks the transitive tree, not just the four direct packages", () => {
    // The point of the lockfile is the tree below the four names; a lockfile
    // holding only them would pin nothing that matters.
    expect(Object.keys(recipeLock.packages).length).toBeGreaterThan(20);
  });
});

describe("every image install is frozen and script-free", () => {
  it("the recipe image installs with npm ci --ignore-scripts and never npm install", () => {
    const lines = installLines(recipeDockerfile);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("npm ci");
    expect(lines[0]).toContain("--ignore-scripts");
    expect(lines[0]).not.toContain("npm install");
  });

  it("the recipe image copies the lockfile before installing", () => {
    const copy = instructions(recipeDockerfile).find((line) => line.startsWith("COPY") && line.includes("package-lock.json"));
    expect(copy, "the lockfile must be in the build context, or `npm ci` cannot be frozen").toBeTruthy();
    expect(copy).toContain("docker/recipe/package.json");
  });

  it("the app image installs its own dependencies with --ignore-scripts", () => {
    const lines = installLines(appDockerfile);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `install line without --ignore-scripts: ${line}`).toContain("--ignore-scripts");
      expect(line, `install line that is not frozen: ${line}`).toContain("npm ci");
    }
  });

  it("the app image's opt-in recipe-local toolchain installs from the committed recipe lockfile", () => {
    const toolchain = installLines(appDockerfile).find((line) => line.includes("ZENITH_RECIPE_LOCAL"));
    expect(toolchain, "the ZENITH_RECIPE_LOCAL install must stay a single guarded line").toBeTruthy();
    expect(toolchain).toContain("npm ci");
    expect(toolchain).toContain("--ignore-scripts");
    // Versions must come from the lockfile, never be retyped into the Dockerfile.
    expect(toolchain).not.toContain(`vite@${RECIPE_V1.vite}`);
    expect(appDockerfile).toContain("docker/recipe/package-lock.json");
  });
});
