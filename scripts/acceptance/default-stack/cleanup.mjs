import { cli, cleanup, readState } from './runtime.mjs';
await cli(async () => {
  if (process.argv.length !== 3) throw new Error('default-stack:usage');
  process.stdout.write(`${JSON.stringify(await cleanup(readState(process.argv[2])))}\n`);
});
