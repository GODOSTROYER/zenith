# Human Kubernetes action bridge, 2026-10-05

The actual combined PostgreSQL successor had one failure in the action mapping coverage assertion. The new `connection.createKubernetes` and `connection.verifyKubernetes` actions are deliberately human-only. Their current admin/editor membership checks and native capture authority are part of the accepted onboarding contract; neither action belongs in the integration or Navigator capability map.

This test-only correction adds exactly those two IDs to the complete explicit unmapped list. The same coverage case checks both registered mutating definitions, their exact required roles and their absence from the capability map. The existing unmapped-agent negative now checks both exact IDs for Navigator and integration principals, with persistence requested, and verifies that no operation was stored. All previous case names, mapped capability checks, unknown-action refusal, secret suppression and foreign/policy negatives remain.

The prepared dependency is the exact read-only root60 tree `479d5284346e6b1e880760e74cf452584e94c1a7` over clean8ee. Production definitions, role checks, action bridge, map, broker, canonical gate and all other files remain unchanged. The original `2734 passed, 1 failed, 8 skipped` report stays failed. No author imports, compiler/lint, tests, installation, services, PostgreSQL, Docker, staging or commits ran. Independent review and root-owned affected action-bridge and coherent mandatory gate verification are required; source hashes do not establish runtime acceptance.

This correction grants no agent capability, Kubernetes authority, browser/default topology or live cluster permission. The cleanup journey investigation is separate and requires its own approved ownership before source changes.
