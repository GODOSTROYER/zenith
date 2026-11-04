# PROD-CI-05, PROD-CI-08, PROD-CI-09 database fix port

This ports the reviewed database failure fixes from `ad8bd320` onto published `3ed037b9`. Saivedant's current branch and identity override the older other-machine instructions. This port has no runtime result; the earlier passing tests apply only to the earlier candidate.

Ownership transfer persistence now inserts without an immutable-column conflict update and reads only an unrevoked original receipt matching the exact tenant, operation, project/environment, transfer fields, human approval, proposal digest and approval time. A missing, changed or revoked receipt refuses. Trigger definitions and column grants are preserved. The three native service-role cases keep their original names and whole-row preservation controls; browser approval inputs are models, not browser authentication evidence.

The migration inventory retains every wave-2 collection and adds the previously missing ownership transfer table. The distinct-owner schema6 fixture proves DML does not authorize legacy ALTER, then admits only the dedicated incident and runner/machine table owners and the exact provider-connection REFERENCES prerequisite required by published migrations 19, 22 and 25. Owner retention, current-user separation and transaction rollback remain required.

Author checks are source-only. Run the canonical SQL generator with `--check`, compile/lint, execute the changed migration/capability/runbook suites and native ownership suite using canonical agent roles, then run the unchanged strict database/platform gates. Native case registration and shared gate/schema filename prerequisites outside this group remain integration follow-ups. No published platform migration 1–27 or Supabase migration 0001–0020 is edited.
