import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up } from '../../scripts/acceptance/default-stack/up.mjs';
import { readiness } from '../../scripts/acceptance/default-stack/readiness.mjs';
import { verifyDatabase } from '../../scripts/acceptance/default-stack/verify-database.mjs';
import { cleanup, inventory } from '../../scripts/acceptance/default-stack/runtime.mjs';
const enabled = process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK === '1';
if (enabled && !process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR) throw new Error('A new explicitly owned private directory is required for real default-stack acceptance.');
describe.skipIf(!enabled)('genuine default stack, needs Docker, Supabase CLI and POSIX private files', () => {
  let state: Awaited<ReturnType<typeof up>>;
  let cleaned = false;
  beforeAll(async () => { state = await up(process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR!, process.env.ZENITH_DEFAULT_STACK_PROFILE ?? 'default'); }, 3_600_000);
  afterAll(async () => { if (state && !cleaned) await cleanup(state); }, 1_200_000);
  it('observes real API and worker health, HTTPS and verified pooler TLS', async () => {
    const receipt = await readiness(state); expect(receipt.failed).toBe(0); expect(receipt.skipped).toBe(0);
    expect(receipt.apis).toBe(state.profile === 'lean' ? 1 : 2); expect(receipt.workers).toBe(receipt.apis);
  }, 180_000);
  it('applies real Supabase migrations and proves authorization, concurrent transactions and restore readback', async () => {
    const receipt = await verifyDatabase(state); expect(receipt.failed).toBe(0); expect(receipt.skipped).toBe(0);
    expect(receipt.hostedProductionAcceptance).toBe(false); expect(receipt.productRecovery.authorizationPreserved).toBe(true);
  }, 600_000);
  it('leaves zero ownership-labelled Docker resources', async () => {
    const receipt = await cleanup(state); cleaned = true;
    expect(receipt.ownedResourcesRemaining).toBe(0); expect(await inventory(state)).toEqual([]);
    expect(receipt.forcedStops).toBe(0);
  }, 1_200_000);
});
