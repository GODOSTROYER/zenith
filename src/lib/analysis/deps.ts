/**
 * Dependency-manifest readers: package.json, requirements/pyproject/Pipfile,
 * go.mod, Gemfile, pom.xml/build.gradle, Cargo.toml, composer.json.
 *
 * Each reader turns text into `Dep` records and runtime versions on the
 * root's facts. They parse; they never resolve, install or run anything. All
 * scanning is line-based with bounded patterns.
 */
import { addRuntime, ev } from "./record";
import type { Ctx, Eco, RootFacts } from "./model";
import { basename, isRecord, joinPath, lines, parseJson, portFromCommand, quotedStrings, sanitizeInline, stringEntries, tomlSections, type Line } from "./text";

function addDep(f: RootFacts, eco: Eco, name: string, dev: boolean, path: string, line: number | undefined, key = name): void {
  const id = `${eco}:${key}`;
  const cur = f.deps.get(id);
  if (cur && (!cur.dev || dev)) return; // production evidence wins over dev
  f.deps.set(id, { eco, name: key, dev, evidence: ev(path, `dep:${eco}:${key}`, line) });
}

/* ---------------------------------- node --------------------------------- */

function keyLines(content: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const { n, text } of lines(content)) {
    const k = /^\s{0,40}"([^"\n]{1,214})"\s{0,4}:/.exec(text);
    if (k && !m.has(k[1])) m.set(k[1], n);
  }
  return m;
}

/** Line of `key` appearing after `section`'s own line — good enough for evidence, never used for logic. */
function keyLineAfter(content: string, section: string, key: string): number | undefined {
  let seen = false;
  for (const { n, text } of lines(content)) {
    if (!seen) seen = text.includes(`"${section}"`);
    else if (text.includes(`"${key}"`)) return n;
  }
  return undefined;
}

const NODE_VERSION_FILES: [string, string][] = [
  [".nvmrc", "file:.nvmrc"],
  [".node-version", "file:.node-version"],
];

function readNode(ctx: Ctx, f: RootFacts, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  const json = parseJson(content);
  if (!isRecord(json)) {
    ctx.unknowns.add(`${path} could not be parsed as JSON, so its dependencies are unknown.`);
    return;
  }
  const lineOfKey = keyLines(content);
  const sections: [string, boolean][] = [
    ["dependencies", false],
    ["optionalDependencies", false],
    ["devDependencies", true],
    ["peerDependencies", true],
  ];
  const localSpecs: string[] = [];
  for (const [section, dev] of sections) {
    const table = json[section];
    if (!isRecord(table)) continue;
    for (const name of Object.keys(table).sort()) {
      addDep(f, "npm", name, dev, path, lineOfKey.get(name));
      const spec = table[name];
      if (typeof spec === "string" && /^(?:workspace:|file:|link:)/.test(spec)) localSpecs.push(name);
    }
  }
  const scripts = new Map(stringEntries(json.scripts).map(([k, v]) => [k, sanitizeInline(v, 400)] as const));
  const engines = isRecord(json.engines) ? json.engines : {};
  const workspaces = Array.isArray(json.workspaces)
    ? json.workspaces.filter((w): w is string => typeof w === "string")
    : isRecord(json.workspaces) && Array.isArray(json.workspaces.packages)
      ? json.workspaces.packages.filter((w): w is string => typeof w === "string")
      : undefined;
  f.pkg = {
    path,
    name: typeof json.name === "string" ? sanitizeInline(json.name, 100) : undefined,
    scripts,
    main: typeof json.main === "string" ? sanitizeInline(json.main, 200) : undefined,
    workspaces,
    packageManager: typeof json.packageManager === "string" ? sanitizeInline(json.packageManager, 60) : undefined,
    localDeps: localSpecs,
  };
  const startScript = scripts.get("start");
  const startPort = startScript ? portFromCommand(startScript) : undefined;
  if (startPort !== undefined) f.ports.push({ port: startPort, rank: 6, source: "start script flag", evidence: ev(path, "script:start", lineOfKey.get("start")) });
  if (typeof engines.node === "string") addRuntime(ctx, f.root.dir, "node", engines.node, "high", ev(path, "package.json:engines.node", keyLineAfter(content, "engines", "node")));
  else addRuntime(ctx, f.root.dir, "node", undefined, "medium", ev(path, "file:package.json"));
  for (const [file, rule] of NODE_VERSION_FILES) {
    const p = joinPath(f.root.dir, file);
    const text = ctx.idx.get(p);
    if (text !== undefined) {
      const v = text.split("\n")[0].trim();
      if (/^[A-Za-z0-9._*/-]{1,30}$/.test(v)) addRuntime(ctx, f.root.dir, "node", v.replace(/^v/, ""), "high", ev(p, rule, 1));
    }
  }
}

