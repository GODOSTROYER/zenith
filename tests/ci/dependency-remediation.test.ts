/** Real package compatibility checks. No SMTP server, HTTP calls or test shims. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const require = createRequire(import.meta.url);
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

describe("approved dependency remediation", () => {
  it("rejects oversized collections before allocating per-element validation errors", () => {
    let visited = 0;
    const bounded = z.array(z.unknown().superRefine(() => { visited++; })).max(8);
    const result = bounded.safeParse(Array(10_000).fill("item"));
    expect(require("zod/package.json").version).toBe("4.6.7");
    expect(result.success).toBe(false);
    expect(visited).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  it("preserves the supported runtime and pins both major migrations", () => {
    expect(pkg.engines.node).toBe(">=22.22.2 <23");
    expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
    expect(pkg.dependencies.nodemailer).toBe("10.3.1");
    expect(pkg.devDependencies.vitest).toBe("4.1.12");
    expect(require("nodemailer/package.json").version).toBe("10.3.1");
    expect(require("vitest/package.json").version).toBe("4.1.12");
    expect(require("@vitest/mocker/package.json").version).toBe("4.1.12");
  });

  it("resolves every HTTP client to the patched supported branch", () => {
    expect(require("undici/package.json").version).toBe("8.12.3");
    expect(typeof require("undici").fetch).toBe("function");
    const e2bRequire = createRequire(require.resolve("e2b/package.json"));
    expect(e2bRequire("undici/package.json").version).toBe("8.12.3");
    expect(typeof e2bRequire("undici").fetch).toBe("function");
    expect(Object.keys(lock.packages).some((entry) => /node_modules\/undici8$/.test(entry))).toBe(false);
  });

  it.each(["minimatch", "glob", "@typescript-eslint/typescript-estree"])("retains normal expansion through the patched %s resolver", (moduleName) => {
    const parentRequire = createRequire(require.resolve(moduleName));
    const matcherRequire = createRequire(parentRequire.resolve("minimatch"));
    expect(matcherRequire("brace-expansion/package.json").version).toBe("5.0.12");
    const directory = matcherRequire.resolve("brace-expansion");
    const loaded = require(directory);
    const expand = typeof loaded === "function" ? loaded : loaded.expand ?? loaded.default;
    expect(expand("src/{one,two}/file{1,2}.ts")).toEqual([
      "src/one/file1.ts", "src/one/file2.ts", "src/two/file1.ts", "src/two/file2.ts",
    ]);
  });

  it("loads the overridden PostCSS through Next and retains CSS/source-map processing", async () => {
    const nextRequire = createRequire(require.resolve("next/package.json"));
    expect(nextRequire("postcss/package.json").version).toBe("8.5.23");
    const postcss = nextRequire("postcss") as typeof import("postcss").default;
    const css = ".card { color: red; --spacing: 8px; }\n@media (width > 600px) { .card { display: grid; } }";
    const result = await postcss([]).process(css, {
      from: path.join(root, "compat-input.css"),
      to: path.join(root, "compat-output.css"),
      map: { inline: false, annotation: false, sourcesContent: true },
    });
    expect(result.css).toBe(css);
    expect(result.root.nodes).toHaveLength(2);
    expect(result.warnings()).toEqual([]);
    expect(result.map?.toJSON()).toMatchObject({ version: 3, sourcesContent: [css] });
  });

  it("keeps Nodemailer's ESM/CommonJS transport APIs and SMTP URL parsing compatible", async () => {
    const imported = await import("nodemailer");
    const api = typeof imported.createTransport === "function" ? imported : imported.default;
    expect(typeof api.createTransport).toBe("function");
    expect(typeof require("nodemailer").createTransport).toBe("function");
    const transport = api.createTransport("smtp://test%3Auser:dummy-password@example.invalid:2525/?secure=false");
    try {
      expect(transport).toHaveProperty("options.host", "example.invalid");
      expect(transport).toHaveProperty("options.port", 2525);
      expect(transport).toHaveProperty("options.auth.user", "test:user");
      expect(typeof transport.sendMail).toBe("function");
      expect(typeof transport.close).toBe("function");
    } finally { transport.close(); }
  });

  it("produces a real buffered email with the string recipient shape used by both callers", async () => {
    const imported = await import("nodemailer");
    const api = typeof imported.createTransport === "function" ? imported : imported.default;
    const transport = api.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    try {
      const sent = await transport.sendMail({
        from: "Zenith <sender@example.test>", to: "Operator <recipient@example.test>",
        subject: "Dependency compatibility", text: "dependency-remediation-body", disableFileAccess: true, disableUrlAccess: true,
      });
      expect(sent.envelope).toEqual({ from: "sender@example.test", to: ["recipient@example.test"] });
      expect(sent.messageId).toMatch(/^<.+>$/);
      if (!Buffer.isBuffer(sent.message)) throw new Error("Expected a buffered MIME message");
      const mime = sent.message.toString("utf8");
      expect(mime).toContain("Subject: Dependency compatibility");
      expect(mime).toContain("dependency-remediation-body");
    } finally { transport.close(); }
  });
});
