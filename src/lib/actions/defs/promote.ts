/** Promote an immutable deployed revision using the existing saved-revision deploy path. */
import { z } from 'zod';
import { defineAction, getAction, type ActionContext } from '@/lib/actions/core';
import { requireEnvironment, requireRevision } from './_shared';
const Input = z.object({ environmentId:z.string().min(1), sourceEnvironmentId:z.string().min(1), revisionId:z.string().min(1) }).strict();
type Input = z.infer<typeof Input>;
function target(ctx:ActionContext,input:Input){
  const to=requireEnvironment(ctx,input.environmentId),from=requireEnvironment(ctx,input.sourceEnvironmentId),revision=requireRevision(ctx,input.revisionId);
  if(to.id===from.id||to.projectId!==from.projectId||revision.projectId!==to.projectId||from.deployedRevisionId!==revision.id)
    throw new Error('Promote the exact currently deployed revision from another environment of this project. Refresh the source revision first.');
  return {to,from,revision,args:{environmentId:to.id,toRevisionId:revision.id}};
}
defineAction<Input>({id:'deploy.promote',title:'Promote saved revision',category:'deploy',risk:'high',requiredRole:'editor',mutates:true,input:Input,
  async plan(ctx,input){const resolved=target(ctx,input),plan=await getAction('deploy.rollback').plan(ctx,resolved.args);return {...plan,
    summary:`Promote revision ${resolved.revision.number} from ${resolved.from.name} to ${resolved.to.name}.`,
    details:[`Uses immutable revision ${resolved.revision.id}, never the mutable working copy.`,...plan.details],
    warnings:[...plan.warnings,'Promotion changes the system definition, not application data. Target environment policy still applies.']};},
  async execute(ctx,input){const resolved=target(ctx,input);return getAction('deploy.rollback').execute(ctx,resolved.args);}
});
