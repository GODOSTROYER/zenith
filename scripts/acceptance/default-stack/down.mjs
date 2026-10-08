import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, readState, cli } from './runtime.mjs';
export const down = directory => cleanup(readState(directory));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(async () => {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('default-stack:down-usage');
  await down(directory);
});
