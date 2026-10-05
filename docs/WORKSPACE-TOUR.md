# Workspace tour

This reference preserves the earlier authenticated workspace tour. Its screenshots document the earlier application interface; the current public-site captures are in the [project README](../README.md). Refer to [RUNNING.md](RUNNING.md) and [LIMITATIONS.md](LIMITATIONS.md) for current setup and provider behavior.


### Overview — `/overview`

![Overview screen for the Kepler Labs workspace: an Atlas project card showing $115.50/mo working against $89.50/mo deployed, chips for 18 to deploy and 1 open finding, staging and production environment chips, a staging budget bar showing $115.50 projected of $100.00, and a recent activity column on the right](screenshots/overview.png)

The workspace home. Each project card carries two numbers Zenith refuses to
conflate — what the working copy would cost and what the deployed revision costs
— plus waiting changes, open findings, and a chip per environment showing its
live revision and pending count. The budget meter turns red when the projection
passes the cap, not after the bill arrives.

### System Map — `/p/<project>`

![System map of the atlas project: a route node app.atlas.zenith.app on the left feeding web and worker service nodes, which fan out to sessions, mail, cache, res1, jobs and postgres nodes on the right, edges labelled http, cache, smtp, sql, queue_publish and queue_consume, a res1 node badged "new" with a dashed outline and a jobs node badged "drift", and a pill at the bottom reading "1 pending change · +$26.00/mo · Review"](screenshots/system-map.png)

The centerpiece, and the clearest expression of **a map that cannot lie**:
layout is computed from the graph into three strata — Routes, Services,
Resources, left to right — so nobody can drag a node into a position implying a
topology the manifest does not have. Nodes show status, kind, size and their own
monthly estimate; edges are bindings labelled with the capability they grant.
Undeployed changes render ghosted and dashed (the `new` badge on `res1`), and a
persistent pill counts them with their cost delta and opens the Changes drawer —
the plan-first law made visible: no path from an edit to a deploy skips review.

### Inspector — the right drawer on the map

![The map with the web service selected and an inspector drawer open on the right, showing Config, Env & secrets, Connections 6 and Operations tabs, and fields for name, kind, source, image, size (standard — 1 vCPU · 1024 MB, $28.00/mo est.), replicas, port and health path](screenshots/inspector.png)

Selecting a node opens the inspector: config, environment variables and secret
references, the bindings it participates in, and the operations available on it.
Every field explains itself in one line, every cost-bearing field prices itself
as you type (`$28.00/mo est.`), and no edit applies on blur — it becomes a
pending change with a plan behind it. Controls above the caller's role are
disabled with the reason, never hidden.

### Source — `/p/<project>/source`

![Source screen showing Working copy, Deployed (r5) and Export tabs, a Read/Edit toggle, the counts "157 lines · 2 services · 6 resources · 9 bindings", and the zenith.manifest.json contents with line numbers](screenshots/source.png)

The same manifest the map draws, as JSON you can read, edit and validate.
Working copy and deployed revision sit side by side as tabs, and Export produces
the bundle — manifest, real Terraform, operations README. Saving goes through
`project.updateManifest` like every other mutation, so hand-editing the JSON is
not a back door around plans or the audit trail.

### Deploys — `/p/<project>/deploys`

![Deploys screen: a list of six staging deployments on the left with All / In flight / Finished filters, one failed r3 followed by an r3 retry, and on the right the succeeded r5 detail with PREPARE 3/3, PROVISION 6/6, RELEASE 2/2 and VERIFY 2/2 phase bars, total 22.9s, and every step listed with its duration](screenshots/deploys.png)

Every deployment, in flight or finished, with the actor that started it —
including the Navigator. The detail pane is the durable state machine rendered:
four phases, every step with its real duration, a "What changed" link back to the
changeset. Progress streams over SSE and replays from a sequence number, so a
refresh mid-deploy resumes rather than restarts. A failed step marks the rest
skipped and offers rollback — disabled, with the reason, on a first deployment.

### Revisions — `/p/<project>/revisions`

![Revisions screen listing five revisions newest first, each with its change summary, actor and time, r5 marked "live in staging", five per-row icon actions, and a footer note that revisions are append-only](screenshots/revisions.png)

Every deployed definition, append-only, with any two comparable. Each row can be
compared with the one before it, viewed as JSON, loaded into the working copy,
promoted to another environment, or rolled back to — and the last two show the
plan first. The footer is the honesty law in one sentence: deploying an earlier
definition never deletes history and **never restores data written since**.

### Observe — `/p/<project>/observe`

![Observe screen with a Health card marked simulated showing web and worker replicas and latency with Scale and Restart controls, a Drift card marked simulated reporting that jobs is size standard where the revision says small, an Application logs panel marked simulated and streaming, and a Cost card marked simulated reading $89.50 est. per month with the note that the working copy would make it $115.50](screenshots/observe.png)

