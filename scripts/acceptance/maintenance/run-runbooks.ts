import { registeredRunbookAcceptance } from "./runbooks";
registeredRunbookAcceptance().then(receipt => { process.stdout.write(JSON.stringify(receipt) + "\n"); }).catch(() => {
  process.stderr.write("J4 registered runbook acceptance failed; retain the owned local fixture for inspection.\n");
  process.exitCode = 1;
});
