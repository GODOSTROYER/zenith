/** Testable transaction coordinator. Application authority and provider logic stay behind the port. */
import { Journal, ControlError, checkTarget, type Operation, type Principal, type Proposal } from './journal';
export interface ControlPort {
  gate<T>(work: () => Promise<T>): Promise<T>;
  scope<T>(who: Principal, work: () => Promise<T>): Promise<T>;
  identify?(input: unknown): { requestKey: string; clientInputDigest: string };
  proposal(who: Principal, input: unknown): Promise<Proposal>;
  fingerprint(who: Principal, operation: Proposal): Promise<string>;
  authorize(who: Principal, operation: Proposal): Promise<void>;
  execute(who: Principal, operation: Operation): Promise<{ ok: boolean; [key: string]: unknown }>;
  flush(): Promise<void>;
}
export class Coordinator {
  constructor(readonly journal: Journal, private readonly port: ControlPort) {}
  async prepare(identity: Principal | (() => Promise<Principal>), input: unknown): Promise<Operation> {
    return this.port.gate(async () => {
      const who = typeof identity === 'function' ? await identity() : identity;
      return this.port.scope(who, async () => {
      const intent = this.port.identify?.(input);
      const previous = intent ? this.journal.findRequest(who, intent.requestKey) : undefined;
      if (previous) {
        checkTarget(who, previous.target, 'plan');
        if (previous.clientInputDigest !== intent!.clientInputDigest) throw new ControlError('idempotency_conflict', 'This request key belongs to different inputs.');
        await this.port.authorize(who, previous);
        return previous;
      }
      const proposal = await this.port.proposal(who, input);
      await this.port.authorize(who, proposal);
      return this.journal.prepare(who, proposal);
      });
    });
  }
  async execute(freshIdentity: () => Promise<Principal>, operationId: string): Promise<Operation> {
    return this.port.gate(async () => {
      // Re-authenticate after waiting for other callers. Revocation/expiry cannot be hidden by queueing.
      const who = await freshIdentity();
      return this.port.scope(who, async () => {
        const op = this.journal.get(who, operationId);
        checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write');
        await this.port.authorize(who, op);
        const fingerprint = await this.port.fingerprint(who, op);
        const claim = this.journal.claim(who, operationId, fingerprint);
        if (!claim.claimed) return claim.operation;
        try {
          const result = await this.port.execute(who, claim.operation);
          await this.port.flush(); // durable app state BEFORE reporting durable dispatch completion
          return this.journal.finish(op.id, result, result.ok);
        } catch {
          // The external side effect may have happened. Persist ambiguity; never claim rollback or retry.
          this.journal.uncertain(op.id);
          throw new ControlError('outcome_uncertain', `Operation ${op.id} may have been accepted. Inspect it before taking another action.`, 503);
        }
      });
    });
  }
}
