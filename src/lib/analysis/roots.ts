/**
 * Project-root discovery. A "root" is a directory that carries a build or run
 * marker (package.json, go.mod, Dockerfile, Procfile …). Every file belongs to
 * its deepest enclosing root; the repository root "" always exists so loose
 * files have an owner. Monorepos fall out naturally: several roots, several
 * candidate services.
 */
import type { Root } from "./model";
import { basename, dirname } from "./text";

const MARKERS = new Set([
  "package.json",
  "pyproject.toml",
  "pipfile",
  "setup.py",
  "manage.py",
  "go.mod",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "composer.json",
  "procfile",
]);

/** Directories that hold a Dockerfile for the project next to them, not a project of their own. */
const DOCKER_HELPER_DIRS = new Set(["docker", ".docker", "deploy", "deployment", "ops", "infra", "scripts", ".devcontainer", "containers", "build", "ci"]);

const isDockerfileName = (lower: string): boolean => lower === "dockerfile" || lower === "containerfile";
const isRequirements = (lower: string): boolean => /^requirements(?:[-_.][a-z0-9_.-]{1,40})?\.txt$/.test(lower);

export function discoverRoots(paths: string[]): Root[] {
  const byDir = new Map<string, Root>();
  const root = (dir: string): Root => {
    let r = byDir.get(dir);
    if (!r) {
      r = { dir, markers: new Set() };
      byDir.set(dir, r);
    }
    return r;
  };
  root(""); // always present

  for (const path of paths) {
    const lower = basename(path).toLowerCase();
    const dir = dirname(path);
    if (MARKERS.has(lower) || isRequirements(lower)) {
      root(dir).markers.add(lower);
    } else if (isDockerfileName(lower) && !DOCKER_HELPER_DIRS.has(basename(dir))) {
      root(dir).markers.add(lower);
    } else if (lower === "index.html" && dir === "") {
      root("").markers.add(lower);
    }
  }
  return [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
