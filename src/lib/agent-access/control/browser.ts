/** Browser-only consent/approval. It uses live identity verification, not token claims alone. */
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { route, currentRequest } from '@/lib/server/request';
import { db } from '@/lib/db/store';
import { verifyRequestIdentity } from '@/lib/hosted/access/identity';
import { AgentError, redact } from '../security';
import { credentialAuthority, requireCredentialAuthority, requireLinkAuthority, linkRateLimit, type LinkedCredential } from '../authority';
import { hashUserCode, limitKey, linkJson, normalizeUserCode, parseApproveRequest, parseRevokeRequest, LINK_MAX_DAYS } from '../link/protocol';
import { ControlError } from './journal';
import { control, requireControl, operationView, reviewOperation } from './runtime';
import { controlOrigin, jsonBody, json, failure } from './boundary';
import { grantSchema, reviewSchema } from './contracts';
import { oauthConfig } from './oauth';
async function browser(req:NextRequest, mutation=false){
  // `await`, because the capability probe that replaces this flag check is
  // async (CONTROL-PLANE §1). Awaiting a synchronous refusal is identical;
  // awaiting an asynchronous one is the difference between a guard and a
  // floating promise.
  await requireControl();
  if(req.headers.has('authorization'))throw new ControlError('browser_required','Use the signed-in Zenith browser interface, not an agent credential.',403);
  if(mutation&&req.headers.get('origin')!==controlOrigin())throw new ControlError('csrf_denied','Submit approvals and grants from the same Zenith origin.',403);
  const identity=await verifyRequestIdentity(req),state=currentRequest();
  if(!identity.emailVerified||!state?.user||state.user.id!==identity.subject||!state.workspace)throw new ControlError('browser_required','Sign in to the target workspace with a verified account.',401);
  const member=db().members.find(m=>m.id===identity.subject&&m.workspaceId===state.workspace!.id);
  if(!member)throw new ControlError('membership_denied','A current workspace member is required.',403);
  return {identity,member,workspace:state.workspace};
}
/**
 * One linked credential, as the Integrations screen lists it (LINK-PROTOCOL §5).
 *
 * Never the hash: `listCredentials` strips it inside the authority, and this
 * shape has nowhere to put it even if it had not.
 */
export interface LinkedAgentView {
  id:string; label:string|null; clientName:string|null; clientVersion:string|null;
  scopes:string[]; projectIds:string[]; environmentIds:string[]|null;
  issuedAt:string; expiresAt:string; lastUsedAt:string|null; revokedAt:string|null;
}
const linkedAgentView=(credential:LinkedCredential):LinkedAgentView=>({
  id:credential.id, label:credential.label??null, clientName:credential.clientName??null,
  clientVersion:credential.clientVersion??null, scopes:credential.scopes, projectIds:credential.projectIds,
  environmentIds:credential.environmentIds??null, issuedAt:credential.issuedAt, expiresAt:credential.expiresAt,
  lastUsedAt:credential.lastUsedAt??null, revokedAt:credential.revokedAt??null,
});
export const browserGet=route(async(req)=>{
  try{const {identity,member,workspace}=await browser(req),origin=controlOrigin();
    // The list is additive and must never be able to take the screen down: an
    // install with no credential authority configured has no linked agents to
    // show, and says which it is rather than rendering an empty list as if it
    // were an answer.
    let linkedAgents:LinkedAgentView[]=[];let linkedAgentsUnavailable:string|undefined;
    try{await requireCredentialAuthority();
      linkedAgents=(await credentialAuthority().listCredentials(identity.subject,workspace.id)).map(linkedAgentView);}
    catch(error){linkedAgentsUnavailable=error instanceof Error?error.message:'The credential authority is unavailable.';}
    return json(redact({workspaceId:workspace.id,subject:identity.subject,role:member.role,
      grants:control().journal.grants(identity.subject,workspace.id),
      operations:control().journal.reviewQueue(workspace.id,identity.subject,member.role==='admin').map(op=>operationView(op,origin)),
      projects:db().projects.filter(p=>p.workspaceId===workspace.id).map(p=>({id:p.id,name:p.name})),
      linkedAgents,...(linkedAgentsUnavailable?{linkedAgentsUnavailable}:{}),
      oauthConfigured:!!oauthConfig(process.env,origin),resource:`${origin}/api/agent/v2/mcp`}));
  }catch(error){return failure(error);}
});