Health, drift, application logs, cost and alerts for one environment, stacked as
cards. Health reads the same inputs the alert evaluator does, so a health card
and an alert can never disagree. Drift compares the deployed revision against
what the provider's `observe()` actually finds — real against LocalStack, seeded
and labeled against the sandbox, a refusal against AWS Preview, which names
`terraform plan` as the honest way to see drift today. Note how many `simulated`,
`synthetic` and `estimate` chips this one screen carries: that is the point.

### Security — `/p/<project>/security`

![Security screen with severity and fix-type filters, Export JSON, CSV and Fix all buttons, and one open low-severity finding, "production has no monthly budget", offering a $145/mo budget as a $0.00/mo est., low risk fix with Fix and Dismiss buttons](screenshots/security.png)

Findings derived from the manifest, filterable by severity, environment and
whether a one-click fix exists. A fix is not a special code path — it is a
registered action with its own plan, cost and risk, which is why the row can
state `$0.00/mo est.` and `low risk` before you press it, and why a fix that
would be refused is never offered. Findings can be resolved, dismissed with a
reason, or reopened.

### Activity — `/p/<project>/activity`

![Activity screen reading "8 actions loaded · that is the whole trail", with CSV and JSON export, filters for Everyone / People / Navigator / System, action and result pickers and a date range, and rows grouped by day showing the action sentence, action id, actor and a Succeeded result chip](screenshots/activity.png)

The audit trail: one row per action, human and agent in the same list, each with
its action id, actor, recorded input and result. The header says exactly how much
of the trail is loaded rather than implying it is everything, and separates the
filters that query the whole log from the search that only reads what is loaded.
A Navigator step and a click are indistinguishable here except for the actor —
the property that makes the agent safe to run at all.

### Navigator — `/p/<project>/navigator`

![Navigator screen showing a "deterministic planner" chip, an autonomy dial with observe, plan, approve, bounded and autonomous levels set to L5 autonomous, a card offering to plan the fix for one security finding, a goal input reading "Tell the Navigator what you want…" with a Plan button, and a list of earlier runs](screenshots/navigator.png)

State a goal in plain language; the Navigator turns it into a list of registered
actions with rationale, risk and cost, and executes them under an autonomy dial
with five levels — observe, plan, approve, bounded, autonomous. The chip reads
`deterministic planner` because that is what runs without `ANTHROPIC_API_KEY`;
with a key it reads `language parsing · <model>`, and each run still says which
half read the goal. Steps obey each environment's approval policy, land in the
audit trail, and a run whose steps outrank the person who pressed Run is refused.
Nothing here can do anything you could not do yourself from the map.

Gimbal is the Navigator's quiet visual companion: a simplified face at the
center of three gyroscope rings. A surrounding glow communicates planning
(purple), awaiting approval (yellow), applying (blue), verified (green), or
blocked (red), alongside a plain-text status. The rings explore while planning,
hold a concentric alignment for approval, coordinate while applying, and adopt
an interrupted pose when blocked. Transitions preserve their orientation.
Hover and tap add a glance or greeting, including in the SVG fallback.
The procedural renderer pauses offscreen, respects reduced motion, and caps
rendering at 30fps (20fps in low-power mode). Motion settings retain the canvas;
a GPU failure gets one retry before keeping the functional fallback. Visit
[`/gimbal`](http://localhost:3400/gimbal) for the interactive preview.

Green requires recorded, fresh provider evidence, not merely successful actions.
Whole-run verification currently covers deployment-only workflows (optionally
with planning/investigation) targeting LocalStack's managed S3/SQS subset with
default configuration and no services, routes, or bindings. Read-only checks
confirm intended resource presence and removals, and remain available in run
history. Sandbox simulations and unsupported or incomplete checks stay neutral;
failed provider checks show blocked. This verifies local emulation, not real AWS.

### Settings — `/p/<project>/settings`

![Settings screen with a section nav reading Workspace, Members, Environments, Connections, Secrets, Alerts, Export and Danger zone; the Workspace section offers a rename with a "Preview and rename" button, and the Members section lists one admin member with a role picker and a note about Supabase app_metadata role claims](screenshots/settings.png)

Eight sections on one scrolling page. **Workspace** renames through a plan like
anything else, and says the slug will not change so links keep working.
**Members** shows who is in the workspace, what each role may do, and how invites
and operator-set Supabase role claims interact. **Environments** covers rename,
clone, region, budgets and approval policies; **Connections** lists the exact
permissions each one holds; **Secrets** is the reference-only view of the
encrypted store; **Alerts** holds the workspace's webhook, Slack and email
delivery channels (the rules that use them live on Observe); **Export** is the
take-it-and-leave bundle. The **Danger zone** deletes the project — admin only,
typed-name confirmation, a plan listing the exact counts that go, a plain
statement that nothing in your cloud is torn down, and a refusal while a
deployment is in flight.
