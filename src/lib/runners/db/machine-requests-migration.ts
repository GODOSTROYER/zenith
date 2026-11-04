/**
 * The zenithd request queue's schema now ships as platform migration 3
 * (`src/lib/controlplane/db/migrations/0003_machine_requests.ts`); this
 * re-export keeps the runner module's existing import path.
 */
export { migration0003MachineRequests as migrationMachineRequests } from "@/lib/controlplane/db/migrations/0003_machine_requests";
