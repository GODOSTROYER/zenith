# Linking a coding agent to a Zenith account

You install a small plugin in Claude Code or Codex, it shows you a link and an
eight-character code, you sign in to Zenith and approve, and the agent comes
back with a scoped credential. From then on it can read your projects, propose
changes, and — once you approve each change in the browser — dispatch them.

This document is the whole flow: what each side does, what the approval screen
is asking you, what the credential can and cannot do, and how to take it away.

> **Phase 1 deploys are simulated.** The `sandbox` provider invents its
> infrastructure; every URL it produces is flagged `simulated: true` and the UI
> labels it. Nothing here deploys to AWS, and LocalStack is not enabled.

---

## 1. The flow, once, in order

| | who | what happens |
|---|---|---|
| 1 | you | `zenith login` in the terminal (your agent will run it for you if you ask it to connect) |
| 2 | the plugin | `POST /api/agent/link/start` with a client descriptor and **no credential** |
| 3 | Zenith | answers a **device code** (a secret the plugin keeps), a **user code** (eight characters, shown to you), a verification URL and a poll interval |
| 4 | the plugin | prints the URL and the code, tries to open a browser, and starts polling |
| 5 | you | open `https://tryzenith.cloud/agent/link?code=ABCD-EFGH`. Signed out, you land on `/login` and come straight back — the redirect carries the code |
| 6 | you | read the screen, pick a workspace and at least one project, choose scopes and an expiry, press **Approve** |
| 7 | Zenith | in one transaction: the code moves `pending → approved` and a credential row is written. **Nothing is returned to the browser** |
| 8 | the plugin | its next poll exchanges the device code for the bearer, once, and prints the granted scope — never the token |
| 9 | you | the agent is listed under **Integrations → Linked agents**, with a **Revoke** button |

The device code and the issued bearer never appear in a URL, and neither is
ever logged. The *user* code does appear in the verification URL: it is not a
credential, it expires in ten minutes, and it is useless to anyone who cannot
sign in to your account and approve it.

---

## 2. The approval screen, field by field

The screen at `/agent/link` is the only place consent is given, so it is worth
knowing exactly what each part means.

**The code.** Shown in the same `ABCD-EFGH` form the terminal shows. Compare
them. If they differ, something other than the terminal in front of you started
this request — deny it.

**The client.** "Claude Code", a version, and a label such as your hostname.
All three are **strings the program supplied**. The screen says so in those
words, and Zenith does not verify any of them. A program can call itself
anything; what you are really deciding is whether *you* just started a link.

**Workspace.** Every workspace you are a live member of. The credential is
scoped to exactly one.

**Projects.** At least one is required — there is no "all projects, forever"
option. "Select all current projects" writes down the project ids **as they are
now**; a project created tomorrow is not included.

**Scopes.**

| scope | default | what it allows |
|---|---|---|
| `read` | **on, and locked** | the thirteen read capabilities: manifests, environments, deployments, revisions, findings, costs |
| `plan` | on | preparing a proposal — a plan, a cost estimate and a digest. Executes nothing |
| `write` | on | dispatching a change **you have already approved in the browser** |
| `logs` | off | deployment logs. Redaction is conservative, not a secret detector: treat logs as sensitive |
| `export` | off | bulk export of project data |
| `publish` | off | hosted-app publishing. Phase 1 does not collect app ids, so a linked credential cannot publish even with this on |

A `viewer` cannot select `write` or `publish` — the same rule the Integrations
screen already applies to OAuth grants.

**Expiry.** The default is **30 days** and 30 days is also the hard ceiling,
enforced twice: once in the approve handler and again by `parseCredentials`
(`src/lib/agent-access/security.ts`), which refuses any record whose lifetime
exceeds it. Shorter means re-linking more often; that is the only trade.

**Approve / Deny.** Approving issues a credential. It does **not** deploy
anything: every change the agent proposes is reviewed again, by digest, on
`/integrations` before it runs. Deny is a real answer — the terminal is told
`access_denied` rather than being left to time out.

---

## 3. What a linked credential can and cannot do

**Can**

- Read everything inside its workspace, and only the projects it names.
- Prepare a change: a plan, a cost estimate, a target and a digest, written to
  the agent journal as an *intent* with nothing dispatched.
- Dispatch a change **after** a signed-in human approved that exact digest in
  the browser.
- Report an operation's outcome, including the honest one — see `uncertain`
  below.

**Cannot**

- Approve its own proposal. Every browser endpoint refuses a request that
  carries an `authorization` header at all, before it looks at anything else.
  A "yes" typed into a chat window is not an approval and the server does not
  accept one.
- Reach another workspace, or a project outside its list. Both are rechecked at
  execution, not only at issue.
- Read or write a secret value. Secrets are `vault:` references everywhere,
  unchanged by this feature.
- Run an arbitrary action. Twenty-one typed actions exist; there is no
  "run this SQL", no member administration, and no policy relaxation.
- Publish a hosted app, in phase 1: the link flow collects no app ids, so the
  ownership check refuses.
- Survive revocation. Revoking takes effect on the credential's **next**
  request; there is no token cache to invalidate.

**`uncertain` is a real outcome.** If Zenith dispatched an action and then
could not confirm the result — the instance was killed, the write lost a
version guard, the approver's role changed mid-flight — the operation is
reported as `uncertain` and is **never** retried automatically. The agent is
told to inspect the linked deployment rather than to try again, and the
Integrations screen shows the operation with its evidence so a human can close
it. That is the honest answer, and it is preferred to a silent replay that
might do the same thing twice.

