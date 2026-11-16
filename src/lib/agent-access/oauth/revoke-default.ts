/** Production wiring for the RFC 7009 endpoint: the live credential authority,
 * the grant journal, the plugin store and the same OAuth verification the MCP
 * endpoints use. Nothing is opened until a request arrives. */
import { requireCredentialAuthority, linkRateLimit } from "@/lib/agent-access/authority";
import { checkRequestOrigin } from "../control/boundary";
import { oauthConfig, verifyOAuth } from "../control/oauth";
import { control } from "../control/runtime";
import { clientAddress, limitKey } from "../link/protocol";
import { resourceFor } from "../v3/auth";
import type { RevokeDeps } from "./revoke";

export function defaultRevokeDeps(): RevokeDeps {
  return {
    checkOrigin: checkRequestOrigin,
    limit: (request) => linkRateLimit("oauth.revoke", limitKey(clientAddress(request)), { limit: 30, windowMs: 60_000 }),
    authority: async () => {
      const authority = await requireCredentialAuthority();
      return { verify: (header) => authority.verify(header), revokeCredential: (subject, workspaceId, id) => authority.revokeCredential(subject, workspaceId, id) };
    },
    plugins: {
      revokeByToken: async (token) => {
        const { defaultPluginDeps } = await import("@/lib/plugins/runtime");
        const { revokePluginTokenByPossession } = await import("@/lib/plugins/service");
        return revokePluginTokenByPossession(await defaultPluginDeps(), token);
      },
    },
    oauth: {
      config: (origin) => oauthConfig(process.env, origin),
      verify: verifyOAuth,
      revokeGrant: async (identity, workspaceId) => {
        const journal = (await control()).journal;
        const grant = await journal.getGrant(identity.subject, identity.clientId, workspaceId);
        if (!grant || grant.oauthIssuer !== identity.issuer) return false;
        if (grant.revoked) return true;
        await journal.setGrant({ ...grant, revoked: true });
        return true;
      },
    },
    resources: (origin) => [resourceFor(origin), `${origin}/api/agent/v2/mcp`],
  };
}
