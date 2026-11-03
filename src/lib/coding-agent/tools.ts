/**
 * Fixed, read-only repository tools. Model output never selects permissions,
 * budgets, network destinations, approval or execution. Every source result
 * is redacted and fenced; only structured, evidence-checked requirements can
 * influence the deterministic proposal compiler.
 */
import { z } from "zod";
import { analyzeRepository, type AppRequirements, type RepoSnapshot } from "@/lib/analysis";
import type { AnyManifest } from "@/lib/domain/types";
import type { AgentSourceRef, ProposalArtifact, ToolSpec } from "./types";
import { RefinementArgs, refineRequirements, requirementsForRoot } from "./refinements";
import { buildProposalArtifact } from "./proposal";
import { redactSourceText } from "./redaction";
import { fence, scanInjection } from "./untrusted";

const MAX_LIST = 200;
const MAX_HITS = 30;
const Offset = z.number().int().min(0).max(1_000_000).optional();
const ListArgs = z.object({ prefix: z.string().max(200).optional(), offset: Offset }).strict();
const ReadArgs = z.object({ path: z.string().min(1).max(300), startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict();
const SearchArgs = z.object({ query: z.string().min(2).max(100), offset: Offset }).strict();
const AnalyzeArgs = z.object({}).strict();
const ProposeArgs = z.object({ environmentClass: z.enum(["sandbox", "staging", "production"]), availability: z.enum(["standard", "high"]).optional() }).strict();
const evidenceSchema = { type: "array", minItems: 1, maxItems: 5, items: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path", "line"], additionalProperties: false } };
const proofSchema = { evidence: evidenceSchema, reason: { type: "string", maxLength: 400 } };
export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "list_files", description: "List sorted retained paths, at most 200. Use nextOffset for subsequent pages. Coverage may be partial.", input_schema: { type: "object", properties: { prefix: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0 } }, additionalProperties: false } },
  { name: "read_file", description: "Read redacted untrusted source with line numbers. At most 200 lines and 12000 characters. Use startLine and endLine for later ranges.", input_schema: { type: "object", properties: { path: { type: "string", maxLength: 300 }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false } },
  { name: "search_files", description: "Literal case-insensitive search of redacted source, at most 30 hits. Use nextOffset to continue.", input_schema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 100 }, offset: { type: "integer", minimum: 0 } }, required: ["query"], additionalProperties: false } },
  { name: "analyze_repository", description: "Extract deterministic requirements, evidence, coverage and unknowns for the selected application.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "refine_requirements", description: "Propose evidence-backed refinements to detected services and dependencies. Evidence must cite exact retained file lines. Inferences remain subject to human review; commands are recorded, never executed.", input_schema: { type: "object", properties: {
    services: { type: "array", maxItems: 20, items: { type: "object", properties: { root: { type: "string" }, name: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 }, healthPath: { type: "string" }, startCommand: { type: "string", maxLength: 300 }, ...proofSchema }, required: ["root", "name", "evidence", "reason"], additionalProperties: false } },
    datastores: { type: "array", maxItems: 20, items: { type: "object", properties: { root: { type: "string" }, kind: { type: "string", enum: ["postgres", "redis", "object_store", "queue", "email", "mysql", "mongodb", "rabbitmq", "kafka", "sqlite"] }, role: { type: "string", enum: ["publish", "consume", "both"] }, ...proofSchema }, required: ["root", "kind", "evidence", "reason"], additionalProperties: false } },
    questions: { type: "array", maxItems: 20, items: { type: "string", maxLength: 400 } },
  }, additionalProperties: false } },
  { name: "propose_manifest", description: "Compile validated requirements into a proposed manifest, retaining existing project settings. This deploys nothing.", input_schema: { type: "object", properties: { environmentClass: { type: "string", enum: ["sandbox", "staging", "production"] }, availability: { type: "string", enum: ["standard", "high"] } }, required: ["environmentClass"], additionalProperties: false } },
];
export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_SPECS.map(t => t.name));

export interface ToolState {
  snapshot: RepoSnapshot;
  repository: string;
  source?: AgentSourceRef;
  baseManifest?: AnyManifest;
  environmentClass?: "sandbox" | "staging" | "production";
  requirements?: AppRequirements;
  artifact?: ProposalArtifact;
  readPaths?: Set<string>;
  injectionSignals: Set<string>;
}
export interface ToolOutcome { text: string; isError?: boolean; unsafe?: "invalid_arguments" | "path_escape" }
const invalid = (name: string, error: z.ZodError): ToolOutcome => ({
  text: "Refused: " + name + " arguments are invalid (" + error.issues.slice(0, 4).map(i => (i.path.join(".") || "(root)") + ": " + i.code).join(", ") + "). Only documented members are accepted.",
  isError: true, unsafe: "invalid_arguments",
});
const note = (state: ToolState, text: string): void => { for (const code of scanInjection(text)) state.injectionSignals.add(code); };
const SAFE_PATH = /^[A-Za-z0-9._/@+~ -]{1,300}$/;
const requirements = (state: ToolState): AppRequirements =>
  state.requirements ??= requirementsForRoot(analyzeRepository(state.snapshot), state.source?.root);

