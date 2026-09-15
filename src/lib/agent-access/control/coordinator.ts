/** Testable transaction coordinator. Application authority and provider logic stay behind the port. */
import { ControlError, checkTarget, digest, type AgentJournal, type Operation, type Principal, type Proposal } from './journal';

/**
 * The application-side facts that decide whether this principal may finalize
 * this operation — and *only* those.
 *
 * The digest taken before dispatch is compared with the one taken after, so
 * anything in here that the operation itself changes reports a successful
 * publish or rollback as `outcome_uncertain`: the app row's `updatedAt`,
 * `activeReleaseId` and `activeFence` all move during activation, and the
 * operator is then told to investigate a non-event while the journal keeps a
 * permanent `uncertain` row. Target *state* is the fingerprint's job
 * (`fingerprint()` above, rechecked before dispatch); authority is this one's.
 *
 * So: identity, tenancy, role and revocation. Nothing the action writes.
 */
export interface ApplicationAuthority {
  /** The acting member: who they are, where, and with what role. */
  member?: { id: string; workspaceId: string; role: string };
  /** The app the operation targets, as an authority object — never its release pointers. */
  app?: { id: string; workspaceId: string; state?: string };
  /** The app-role grant that admits this principal, and whether it is still live. */
  grant?: { id: string; subject: string; role: string; revokedAt?: string | null };
  /** The approver's standing, when the operation was approved by a human. */
  approver?: { id: string; workspaceId: string; role: string } | null;
}

export interface ControlPort {
  gate<T>(work: () => Promise<T>): Promise<T>;
  scope<T>(who: Principal, work: () => Promise<T>): Promise<T>;
  identify?(input: unknown): { requestKey: string; clientInputDigest: string };
  proposal(who: Principal, input: unknown): Promise<Proposal>;
  fingerprint(who: Principal, operation: Proposal): Promise<string>;
  authorize(who: Principal, operation: Proposal): Promise<void>;
  /**
   * Current application membership/app-role authority, as facts.
   *
   * Preferred over `applicationAuthorizationDigest`: the coordinator narrows
   * these to the authorization-relevant fields and digests them itself, so a
   * port cannot accidentally bind the finalisation check to state the operation
   * mutates. A port that supplies both is read through this one.
   */
  applicationAuthority?(who: Principal, operation: Proposal): Promise<ApplicationAuthority>;
  /**
   * Digest of current application membership/app-role authority.
   *
   * Legacy shape: whatever the port hashes is what the check binds to, volatile
   * fields included. Implement `applicationAuthority` instead.
   */
  applicationAuthorizationDigest?(who: Principal, operation: Proposal): Promise<string>;
  execute(who: Principal, operation: Operation): Promise<{ ok: boolean; [key: string]: unknown }>;
  flush(): Promise<void>;
}

/**
 * One digest of the authorization-relevant facts, taken the same way before and
 * after dispatch. Absent fields are absent from the hash, so a port that
 * supplies less is not silently equal to one that supplies more.
 */
export const applicationAuthorityDigest = (authority: ApplicationAuthority): string =>
  digest({
    member: authority.member
      ? { id: authority.member.id, workspaceId: authority.member.workspaceId, role: authority.member.role }
      : undefined,
    app: authority.app
      ? { id: authority.app.id, workspaceId: authority.app.workspaceId, state: authority.app.state }
      : undefined,
    grant: authority.grant
      ? {
          id: authority.grant.id,
          subject: authority.grant.subject,
          role: authority.grant.role,
          revokedAt: authority.grant.revokedAt ?? null,
        }
      : undefined,
    approver: authority.approver
      ? {
          id: authority.approver.id,
          workspaceId: authority.approver.workspaceId,
          role: authority.approver.role,
        }
      : authority.approver,
  });
/**
 * The transaction coordinator, over whichever journal this deployment has.
 *
 * `AgentJournal` rather than the SQLite class: a Postgres journal answers over
 * a network and no amount of care makes a round trip a return value. Every
 * journal call below is therefore awaited. Nothing else about the sequence
 * moved — the digest binding, the fence-guarded finalize, `uncertain` on any
 * dispatch failure, the self-approval refusal and the expiry checks are the
 * same statements in the same order, and on the file store `await` on
 * `SqliteAgentJournal` resolves without yielding to anything the journal
 * itself does.
 */
