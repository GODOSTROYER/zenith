/** Resource-server verification only. Login, consent, PKCE and refresh are owned by a maintained external authorization server. */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { ControlError, type Principal } from './journal';
import { SCOPE_NAMES } from './contracts';
export interface OAuthConfig { issuer: string; jwksUrl: string; resource: string; clientClaim: 'client_id'|'azp'; subjectClaim?: string }
export function oauthConfig(env: Record<string,string|undefined>, origin: string): OAuthConfig | undefined {
  if (!env.ZENITH_AGENT_OAUTH_ISSUER && !env.ZENITH_AGENT_OAUTH_JWKS) return undefined;
  const parse = (text: string | undefined) => {
    if(!text)throw new ControlError('oauth_configuration','Configure both the trusted issuer and JWKS URL.',503);
    const url=new URL(text);
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new ControlError('oauth_configuration','OAuth authority URLs must be explicitly trusted HTTPS URLs.',503);
    return url.href;
  };
  parse(env.ZENITH_AGENT_OAUTH_ISSUER); const jwksUrl=parse(env.ZENITH_AGENT_OAUTH_JWKS);
  const claim=env.ZENITH_AGENT_OAUTH_CLIENT_CLAIM??'client_id';
  if(!['client_id','azp'].includes(claim))throw new ControlError('oauth_configuration','Use client_id or azp for the OAuth client binding.',503);
  const subjectClaim=env.ZENITH_AGENT_OAUTH_SUBJECT_CLAIM??'sub';
  if(!/^[A-Za-z][A-Za-z0-9_:/.-]{0,199}$/.test(subjectClaim))throw new ControlError('oauth_configuration','Choose a trusted signed claim mapping to the existing Zenith member ID.',503);
  return {subjectClaim,issuer:env.ZENITH_AGENT_OAUTH_ISSUER!,jwksUrl,resource:`${origin}/api/agent/v2/mcp`,clientClaim:claim as 'client_id'|'azp'};
}
const keysets=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
export interface VerifiedOAuth { subject: string; clientId: string; scopes: string[]; expiresAt: string; issuer: string }
export async function verifyOAuth(token: string, config: OAuthConfig, key?: JWTVerifyGetKey): Promise<VerifiedOAuth> {
  if(token.length>16384)throw new ControlError('invalid_token','Access token is invalid.',401);
  if(!key&&!keysets.has(config.jwksUrl))keysets.set(config.jwksUrl,createRemoteJWKSet(new URL(config.jwksUrl),{timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:300000}));
  let payload: JWTPayload;
  try {
    ({payload}=await jwtVerify(token,key??keysets.get(config.jwksUrl)!,{issuer:config.issuer,audience:config.resource,algorithms:['RS256','ES256','EdDSA'],requiredClaims:['sub','exp','iat','aud','iss'],clockTolerance:0}));
  } catch {throw new ControlError('invalid_token','Access token is expired, invalid, or intended for another resource.',401);}
  const client=payload[config.clientClaim],subject=payload[config.subjectClaim??'sub'];
  if(typeof subject!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(subject)||['local','navigator','system'].includes(subject)
    ||typeof client!=='string'||!client.length||client.length>200||typeof payload.scope!=='string'
    ||!Number.isFinite(payload.iat)||payload.iat!>Date.now()/1000+30||payload.exp!-payload.iat!>3600||payload.exp!<=payload.iat!)
    throw new ControlError('invalid_token','Token lacks the required user, client, scope, or bounded lifetime.',401);
  const scopes=payload.scope.split(/\s+/).filter(s=>s.startsWith('zenith:')).map(s=>s.slice(7)).filter(s=>(SCOPE_NAMES as readonly string[]).includes(s));
  if(!scopes.includes('read'))throw new ControlError('insufficient_scope','Request zenith:read for this resource.',403);
  return {subject,clientId:client,scopes,expiresAt:new Date(payload.exp!*1000).toISOString(),issuer:config.issuer};
}
/** Token scopes and a browser-authorized resource grant must BOTH allow the operation. */
export function bindGrant(identity: VerifiedOAuth, grant: (Principal & {clientId:string;revoked?:boolean})|undefined): Principal {
  if(!grant||grant.revoked||grant.subject!==identity.subject||grant.clientId!==identity.clientId||grant.oauthIssuer!==identity.issuer||Date.parse(grant.expiresAt)<=Date.now())
    throw new ControlError('integration_grant_required','Authorize this OAuth client and resource scope in Zenith → Integrations, or renew its grant.',403);
  const scopes=grant.scopes.filter(s=>identity.scopes.includes(s));
  if(!scopes.includes('read'))throw new ControlError('scope_denied','Token and integration grant do not share the required scope.',403);
  return {...grant,scopes,expiresAt:new Date(Math.min(Date.parse(grant.expiresAt),Date.parse(identity.expiresAt))).toISOString()};
}
