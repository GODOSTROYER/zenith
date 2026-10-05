# Cleanup trigger record-field failure port

Append-only platform migration 29 ports the reviewed cleanup trigger repair, preserving its SQL checksum. It enters the grant family branch before PostgreSQL resolves `NEW.audience` and `NEW.jti`; plan-use rows do not contain those fields. The grant predicate and its SQLSTATE23514 refusal, held-plan guard, owner/lease checks, delivery history and operation-before-coordinator order are unchanged.

Published platform1–27 and Supabase0001–0020 stay byte-exact. The new current snapshot is `supabase/migrations/0021_platform_core.sql`, containing the full existing registry followed by28/29. The original native100 success belongs to the prior e94 candidate and is not acceptance of this port.

Source checks include historical-file equality, the exact prior SQL text, registry/snapshot/doc checksum parity, and private forward/reverse patch checks. Compiler/lint, actual current-source native100 and all strict whole-lane checks remain root-owned and unrun here. Gate/schema count and SQL filename expectations outside the owned database group are follow-ups; no cleanup authority or required identity is waived.