export class Coordinator {
  constructor(readonly journal: AgentJournal, private readonly port: ControlPort) {}
  /**
   * The application-authority digest this operation is finalized against.
   *
   * Taken identically before and after dispatch, and narrowed here rather than
   * in the port, so the comparison can only ever be about authority — never
   * about state the operation itself just wrote.
   */
  private async applicationDigest(who: Principal, operation: Proposal): Promise<string | undefined> {
    if (this.port.applicationAuthority)
      return applicationAuthorityDigest(await this.port.applicationAuthority(who, operation));
    if (this.port.applicationAuthorizationDigest)
      return this.port.applicationAuthorizationDigest(who, operation);
    return undefined;
  }
  async prepare(identity: Principal | (() => Promise<Principal>), input: unknown): Promise<Operation> {
    return this.port.gate(async () => {
      const who = typeof identity === 'function' ? await identity() : identity;
      return this.port.scope(who, async () => {
      const intent = this.port.identify?.(input);
      const previous = intent ? await this.journal.findRequest(who, intent.requestKey) : undefined;
      if (previous) {
        checkTarget(who, previous.target, 'plan');
        if (previous.clientInputDigest !== intent!.clientInputDigest) throw new ControlError('idempotency_conflict', 'This request key belongs to different inputs.');
        await this.port.authorize(who, previous);
        return previous;
      }
      const proposal = await this.port.proposal(who, input);
      await this.port.authorize(who, proposal);
      return await this.journal.prepare(who, proposal);
      });
    });
  }
  async execute(freshIdentity: () => Promise<Principal>, operationId: string): Promise<Operation> {
    return this.port.gate(async () => {
      // Re-authenticate after waiting for other callers. Revocation/expiry cannot be hidden by queueing.
      const who = await freshIdentity();
      return this.port.scope(who, async () => {
        const op = await this.journal.get(who, operationId);
        checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write');
        await this.port.authorize(who, op);
        const fingerprint = await this.port.fingerprint(who, op);
        const applicationAuthorizationDigest = await this.applicationDigest(who, op);
        const claim = await this.journal.claim(who, operationId, fingerprint, applicationAuthorizationDigest);
        if (!claim.claimed) return claim.operation;
        try {
          const result = await this.port.execute(who, claim.operation);
          await this.port.flush(); // durable app state BEFORE reporting durable dispatch completion
          // Authorization may have been revoked while the action was in flight.
          // The side effect is now ambiguous from the caller's perspective, so
          // refuse to finalize it as success and let the uncertainty path fence
          // retries.
          const current = await freshIdentity();
          if (current.subject !== who.subject || current.workspaceId !== who.workspaceId)
            throw new ControlError('identity_changed', 'The authorized identity changed during dispatch.', 403);
          let currentApplicationAuthorizationDigest: string | undefined;
          await this.port.scope(current, async () => {
            checkTarget(current, claim.operation.target, claim.operation.action.startsWith('app.') ? 'publish' : 'write');
            await this.port.authorize(current, claim.operation);
            currentApplicationAuthorizationDigest = await this.applicationDigest(current, claim.operation);
          });
          // `return await`, not `return`: the finalize's own refusals — a stale
          // fence, an expired plan, a membership or role that moved — have to be
          // caught by the `catch` below and turned into `uncertain`, exactly as
          // they were when this call was synchronous. Returning the promise
          // unawaited would let them escape the try block as themselves.
          return await this.journal.finishIfValid(current, op.id, result, result.ok, currentApplicationAuthorizationDigest);
        } catch {
          // The external side effect may have happened. Persist ambiguity; never claim rollback or retry.
          // Awaited, not fired and forgotten: on Postgres the row is only
          // ambiguous once the write has actually landed, and a journal that
          // refuses here must surface its own failure exactly as it did when
          // this call was synchronous.
          await this.journal.uncertain(op.id);
          throw new ControlError('outcome_uncertain', `Operation ${op.id} may have been accepted. Inspect it before taking another action.`, 503);
        }
      });
    });
  }
}