/* ------------------------------- the link flow ------------------------------ */

/** Unknown, expired and consumed codes get the same answer: the code space is not enumerable. */
const noSuchCode=()=>new AgentError('link_code_not_found','That code is not waiting for approval. Check it against your terminal, or run `zenith login` again.',404);

/**
 * What the approval screen is allowed to know about one waiting request.
 *
 * Every string the program supplied is echoed as a string and marked
 * unverified, because it is: a program asking for access names itself, and
 * nothing checks that name. The screen says so next to it.
 */
export const browserLinkGet=route(async(req)=>{
  try{
    const {identity}=await browser(req);
    const authority=await requireLinkAuthority();
    await linkRateLimit('link.lookup',limitKey(identity.subject),{limit:20,windowMs:60_000});
    const code=normalizeUserCode(new URL(req.url).searchParams.get('code'));
    if(!code)throw noSuchCode();
    const row=await authority.linkByUserCode(hashUserCode(code));
    if(!row||row.state!=='pending')throw noSuchCode();
    // Every workspace this person is a live member of — the picker is not
    // limited to whichever one the browser cookie happens to hold.
    const memberships=db().members.filter(m=>m.id===identity.subject);
    const selected=currentRequest()?.workspace?.id;
    const workspaces=memberships.flatMap(m=>{const w=db().workspaces.find(candidate=>candidate.id===m.workspaceId);
      return w?[{id:w.id,name:w.name,role:m.role}]:[];})
      // The cookie's pick first, so the screen's default is the workspace the
      // person is already looking at, when they are a member of it.
      .sort((a,b)=>(a.id===selected?-1:0)-(b.id===selected?-1:0));
    const ids=new Set(workspaces.map(w=>w.id));
    return json(redact({userCode:code.slice(0,4)+'-'+code.slice(4),
      client:{name:row.clientName,version:row.clientVersion??null,label:row.label??null,unverified:true},
      requestedScopes:row.requestedScopes,startedAt:row.createdAt,expiresAt:row.expiresAt,status:row.state,
      subject:identity.subject,workspaces,
      projects:db().projects.filter(p=>ids.has(p.workspaceId)).map(p=>({id:p.id,workspaceId:p.workspaceId,name:p.name})),
      environments:db().environments.filter(e=>db().projects.some(p=>p.id===e.projectId&&ids.has(p.workspaceId)))
        .map(e=>({id:e.id,projectId:e.projectId,name:e.name})),
      maxDays:LINK_MAX_DAYS}));
  }catch(error){return failure(error);}
});

/**
 * Approve or deny, with every decision the page made rechecked here against
 * live state. None of these trust the page: a browser can send any body it
 * likes, and an agent cannot reach this handler at all — `browser()` refuses a
 * request carrying an `authorization` header before anything else runs, which
 * is what "an agent can never approve itself" means mechanically.
 *
 * The one recheck that is not in this function is the code's own state: it is
 * the guarded `UPDATE … WHERE state='pending'` inside `approveLink`, so a
 * double-click issues one credential rather than two. Doing it here as well
 * would spend the row's bounded lookup budget on the approval path.
 */
export const browserLinkApprove=route(async(req)=>{
  try{
    const {identity}=await browser(req,true);
    const authority=await requireLinkAuthority();
    const input=parseApproveRequest(await linkJson(req,16384));
    const userCodeHash=hashUserCode(input.userCode);
    if(!input.approve){
      if(!await authority.denyLink(userCodeHash,identity.subject))throw noSuchCode();
      return json({status:'denied'});
    }
    const member=db().members.find(m=>m.id===identity.subject&&m.workspaceId===input.workspaceId);
    if(!member)throw new ControlError('membership_denied','Choose a workspace you are a current member of.',403);
    if(input.projectIds.some(id=>!db().projects.some(p=>p.id===id&&p.workspaceId===input.workspaceId)))
      throw new ControlError('scope_denied','Select projects from the chosen workspace.',403);
    if(input.environmentIds?.some(id=>!db().environments.some(e=>e.id===id&&input.projectIds.includes(e.projectId))))
      throw new ControlError('scope_denied','Select environments belonging to the selected projects.',403);
    if(!input.scopes.includes('read')||member.role==='viewer'&&input.scopes.some(s=>['write','publish'].includes(s)))
      throw new ControlError('scope_denied','Choose read, and only operations allowed by your current role.',403);
    const issued=await authority.approveLink({userCodeHash,subject:identity.subject,workspaceId:input.workspaceId,
      projectIds:input.projectIds,...(input.environmentIds?{environmentIds:input.environmentIds}:{}),
      scopes:input.scopes as LinkedCredential['scopes'],days:input.days,...(input.label?{label:input.label}:{})});
    // The secret is deliberately not here. The browser tab is the least
    // trustworthy place to hold it; the terminal already has an authenticated
    // channel bound to the device code.
    return json({status:'approved',credentialId:issued.credentialId,expiresAt:issued.expiresAt,
      workspaceId:input.workspaceId,projectIds:input.projectIds,scopes:input.scopes});
  }catch(error){return failure(error);}
});

