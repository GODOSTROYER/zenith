/** Opt-in private GitHub archive contract. Disabled without explicit network authorization. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createSourceBundles } from "@/lib/platform/source-bundle";

describe.skipIf(process.env.ZENITH_TEST_SOURCE_GITHUB_APP !== "1")("private GitHub App source (opt-in network)", () => {
  it("downloads the bound repository at a pinned commit with an ephemeral scoped token", async () => {
    const config = githubAppConfig(); const ref = process.env.ZENITH_TEST_SOURCE_REF;
    let raw: unknown;
    try { raw = JSON.parse(process.env.ZENITH_TEST_SOURCE_GITHUB_BINDING ?? "{}"); }
    catch { throw new Error("The private source check requires valid non-secret binding identifiers."); }
    const parsed = z.object({ workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), owner: z.string(), repo: z.string(), appId: z.string(), installationId: z.number().int().positive().safe(), repositoryId: z.number().int().positive().safe(), version: z.number().int().positive() }).strict().safeParse(raw);
    if (!config || !ref || !/^[a-f0-9]{40}$/.test(ref) || !parsed.success) throw new Error("The private source check requires App configuration, non-secret binding identifiers and a pinned ref.");
    const binding = parsed.data;
    const bundler = createSourceBundles({ withGithubAccess: (scope, fn) => {
      if (`${scope.owner}/${scope.repo}`.toLowerCase() !== `${binding.owner}/${binding.repo}`.toLowerCase()) throw new Error("Private source check repository mismatch.");
      return createGithubApp(config).withRepositoryAccess(binding, fn);
    } });
    const result = await bundler.read({ repo: `${binding.owner}/${binding.repo}`, ref });
    expect(result.bytes > 0).toBe(true); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