export function runTool(name: string, input: unknown, state: ToolState): ToolOutcome {
  try {
    const result = runToolUnchecked(name, input, state);
    return { ...result, text: redactSourceText(result.text) };
  } catch {
    return { text: "The tool could not process this repository input. Check that evidence refers to an existing snapshot line and application.", isError: true };
  }
}
function runToolUnchecked(name: string, input: unknown, state: ToolState): ToolOutcome {
  const files = new Map(state.snapshot.files.map(f => [f.path, redactSourceText(f.content)] as const));
  const paths = [...files.keys()].sort();
  switch (name) {
    case "list_files": {
      const a = ListArgs.safeParse(input ?? {});
      if (!a.success) return invalid(name, a.error);
      const prefix = a.data.prefix ?? "";
      if (prefix.includes("..") || prefix.startsWith("/") || prefix.includes("\\")) return { text: "Refused: the prefix must be repository-relative.", isError: true, unsafe: "path_escape" };
      const hit = paths.filter(p => p.startsWith(prefix));
      const offset = a.data.offset ?? 0;
      return { text: fence("list", JSON.stringify({ paths: hit.slice(offset, offset + MAX_LIST), totalRetained: hit.length, nextOffset: offset + MAX_LIST < hit.length ? offset + MAX_LIST : null, partial: state.snapshot.truncated })) };
    }
    case "read_file": {
      const a = ReadArgs.safeParse(input);
      if (!a.success) return invalid(name, a.error);
      const p = a.data.path;
      if (p.startsWith("/") || p.split("/").includes("..") || p.includes("\\") || !SAFE_PATH.test(p)) return { text: "Refused: only repository-relative paths can be read.", isError: true, unsafe: "path_escape" };
      const content = files.get(p);
      if (content === undefined) return { text: "No such file in the snapshot.", isError: true };
      const lines = content.split("\n");
      const start = a.data.startLine ?? 1;
      const end = Math.min(a.data.endLine ?? start + 199, start + 199, lines.length);
      if (start > lines.length || end < start) return { text: "The requested line range is outside this file.", isError: true };
      note(state, content);
      (state.readPaths ??= new Set()).add(p);
      const text = lines.slice(start - 1, end).map((line, i) => String(start + i) + ": " + line).join("\n");
      return { text: fence("repo:" + p, "Lines " + start + "-" + end + " of " + lines.length + (end < lines.length ? "; next startLine: " + (end + 1) : "") + "\n" + text) };
    }
    case "search_files": {
      const a = SearchArgs.safeParse(input);
      if (!a.success) return invalid(name, a.error);
      const q = a.data.query.toLowerCase();
      const offset = a.data.offset ?? 0;
      let matched = 0;
      let more = false;
      const hits: string[] = [];
      outer: for (const p of paths) {
        const lines = (files.get(p) ?? "").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          if (matched++ < offset) continue;
          if (hits.length === MAX_HITS) { more = true; break outer; }
          hits.push(p + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 160));
          (state.readPaths ??= new Set()).add(p);
        }
      }
      const text = JSON.stringify({ hits, nextOffset: more ? offset + MAX_HITS : null });
      note(state, text);
      return { text: fence("search", text) };
    }
    case "analyze_repository": {
      const a = AnalyzeArgs.safeParse(input ?? {});
      if (!a.success) return invalid(name, a.error);
      const req = requirements(state);
      const summary = {
        truncated: req.truncated, fileCount: req.fileCount, skipped: state.snapshot.skipped,
        runtimes: req.runtimes, services: req.services, builds: req.builds, datastores: req.datastores,
        migrations: req.migrations, envVarNames: req.envVars.map(e => ({ name: e.value.name, classification: e.value.classification })),
        findings: req.findings.map(f => ({ code: f.value.code, path: f.value.path })), unknowns: req.unknowns,
      };
      const text = JSON.stringify(summary);
      note(state, text);
      return { text: fence("analysis", text, 16_000) };
    }
    case "refine_requirements": {
      const a = RefinementArgs.safeParse(input);
      if (!a.success) return invalid(name, a.error);
      state.requirements = refineRequirements(requirements(state), state.snapshot, a.data);
      // A previous artifact no longer names the refined requirements.
      delete state.artifact;
      return { text: fence("refinement", "Evidence checked. These remain model inferences. Call propose_manifest to review their effect.") };
    }
    case "propose_manifest": {
      const a = ProposeArgs.safeParse(input);
      if (!a.success) return invalid(name, a.error);
      if (state.environmentClass && a.data.environmentClass !== state.environmentClass) return { text: `Use the selected environment class: ${state.environmentClass}. Repository or model text cannot change the run's target.`, isError: true, unsafe: "invalid_arguments" };
      state.artifact = buildProposalArtifact(requirements(state), a.data, state.source, state.baseManifest);
      return { text: fence("proposal", JSON.stringify({ manifestDigest: state.artifact.manifestDigest, unresolved: state.artifact.unresolved, confidence: state.artifact.confidence }), 8_000) };
    }
    default: return { text: "Refused: unknown tool.", isError: true };
  }
}
