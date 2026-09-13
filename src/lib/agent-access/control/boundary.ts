import { randomUUID } from 'node:crypto';
import { ControlError, type Principal } from './journal';
import { AgentError, authenticate, loadCredentials, type SelectedScope } from '../security';
import { control, inAgentScope, requireControl, resolveTarget } from './runtime';
import { oauthConfig, verifyOAuth, bindGrant } from './oauth';
import { throttle } from './rate-limit';
const id=(x:string|null|undefined)=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
export function controlOrigin(): string {
  const raw=process.env.ZENITH_AGENT_ORIGIN??'';let url:URL;
  try{url=new URL(raw);}catch{throw new ControlError('origin_configuration','Configure the trusted Zenith origin.',503);}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==raw
    ||url.protocol!=='https:'&&!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/.test(raw))throw new ControlError('origin_configuration','Use an exact HTTPS origin or literal local development origin.',503);
  return url.origin;
}
export function checkRequestOrigin(request: Request): string {
  requireControl();const origin=controlOrigin(),target=new URL(origin);
  if((request.headers.get('host')??new URL(request.url).host)!==target.host||request.headers.has('origin')&&request.headers.get('origin')!==origin)
    throw new ControlError('origin_denied','Use the configured Zenith host. Forwarded host headers are not trusted.',403);
  return origin;
}
function selection(request: Request, who?: Principal): SelectedScope {
  const params=new URL(request.url).searchParams;
  const take=(header:string,query:string)=>{const a=request.headers.get(header),b=params.get(query);if(a&&b&&a!==b)throw new ControlError('ambiguous_scope','Header and URL selections conflict.',400);return a??b??undefined;};
  const workspaceId=take('x-zenith-workspace','workspace'), projectId=take('x-zenith-project','project'),environmentId=take('x-zenith-environment','environment');
  if(!id(workspaceId)||projectId!==undefined&&!id(projectId)||environmentId!==undefined&&(!id(environmentId)||!projectId))throw new ControlError('scope_required','Select a workspace and optional project/environment explicitly.',400);
  if(who&&(workspaceId!==who.workspaceId||projectId&&!who.projectIds.includes(projectId)||environmentId&&who.environmentIds&&!who.environmentIds.includes(environmentId)))throw new ControlError('scope_denied','The requested selection is outside this integration grant.',403);
  return {workspaceId:workspaceId!,...(projectId?{projectId}:{}),...(environmentId?{environmentId}:{})};
}
export async function authorizeRequest(request: Request): Promise<{who:Principal;selected:SelectedScope;origin:string}> {
  const origin=checkRequestOrigin(request),authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer '))throw new ControlError('authentication_required','Authenticate to Zenith with a scoped integration token.',401);
  const token=authorization.slice(7);let who:Principal;
  if(token.startsWith('za_')) {
    if(!origin.startsWith('http://'))throw new ControlError('oauth_required','Remote access requires OAuth; development credentials are accepted only on the loopback origin.',401);
    const grant=authenticate(authorization,await loadCredentials(process.env.ZENITH_AGENT_CREDENTIAL_FILE??''));
    who={...grant,integrationId:grant.id};
  } else {
    const config=oauthConfig(process.env,origin);if(!config)throw new ControlError('oauth_unavailable','Configure a trusted OAuth authorization server before remote use.',503);
    const selected=selection(request),identity=await verifyOAuth(token,config);
    // External subject must be the same stable subject used by Zenith workspace membership.
    who=bindGrant(identity,control().journal.getGrant(identity.subject,identity.clientId,selected.workspaceId));
  }
  const selected=selection(request,who);
  await inAgentScope(who,async()=>{if(selected.projectId)resolveTarget(who,{...selected,projectId:selected.projectId});});
  return {who,selected,origin};
}
export async function boundedBody(request:Request,maximum=524288):Promise<Uint8Array>{
  if(!request.body)return new Uint8Array();
  const abort=AbortSignal.any([request.signal,AbortSignal.timeout(20000)]),reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){abort.throwIfAborted();const item=await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve,reject)=>{const fail=()=>reject(new ControlError('body_timeout','Request body timed out.',408));abort.addEventListener('abort',fail,{once:true});reader.read().then(resolve,reject).finally(()=>abort.removeEventListener('abort',fail));});if(item.done)break;bytes+=item.value.byteLength;if(bytes>maximum)throw new ControlError('body_too_large','Request exceeds its byte limit.',413);chunks.push(item.value);}}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const out=new Uint8Array(bytes);let offset=0;for(const part of chunks){out.set(part,offset);offset+=part.length;}return out;
}
export async function jsonBody(request:Request):Promise<unknown>{
  if((request.headers.get('content-type')??'').split(';')[0].toLowerCase()!=='application/json')throw new ControlError('media_type','Send application/json.',415);
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBody(request)));}catch(e){if(e instanceof ControlError)throw e;throw new ControlError('invalid_json','Send bounded UTF-8 JSON.',400);}
}
export function json(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});}
export function failure(error:unknown):Response{
  const e=error instanceof ControlError?error:error instanceof AgentError?new ControlError(error.code,error.message,error.status):new ControlError('request_failed','The request was refused. Check configuration or server diagnostics.',400);
  const response=json({error:{code:e.code,message:e.message,requestId:randomUUID()}},e.status);
  if(e.status===401){try{response.headers.set('www-authenticate',`Bearer resource_metadata="${controlOrigin()}/.well-known/oauth-protected-resource/api/agent/v2/mcp", scope="zenith:read"`);}catch{/* misconfigured origin */}}
  return response;
}
export { throttle };