/* --------------------------------- python -------------------------------- */

const REQ_LINE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s{0,4}(?:\[([A-Za-z0-9_,\s-]{1,80})\])?/;
const normPy = (s: string): string => s.toLowerCase().replace(/[_.]+/g, "-");

function addPySpec(f: RootFacts, spec: string, dev: boolean, path: string, line: number): void {
  const m = REQ_LINE.exec(spec.trim());
  if (!m) return;
  const name = normPy(m[1]);
  addDep(f, "pip", name, dev, path, line);
  if (m[2]) for (const extra of m[2].split(",")) if (extra.trim()) addDep(f, "pip", name, dev, path, line, `${name}[${normPy(extra.trim())}]`);
}

function readRequirements(f: RootFacts, path: string, content: string): void {
  const dev = /(?:dev|test|lint|docs)/i.test(basename(path));
  for (const { n, text } of lines(content)) {
    const t = text.split(" #")[0].trim();
    if (t === "" || t.startsWith("#") || t.startsWith("-")) continue;
    addPySpec(f, t.split(";")[0], dev, path, n);
  }
}

const QUOTED = /"[^"\n]{0,200}"|'[^'\n]{0,200}'/g;

/** Quoted strings in `key = [ ... ]`, which may span lines. Returns the index of the closing line. */
function captureArray(ls: Line[], start: number): { items: { text: string; n: number }[]; end: number } {
  const items: { text: string; n: number }[] = [];
  let i = start;
  for (; i < ls.length && i < start + 400; i++) {
    let seg = ls[i].text;
    if (i === start) seg = seg.slice(seg.indexOf("[") + 1);
    for (const q of quotedStrings(seg)) items.push({ text: q, n: ls[i].n });
    // `]` inside quotes (extras such as "psycopg[binary]") must not close the array
    if (seg.replace(QUOTED, '""').includes("]")) break;
  }
  return { items, end: i };
}