---

## 4. Revoking, and what else stops a credential

Three things end a credential, and only the first is instant:

1. **Revoke** on Integrations → Linked agents. The row keeps its history and
   shows as *revoked* rather than vanishing. A workspace admin may revoke
   another member's credential in the same workspace.
2. **Expiry.** Whatever you chose, at most 30 days.
3. **Losing membership.** Every request rechecks that the subject is still a
   live member of the workspace; removal denies immediately.

Turning the feature off entirely is an operator action: unset
`ZENITH_AGENT_CONTROL` and redeploy. Every issued credential stops working and
no data is deleted (`docs/HOSTED-POSTGRES.md` §9).

---

## 5. Where the credential lives

| | hosted Zenith (`ZENITH_STORE=postgres`) | local `next dev` (file store) |
|---|---|---|
| credentials | `agent.agent_credentials` | the version-1 JSON file at `ZENITH_AGENT_CREDENTIAL_FILE` |
| link codes | `agent.agent_link_codes` | a sibling `link-codes.json` in the same 0700 directory |
| atomicity | one Postgres transaction | an operator lock file around read-modify-write |
| Windows | works | **refused** — `loadCredentials()` does not accept a credential file on `win32`, so `zenith login` against a local Windows dev server answers `link_unavailable` and points at `scripts/agent-credential.mjs` |

The secret is stored only as `sha256(token)`; the token itself exists in the
response to exactly one poll and nowhere else. Between approval and that poll
it is held encrypted in `secret_ct` with the application secret key, and the
statement that hands it over is the same statement that sets that column to
null. Without `ZENITH_SECRET_KEY` the link endpoints answer `503
link_unavailable` rather than storing anything in the clear.

The selector is `ZENITH_STORE`, not a flag of its own: a credential names a
subject who must be a live member, membership lives in the product store, and
an install whose product store is Postgres while its credentials sat in a local
file would authenticate against a `/tmp` file that no other instance has ever
seen.

---

## 6. Rate limits and abuse controls

| surface | key | window | limit |
|---|---|---|---|
| `POST /api/agent/link/start` | the client address, salted and hashed | 60 s | 5 |
| the same | the same | 1 h | 40 |
| `POST /api/agent/link/token` | the device code | per request | one poll per `interval`; too fast answers `slow_down` |
| the same | the client address | 60 s | 30 |
| `GET /api/integrations/agent/link` | the signed-in subject | 60 s | 20 |
| failed user-code lookups | the code row itself | lifetime | 5, then the code is expired and you re-run `zenith login` |

The user code is eight characters over a 28-symbol alphabet (Crockford base32
without `I`, `L`, `O`, `U`) — about 38 bits. With five starts per minute per
address, a ten-minute lifetime and five failed lookups per code, guessing one
is not a viable path. The numbers are written down here so that a future change
can be checked against them.

---

## 7. OAuth is unaffected

A bearer starting `za_` goes to the credential authority. Anything else goes to
the OAuth resource-server path, exactly as before. Both can be enabled on one
install; the Integrations screen lists linked agents and OAuth grants in
separate sections with separate revoke controls, and `zenith remote-config`
still emits the OAuth configuration.

On a Postgres install the OAuth grant table is **not** ported in phase 1, so a
non-`za_` bearer answers `503 oauth_unavailable`. That is a truthful refusal,
not a fallback.

---

## 8. Verifying it works

Two scripts prove the journey rather than describing it:

```bash
npm run agent:acceptance   # link → approve → exchange → prepare → review → execute → the canvas
npm run agent:browser      # the approval screen itself, in a real Chrome, at 380px and 1280px
```

Both pin their own `ZENITH_DATA`, own their ports, and seed their own
workspace. `agent:acceptance` stands up a loopback server in front of the real
route handlers and a loopback double for the **identity provider only** —
nothing inside `src/**` is mocked. `agent:browser` starts a real `next dev` and
fails, rather than skipping, when no browser is installed.

Both refuse to run on Windows with exit code 2, for the `loadCredentials()`
reason in §5. CI's `agent` job runs them on Linux.

`agent:acceptance` also tees its own stdout and stderr — the application's log
lines included — and its last check greps that transcript for `za_` and `zl_`
values. So ACCEPTANCE L5 ("no token and no device code in any log line") is a
result of the run rather than a claim about it, and the run fails if anything
inside `src/**` ever starts printing one. `tests/agent-journey.test.ts` does
the same for the bodies it reads: `read()` returns them redacted, so no vitest
assertion message can carry a credential into CI output.

The database side of the same story is
`tests/agent-link/pg-contract.test.ts` and
`tests/agent-control/pg-contract.test.ts`, which run in CI's `postgres` job
against a real PostgreSQL with `supabase/migrations/0001`–`0007` applied.

---

## See also

- [AGENT-CONTROL.md](AGENT-CONTROL.md) — the reviewed-change surface a linked
  agent uses, and what is and is not proven about it on each topology.
- [AGENT-READER.md](AGENT-READER.md) — the read-only v1 endpoint.
- [HOSTED-POSTGRES.md](HOSTED-POSTGRES.md) §9 — the operator runbook for the
  `agent` schema, and the rollback.
- [RUNNING.md](RUNNING.md) — the `ZENITH_AGENT_*` variables.
