/** Browser-only consent/approval. It uses live identity verification, not token claims alone. */
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { route, currentRequest } from '@/lib/server/request';
import { db } from '@/lib/db/store';
import { verifyRequestIdentity } from '@/lib/hosted/access/identity';
import { redact } from '../security';
import { ControlError } from './journal';
import { control, requireControl, operationView, reviewOperation } from './runtime';
import { controlOrigin, jsonBody, json, failure } from './boundary';
import { grantSchema, reviewSchema } from './contracts';
import { oauthConfig } from './oauth';
async function browser(req:NextRequest, mutation=false){
  requireControl();
  if(req.headers.has('authorization'))throw new ControlError('browser_required','Use the signed-in Zenith browser interface, not an agent credential.',403);
  if(mutation&&req.headers.get('origin')!==controlOrigin())throw new ControlError('csrf_denied','Submit approvals and grants from the same Zenith origin.',403);
  const identity=await verifyRequestIdentity(req),state=currentRequest();
  if(!identity.emailVerified||!state?.user||state.user.id!==identity.subject||!state.workspace)throw new ControlError('browser_required','Sign in to the target workspace with a verified account.',401);
  const member=db().members.find(m=>m.id===identity.subject&&m.workspaceId===state.workspace!.id);
  if(!member)throw new ControlError('membership_denied','A current workspace member is required.',403);
  return {identity,member,workspace:state.workspace};
}
export const browserGet=route(async(req)=>{
  try{const {identity,member,workspace}=await browser(req),origin=controlOrigin();
    return json(redact({workspaceId:workspace.id,subject:identity.subject,role:member.role,
      grants:control().journal.grants(identity.subject,workspace.id),
      operations:control().journal.reviewQueue(workspace.id,identity.subject,member.role==='admin').map(op=>operationView(op,origin)),
      projects:db().projects.filter(p=>p.workspaceId===workspace.id).map(p=>({id:p.id,name:p.name})),
      oauthConfigured:!!oauthConfig(process.env,origin),resource:`${origin}/api/agent/v2/mcp`}));
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