/** Withdraw one linked credential. Effective on its next request; nothing is cached. */
export const browserLinkRevoke=route(async(req)=>{
  try{
    const {identity,member,workspace}=await browser(req,true);
    const authority=await requireCredentialAuthority();
    const credentialId=parseRevokeRequest(await linkJson(req,4096));
    // An admin may withdraw another member's credential in the same workspace;
    // everybody else is held to their own.
    const revoked=await authority.revokeCredential(member.role==='admin'?null:identity.subject,workspace.id,credentialId);
    if(!revoked)throw new AgentError('credential_not_found','That credential is not one this workspace can revoke, or it was already revoked.',404);
    return json({revoked:true,credentialId,
      effect:'Revocation is effective on this credential’s next request. Nothing is cached, and nothing already dispatched is undone.'});
  }catch(error){return failure(error);}
});
export const browserReview=route(async(req)=>{
  try{const {identity,member,workspace}=await browser(req,true),input=reviewSchema.parse(await jsonBody(req));
    return json(redact(operationView(await reviewOperation(identity.subject,workspace.id,member.role,input.operationId,input.digest,input.approve),controlOrigin())));
  }catch(error){return failure(error);}
});
export const browserGrant=route(async(req)=>{
  try{const {identity,member,workspace}=await browser(req,true),input=grantSchema.parse(await jsonBody(req));
    const previous=control().journal.getGrant(identity.subject,input.clientId,workspace.id);
    // Revocation must remain available after project/app permissions or OAuth configuration change.
    if(input.revoked){if(!previous)throw new ControlError('grant_not_found','Integration grant not found.',404);const revoked={...previous,revoked:true};control().journal.setGrant(revoked);return json(redact(revoked));}
    const config=oauthConfig(process.env,controlOrigin());
    if(!config)throw new ControlError('oauth_unavailable','Configure the authorization server first.',503);
    if(!input.scopes.includes('read')||member.role==='viewer'&&input.scopes.some(s=>['write','publish'].includes(s)))throw new ControlError('scope_denied','Choose read scope and only operations allowed by your current role.',403);
    if(input.projectIds.some(id=>!db().projects.some(p=>p.id===id&&p.workspaceId===workspace.id)))throw new ControlError('scope_denied','Select projects from this workspace.',403);
    if(input.environmentIds?.some(id=>!db().environments.some(e=>e.id===id&&input.projectIds.includes(e.projectId))))throw new ControlError('scope_denied','Select environments belonging to the selected projects.',403);
    if(input.appIds.length){const {requireOwnedApp,releaseDeps}=await import('@/lib/hosted/release');for(const id of input.appIds){await requireOwnedApp(id,workspace.id);await releaseDeps.requireAppRole(id,identity.subject,'owner');}}
    
    if(!previous&&control().journal.grants(identity.subject,workspace.id).length>=50)throw new ControlError('grant_quota','Revoke or reuse an existing client grant.',429);
    const grant={...input,subject:identity.subject,workspaceId:workspace.id,integrationId:previous?.integrationId??`integration_${randomUUID()}`,
      oauthIssuer:config.issuer,expiresAt:new Date(Date.now()+input.days*86400000).toISOString()};
    control().journal.setGrant(grant);return json(redact(grant));
  }catch(error){return failure(error);}
});
