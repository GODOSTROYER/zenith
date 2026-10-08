import { defaultMaintenanceAcceptance } from "./default";
defaultMaintenanceAcceptance().then(receipt => { process.stdout.write(JSON.stringify(receipt) + "\n"); }).catch(() => {
  process.stderr.write("J4 maintenance acceptance failed; retain the owned local database/namespace for inspection.\n");
  process.exitCode = 1;
});
