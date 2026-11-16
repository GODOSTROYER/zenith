/** Production authentication adapters. Reuse the live v2 authority and grants;
 * the OAuth audience is exclusively the v3 endpoint. No credential is cached. */
import { requireCredentialAuthority } from "@/lib/agent-access/authority";
import { checkRequestOrigin } from "../control/boundary";
import { bindGrant, oauthConfig, verifyOAuth, type OAuthConfig, type VerifiedOAuth } from "../control/oauth";
import { control } from "../control/runtime";
import { resourceFor, type AuthDeps, type OAuthLike } from "./auth";
import { defaultPluginDeps } from "@/lib/plugins/runtime";
import { authenticatePluginToken, resolveLauncherIdentity } from "@/lib/plugins/service";

export function defaultAuth(): AuthDeps {
  const oauth: OAuthLike<OAuthConfig, VerifiedOAuth> = {
    config(origin) {
      const config = oauthConfig(process.env, origin);
      return config ? { ...config, resource: resourceFor(origin) } : undefined;
    },
    verify: verifyOAuth,
    async bind(verified, workspaceId) {
      return bindGrant(verified, await (await control()).journal.getGrant(verified.subject, verified.clientId, workspaceId));
    },
  };
  return {
    checkOrigin: checkRequestOrigin,
    async authority() {
      const authority = await requireCredentialAuthority();
      return {
        kind: authority.kind,
        async verify(header) {
          const c = await authority.verify(header);
          return { id: c.id, subject: c.subject, workspaceId: c.workspaceId, projectIds: c.projectIds,
            environmentIds: c.environmentIds, appIds: c.appIds, scopes: c.scopes, expiresAt: c.expiresAt };
        },
        touch: (id, at) => authority.touch(id, at),
      };
    },
    oauth,
    plugins: { authenticate: async (token, audience) => authenticatePluginToken(await defaultPluginDeps(), token, audience),
      resolveCredential: async (token, audience) => resolveLauncherIdentity(await defaultPluginDeps(), token, audience) },
    now: Date.now,
  };
}
