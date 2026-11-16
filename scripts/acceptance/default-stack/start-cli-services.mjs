const healthTimeoutMs = 180_000;
const healthPollMs = 1_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = id => { throw new Error(`default-stack:${id}`); };

/** Restart the owned lean Supabase CLI services only after the database is healthy. */
export async function startLeanCliServices({ projectId, serviceNames, docker, now = () => performance.now(), pause = sleep }) {
  const database = `supabase_db_${projectId}`;
  if (!Array.isArray(serviceNames) || !serviceNames.includes(database) || typeof docker !== 'function') fail('supabase-db-start-plan');

  await docker(['start', database]);
  const deadline = now() + healthTimeoutMs;
  while (true) {
    if (now() >= deadline) fail('supabase-db-health-timeout');
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', database]));
    if (now() >= deadline) fail('supabase-db-health-timeout');
    const health = state?.Health?.Status;
    if (state?.Running === true && health === 'healthy') break;
    if (state?.Running !== true || state?.Status === 'exited' || state?.Status === 'dead') fail('supabase-db-exited');
    if (health === 'unhealthy') fail('supabase-db-unhealthy');
    if (health !== 'starting') fail('supabase-db-health-unknown');
    const remaining = deadline - now();
    if (remaining <= 0) fail('supabase-db-health-timeout');
    await pause(Math.min(healthPollMs, remaining));
  }

  const remainingServices = serviceNames.filter(name => name !== database);
  if (remainingServices.length) await docker(['start', ...remainingServices]);
}