function readPyproject(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  for (const section of tomlSections(content)) {
    const name = section.name;
    if (name === "project" || name === "dependency-groups" || name === "project.optional-dependencies") {
      const dev = name !== "project";
      for (let i = 0; i < section.lines.length; i++) {
        const t = section.lines[i].text;
        const req = /^requires-python\s{0,4}=\s{0,4}["']([^"']{1,40})["']/.exec(t);
        if (req && name === "project") addRuntime(ctx, f.root.dir, "python", req[1], "high", ev(path, "pyproject:requires-python", section.lines[i].n));
        if (/^(?:dependencies|[A-Za-z0-9_.-]{1,60})\s{0,4}=\s{0,4}\[/.test(t)) {
          const isDeps = t.startsWith("dependencies");
          if (name === "project" && !isDeps) continue;
          const { items, end } = captureArray(section.lines, i);
          for (const it of items) addPySpec(f, it.text, dev || !isDeps, path, it.n);
          i = end;
        }
      }
    } else if (name === "tool.poetry.dependencies" || name === "tool.poetry.dev-dependencies" || /^tool\.poetry\.group\.[A-Za-z0-9_-]{1,40}\.dependencies$/.test(name)) {
      const dev = name !== "tool.poetry.dependencies";
      for (const { n, text } of section.lines) {
        const k = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s{0,4}=\s{0,4}(.{0,200})$/.exec(text);
        if (!k) continue;
        if (k[1].toLowerCase() === "python") {
          const v = quotedStrings(k[2])[0];
          if (v) addRuntime(ctx, f.root.dir, "python", v, "high", ev(path, "pyproject:tool.poetry.python", n));
        } else addDep(f, "pip", normPy(k[1]), dev, path, n);
      }
    }
  }
  addRuntime(ctx, f.root.dir, "python", undefined, "medium", ev(path, "file:pyproject.toml"));
}

function readPipfile(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  for (const section of tomlSections(content)) {
    if (section.name === "packages" || section.name === "dev-packages") {
      for (const { n, text } of section.lines) {
        const k = /^["']?([A-Za-z0-9][A-Za-z0-9._-]{0,99})["']?\s{0,4}=/.exec(text);
        if (k) addDep(f, "pip", normPy(k[1]), section.name === "dev-packages", path, n);
      }
    } else if (section.name === "requires") {
      for (const { n, text } of section.lines) {
        const v = /^python_(?:full_)?version\s{0,4}=\s{0,4}["']([^"']{1,20})["']/.exec(text);
        if (v) addRuntime(ctx, f.root.dir, "python", v[1], "high", ev(path, "pipfile:python_version", n));
      }
    }
  }
  addRuntime(ctx, f.root.dir, "python", undefined, "medium", ev(path, "file:Pipfile"));
}

function readSetupPy(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  const ls = lines(content);
  for (let i = 0; i < ls.length; i++) {
    const t = ls[i].text;
    const req = /python_requires\s{0,4}=\s{0,4}["']([^"']{1,40})["']/.exec(t);
    if (req) addRuntime(ctx, f.root.dir, "python", req[1], "high", ev(path, "setup.py:python_requires", ls[i].n));
    if (/install_requires\s{0,4}=\s{0,4}\[/.test(t)) {
      const { items, end } = captureArray(ls, i);
      for (const it of items) addPySpec(f, it.text, false, path, it.n);
      i = end;
    }
  }
}

function readPythonVersionFiles(ctx: Ctx, f: RootFacts): void {
  const dir = f.root.dir;
  const pv = ctx.idx.get(joinPath(dir, ".python-version"));
  if (pv !== undefined) {
    const v = pv.split("\n")[0].trim();
    if (/^[A-Za-z0-9._-]{1,30}$/.test(v)) addRuntime(ctx, dir, "python", v, "high", ev(joinPath(dir, ".python-version"), "file:.python-version", 1));
  }
  const rt = ctx.idx.get(joinPath(dir, "runtime.txt"));
  if (rt !== undefined) {
    const m = /^python-(\d[\w.]{0,20})/.exec(rt.trim());
    if (m) addRuntime(ctx, dir, "python", m[1], "high", ev(joinPath(dir, "runtime.txt"), "file:runtime.txt", 1));
  }
}

/* ------------------------------------ go --------------------------------- */

function readGoMod(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  let inRequire = false;
  for (const { n, text } of lines(content)) {
    const t = text.split("//")[0].trim();
    if (t === "") continue;
    const go = /^go\s{1,4}(\d[\w.]{0,20})$/.exec(t);
    if (go) {
      addRuntime(ctx, f.root.dir, "go", go[1], "high", ev(path, "go.mod:go", n));
      continue;
    }
    if (/^require\s{0,4}\($/.test(t)) {
      inRequire = true;
      continue;
    }
    if (inRequire && t === ")") {
      inRequire = false;
      continue;
    }
    const single = /^require\s{1,4}(\S{1,200})\s{1,4}v\d/.exec(t);
    const block = inRequire ? /^(\S{1,200})\s{1,4}v\d/.exec(t) : null;
    const mod = single?.[1] ?? block?.[1];
    if (mod) addDep(f, "go", mod, false, path, n);
  }
  addRuntime(ctx, f.root.dir, "go", undefined, "medium", ev(path, "file:go.mod"));
}

/* ----------------------------------- ruby -------------------------------- */

function readGemfile(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  let group = false;
  for (const { n, text } of lines(content)) {
    const t = text.trim();
    if (/^group\s.*\sdo$/.test(t) && /:(?:development|test)\b/.test(t)) group = true;
    else if (t === "end") group = false;
    const gem = /^gem\s{1,4}["']([A-Za-z0-9_.-]{1,100})["']/.exec(t);
    if (gem) addDep(f, "gem", gem[1], group, path, n);
    const ruby = /^ruby\s{1,4}["']([^"']{1,30})["']/.exec(t);
    if (ruby) addRuntime(ctx, f.root.dir, "ruby", ruby[1], "high", ev(path, "Gemfile:ruby", n));
  }
  const rv = ctx.idx.get(joinPath(f.root.dir, ".ruby-version"));
  if (rv !== undefined) {
    const v = rv.split("\n")[0].trim().replace(/^ruby-/, "");
    if (/^[A-Za-z0-9._-]{1,30}$/.test(v)) addRuntime(ctx, f.root.dir, "ruby", v, "high", ev(joinPath(f.root.dir, ".ruby-version"), "file:.ruby-version", 1));
  }
  addRuntime(ctx, f.root.dir, "ruby", undefined, "medium", ev(path, "file:Gemfile"));
}

/* ----------------------------------- java -------------------------------- */

const JAVA_VERSION_PATTERNS: RegExp[] = [
  /<java\.version>\s{0,4}(\d{1,2}(?:\.\d{1,2})?)\s{0,4}</,
  /<maven\.compiler\.(?:source|release|target)>\s{0,4}(\d{1,2}(?:\.\d{1,2})?)\s{0,4}</,
  /<release>\s{0,4}(\d{1,2})\s{0,4}</,
  /(?:sourceCompatibility|targetCompatibility)\s{0,4}=\s{0,4}['"]?(?:JavaVersion\.VERSION_)?(\d{1,2}(?:[._]\d{1,2})?)/,
  /jvmToolchain\(\s{0,4}(\d{1,2})\s{0,4}\)/,
  /JavaLanguageVersion\.of\(\s{0,4}(\d{1,2})\s{0,4}\)/,
];

function readJavaBuild(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  const isPom = path.endsWith("pom.xml");
  for (const { n, text } of lines(content)) {
    if (isPom) {
      for (const m of text.matchAll(/<artifactId>\s{0,4}([A-Za-z0-9_.-]{1,120})\s{0,4}<\/artifactId>/g)) addDep(f, "mvn", m[1], false, path, n);
    } else {
      for (const m of text.matchAll(/["']([A-Za-z0-9_.-]{1,80}):([A-Za-z0-9_.-]{1,80})(?::[^"'\s]{0,60})?["']/g)) addDep(f, "mvn", m[2], false, path, n);
      if (/org\.springframework\.boot/.test(text) && /\bid\b|plugin|apply/.test(text)) addDep(f, "mvn", "spring-boot-starter-parent", false, path, n);
    }
    for (const re of JAVA_VERSION_PATTERNS) {
      const v = re.exec(text);
      if (v) addRuntime(ctx, f.root.dir, "java", v[1].replace("_", "."), "high", ev(path, isPom ? "pom.xml:java-version" : "gradle:java-version", n));
    }
  }
  addRuntime(ctx, f.root.dir, "java", undefined, "medium", ev(path, `file:${basename(path)}`));
}

/* ----------------------------------- rust -------------------------------- */

function readCargo(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  for (const section of tomlSections(content)) {
    if (section.name === "dependencies" || section.name === "dev-dependencies" || section.name === "build-dependencies") {
      for (const { n, text } of section.lines) {
        const k = /^([A-Za-z0-9_-]{1,80})\s{0,4}=/.exec(text);
        if (k) addDep(f, "cargo", k[1], section.name !== "dependencies", path, n);
      }
    } else if (section.name === "package") {
      for (const { n, text } of section.lines) {
        const v = /^rust-version\s{0,4}=\s{0,4}["']([^"']{1,20})["']/.exec(text);
        if (v) addRuntime(ctx, f.root.dir, "rust", v[1], "high", ev(path, "Cargo.toml:rust-version", n));
      }
    }
  }
  addRuntime(ctx, f.root.dir, "rust", undefined, "medium", ev(path, "file:Cargo.toml"));
}

/* ----------------------------------- php --------------------------------- */

function readComposer(ctx: Ctx, f: RootFacts, path: string, content: string): void {
  const json = parseJson(content);
  if (!isRecord(json)) {
    ctx.unknowns.add(`${path} could not be parsed as JSON, so its dependencies are unknown.`);
    return;
  }
  const lineOfKey = keyLines(content);
  for (const [section, dev] of [["require", false], ["require-dev", true]] as const) {
    const table = json[section];
    if (!isRecord(table)) continue;
    for (const name of Object.keys(table).sort()) {
      if (name === "php") {
        const v = table[name];
        if (typeof v === "string") addRuntime(ctx, f.root.dir, "php", v, "high", ev(path, "composer.json:require.php", lineOfKey.get("php")));
      } else addDep(f, "composer", name, dev, path, lineOfKey.get(name));
    }
  }
  addRuntime(ctx, f.root.dir, "php", undefined, "medium", ev(path, "file:composer.json"));
}

/* --------------------------------- driver -------------------------------- */

/** Read every dependency manifest that sits directly in the root's directory. */
export function readDependencies(ctx: Ctx, f: RootFacts): void {
  const dir = f.root.dir;
  const at = (name: string): { path: string; content: string } | undefined => {
    const path = joinPath(dir, name);
    const content = ctx.idx.get(path);
    return content === undefined ? undefined : { path, content };
  };

  const pkg = at("package.json");
  if (pkg) readNode(ctx, f, pkg.path);

  // requirements*.txt next to the root and requirements/*.txt one level down
  for (const p of [...f.fileSet].sort()) {
    const rel = dir === "" ? p : p.slice(dir.length + 1);
    if (/^requirements(?:[-_.][a-z0-9_.-]{1,40})?\.txt$/i.test(rel) || /^requirements\/[A-Za-z0-9_.-]{1,60}\.txt$/i.test(rel)) readRequirements(f, p, ctx.idx.get(p) ?? "");
  }
  const pyproject = at("pyproject.toml");
  if (pyproject) readPyproject(ctx, f, pyproject.path, pyproject.content);
  const pipfile = at("Pipfile");
  if (pipfile) readPipfile(ctx, f, pipfile.path, pipfile.content);
  const setup = at("setup.py");
  if (setup) readSetupPy(ctx, f, setup.path, setup.content);
  const pyManifest = [...f.fileSet].sort().find((p) => /(?:^|\/)(?:requirements[^/]{0,60}\.txt|pyproject\.toml|Pipfile|setup\.py|manage\.py)$/.test(p) && p.split("/").length === (dir === "" ? 1 : dir.split("/").length + 1));
  if (pyManifest) {
    readPythonVersionFiles(ctx, f);
    addRuntime(ctx, dir, "python", undefined, "medium", ev(pyManifest, `file:${basename(pyManifest)}`));
  }

  const gomod = at("go.mod");
  if (gomod) readGoMod(ctx, f, gomod.path, gomod.content);
  const gemfile = at("Gemfile");
  if (gemfile) readGemfile(ctx, f, gemfile.path, gemfile.content);
  for (const name of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    const b = at(name);
    if (b) readJavaBuild(ctx, f, b.path, b.content);
  }
  const cargo = at("Cargo.toml");
  if (cargo) readCargo(ctx, f, cargo.path, cargo.content);
  const composer = at("composer.json");
  if (composer) readComposer(ctx, f, composer.path, composer.content);

  // .tool-versions names runtimes for several languages at once
  const tv = at(".tool-versions");
  if (tv) {
    const map: Record<string, Parameters<typeof addRuntime>[2]> = { nodejs: "node", python: "python", ruby: "ruby", golang: "go", java: "java", rust: "rust", php: "php" };
    for (const { n, text } of lines(tv.content)) {
      const m = /^([a-z]{2,10})\s{1,4}(\S{1,30})/.exec(text.trim());
      if (m && map[m[1]]) addRuntime(ctx, dir, map[m[1]], m[2], "medium", ev(tv.path, "file:.tool-versions", n));
    }
  }
}
