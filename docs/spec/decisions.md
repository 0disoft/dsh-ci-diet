# Architecture decisions

Each record states the decision and the reason it was made. Reversing one needs a
new record, not an edit to the rationale.

| ADR | Decision | Reason |
| --- | --- | --- |
| ADR-01 | Rules, cost calculation, and patch generation are deterministic core code. | Model explanation is separated from judgement so results are reproducible and reviewable. |
| ADR-02 | One package, with a CLI path that survives independently of the plugin UI. | A DSH API change must not take the whole product down. |
| ADR-03 | 7 days, 100 runs, and 400 dispatches by default, with explicit partial results. | Complete collection and resource caps are different concepts; pretending collection is complete corrupts every derived number. |
| ADR-04 | A durable Attestation and a single-use approval are separate records. | An old premise and a new byte change must each be verified on their own terms. |
| ADR-05 | Applying is forbidden until the file backup is durably stored. | Host KV size must not be the precondition for a revert guarantee. |
| ADR-06 | Nonce, digest, and scope checks apply even to the owner principal. | Owner permission is not a statement of human intent for this specific edit. |
| ADR-07 | No telemetry by default; only user-initiated export. | Private workflow data is never shared outward automatically. |
| ADR-08 | After measurement, enable at most three rules by default. | A small number of valid cases beats a long list of rules. |
| ADR-09 | Actual charge, list price, and time are reported as separate fields. | No money or wait-time saving is announced without evidence. |
| ADR-10 | Limit writes on untested prereleases and unknown policy. | A broad compatibility claim does not replace tested compatibility and safety. |
| ADR-11 | The JSON contracts are mirrored into this repository; only prose fields are localized. | The public repo must build without the private Korean design pack, while structure, enums, hashes, and digests stay identical. Localized pointers are declared in `scripts/sync-contracts.mjs`. |
| ADR-12 | Public documentation is English; Korean is a mirrored README. | Three-language UI validation and translation drift cost more than they return at this stage, and domain terms mistranslate easily. Simplified Chinese remains a translation slot. |
| ADR-14 | Every digest is sha256 over CDJ1 canonical JSON, and the TypeScript types are generated from the committed JSON Schema. | One canonical form keeps pricing hashes, dependency hashes, and plan digests reproducible across CLI, plugin, and tests. Generated types are checked in CI so the schema cannot drift from the code that consumes it. |
| ADR-13 | Rule defaults follow the A0a spike: CD001, CD002, and CD008 are on by default; CD005 stays off until job keys resolve; CD003 stays off until its sample is widened. | Only CD001 and CD008 had enough observable targets, and job rows cannot be attributed to YAML job keys, so a timeout patch could otherwise target the wrong job. The measurement is recorded in `docs/spikes/a0a-rules.md`. |

## Notes

- ADR-03 default numbers are fixed by `examples/default-config.json`; changing
  them changes user-visible behaviour and needs a new ADR.
- ADR-08 means an empty enabled-rule list is never treated as success; the
  release scope record freezes what measurement actually validated.
- ADR-11 permits rewording of the four coverage-level descriptions and two sample
  reasons. It does not permit changing enums, required fields, or any hash input.
  Where the private pack is unavailable, `--check` falls back to
  `contracts/contracts.lock.json`; the lock is regenerated only with an
  intentional, reviewed contract change.
- ADR-13 does not lower CD005's 20-sample write requirement and does not remove
  CD005 from the contract's writable rule set. It changes defaults, not write
  safety. Enabling rules is a runtime setting; `allowedRules` still bounds writes.
- ADR-13 also rests on `evidence/a0a/jobkey.json`: best-effort key recovery
  matched 40.7% of sampled jobs, and the only key-level cohort with 20 samples
  already carried a timeout. Per-matrix cohorting makes the gate rarer still.
- The `src/core/workflow` port replays the same sample at 43.9%
  (`evidence/a0a/parser-verify.json`). Honoring `matrix.include` and `exclude`
  explains the gain; computed matrices still resolve to nothing, so the
  key-recovery ceiling is a data property, not an implementation gap.
- CD004 is on by default although ADR-13 names three history-dependent rules: it
  reads workflow text only, is review-only, and has no write path, so the
  write-safety gate does not apply to it.
- CD005 is revisited only with real history, not with a lowered threshold: after
  five or more users sync 90 days of history, if at least half of those
  repositories produce one or more candidates with no timeout, a cohort of five
  or more samples, and removable minutes above zero, a new ADR may propose the
  5-sample threshold and the larger margin. Otherwise CD005 is removed from the
  v0.1 UI and kept as a v0.2 candidate. The code path stays behind
  `rules.CD005.enabled=false` so re-enabling is a setting, not a rewrite.
- ADR-14 covers `src/shared/cdj1.ts`: object keys sort in ASCII order, arrays keep
  their order, only safe integers are allowed, and keys must be printable ASCII.
  The implementation reproduces the three committed vectors (pricing
  `sha256:acc8d110...`, empty dependency `sha256:81059fe6...`, example plan
  `sha256:d8984479...`). `src/core/contracts/schema.ts` is a structural mirror;
  pattern, length, range, format, and if/then/else constraints are enforced by
  Ajv, not by the types.

## ADR-15: Packaging is one bundle with a single loader entry

- Scope: how the DSH plugin is installed and what it registers.
- Decision: one npm package named `dsh-ci-diet`. `dsh.bundle.patch` points at
  `cordis.patch.yml`, which inserts exactly one entry, `ciDiet.bootstrap`,
  with `networkEnabled` and `localApplyEnabled` both false. The plugin
  registers four tools and no client bundle yet.
- Config is a Schemastery schema. `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-tools`, and `@deepseek-ai/schemastery` stay peers plus
  dev dependencies, so the host owns their instances; `ajv`, `ajv-formats`,
  and `yaml` are regular dependencies.
- Tool output schemas use the value DSL that `defineTool` accepts. Coverage
  and metric rows are flattened to arrays of strings instead of nested
  contract objects, because the model reads them, not the contract validator;
  the full report stays on disk where Ajv validates it.
- The package ships `dist/` only. There is no install-time build and no
  postinstall script.
- Rationale: a single insert entry keeps `dsh --dump-config` honest and makes
  removal a one-line patch revert. Keeping the host packages as peers avoids
  two Cordis or DSH runtime copies in one process.
- Consequence: a peer resolution failure is a host installation problem, not a
  silent fallback. The documentation names the required DSH range.

## ADR-16: v0.1 ships a static HTML report instead of DSH Web screens

- Scope: how a report leaves the machine and is read by a person.
- Decision: `ci-diet report --format html` renders one self-contained HTML file
  from a stored report: inline CSS, no scripts, no external URLs, all dynamic
  text escaped. `ci-diet prune` removes reports, plans, and cache entries past
  their retention windows; backups are never pruned automatically.
- The DSH client screens are deferred. A client plugin can only reach host data
  through `ctx.remote.<namespace>`, and a namespace exists only when a
  host-compiled Typert contribution is mounted with `ctx.remote.$mount`
  (`@deepseek-ai/dsh-api-remotes/lib/client.js` mounts 25 contributions, and
  `dsh-api-gateway/lib/types/client/index.js:88-199` validates strict descriptors
  with a zod codec). Hand-writing that descriptor would depend on a private
  shape, and there is no browser harness in this repository to verify the
  rendering.
- Rationale: a file that opens in any browser delivers the same review and
  sharing value for the v0.1 scope (one repository, one person) without a
  dependency that can break on a DSH patch release. The HTML output is tested
  for escaping and for lacking external references.
- Consequence: the report is read-only and carries no interactive approval.
  Approvals stay in the CLI, which keeps the nonce and digest checks in one
  place. When the client contribution format stabilizes, the screens can render
  the same stored report; no core change is needed.
- Reversal: replacing HTML with Web screens is additive, not a contract change,
  because both read `AnalysisReport` from the local store.

## ADR-17: One eligibility gate decides whether a finding may become a plan

- Scope: who decides that a finding is safe to plan, and what a plan proves.
- Decision: the CLI and `ci_diet_plan` call the same
  `evaluatePatchEligibility` function. It combines the finding's stored
  `patchability`, the rule's coverage composition, the recorded Attestation
  claims, policy freshness for the rules that read account policy, and the
  finding's remaining blockers. Only a finding that passes can be planned, and
  the plan stores whatever blockers remain so apply rechecks them.
- Claims are evaluated, then stored as an Attestation before the plan is built.
  The plan digest binds the attestation id and the policy snapshot hashes, so a
  withdrawn claim or a changed policy voids the plan instead of silently
  inheriting approval.
- Policy freshness is per rule. CD001 depends on branch protection, CD008 on
  artifact retention, and CD005 on neither; a stale unrelated snapshot must not
  block a timeout edit.
- Reports are read through a Binding. A plan resolves the binding for the
  current workspace root and then the latest report for that binding only; it
  never falls back to the newest report in the store.
- Rationale: the previous split between "report says eligible" and "plan builds
  anyway" let a blocked finding reach a draft plan, and the CLI version could
  plan against another repository's report. One gate keeps the model tool and
  the human CLI honest about the same evidence.
- Consequence: a plan request can return exit `3` with named reasons instead of
  a plan. That is the intended outcome, not a failure.
- Reversal: widening the gate means adding an explicit claim or a new policy
  dependency to a rule, never bypassing the gate for one entry point.
## ADR-18: A plan is bound to the finding's target and evidence, not just its rule

- Scope: how a plan chooses the workflow, job, step, and value it edits.
- Decision: plan creation reparses the current workflow, compares its hash to
  the finding's `workflowHash`, reads the target job and step from the
  finding's `evidenceRefs`, and checks the requested value against the
  collected evidence. CD005 minutes must equal a cohort recommendation for that
  job; CD008 must point at an `actions/upload-artifact` step with the proposed
  retention. The CLI and `ci_diet_plan` call the same `targetReasons` function.
- Dependencies are collected at plan time from the workflow's local scripts,
  composite actions, and reusable references, resolved against the step
  `working-directory` (or job/top-level `defaults.run.working-directory`);
  local action directories are hashed as a whole. The resulting
  `dependencyHash` is stored on both the premise and the plan, and a reference
  the scan cannot hash becomes an `UNRESOLVED_DEPENDENCY:<path>` blocker rather
  than disappearing from the list. Interpreter flags are split between boolean
  flags and flags that take a value (`--require`, `--loader`, `--import`,
  `--env-file`); a value that names a repository file is hashed too. Hitting
  the local-action file limit or failing to read a file or directory also
  records an unresolved entry, because a partial directory hash must never
  pass as complete.
- Rationale: rule plus workflow path is not enough identity. Before this
  change, a 20-sample `build` cohort could justify a one-minute timeout on an
  untested `deploy` job, and a report made against older bytes could be planned
  into a workflow that now had `environment: production`.
- Consequence: changing a workflow invalidates its findings until the next
  sync, and a request for another job is refused with `FINDING_NOT_FOUND`
  rather than silently retargeted.
- Reversal: widening a rule's target model is a finding-format change and needs
  a new evidence reference shape, not a bypass in the planner. Dependency
  coverage can be widened by adding a resolver, but never by weakening the
  unresolved-reference blocker.
## ADR-19: Six display languages, translated at render time

- Scope: which languages CI Diet ships and where translation happens.
- Decision: ship en, ko, zh-Hans, hi, es, and fr. English stays the key source
  of truth. Every other dictionary is a complete `Record<MessageKey, string>`,
  so a missing key fails the type check instead of rendering an empty string.
  Regional tags resolve by primary subtag (hi-IN to hi, es-MX to es, fr-CA to
  fr); Chinese tags that are not Simplified (zh-TW, zh-Hant) stay unsupported
  and fall through to English. Selection order is an explicit `--lang`, then
  the DSH locale preference, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English.
  A stored report is never rewritten: rules keep English `title` and
  `renderedText`, and the CLI, HTML report, and DSH tool text localize on
  display. Rule ids, error codes, enum values, file paths, digests, and numbers
  are never translated. The HTML report sets `lang` to the selected locale.
- Rationale: the product has one stored artifact and several readers.
  Translating at display time keeps reports reproducible and lets a Korean and
  an English user share the same report id. Requiring a full dictionary keeps
  coverage honest rather than falling back silently.
- Consequence: adding a message key requires translating it in all six
  dictionaries in the same change. DSH tool descriptions and render templates
  are captured when the plugin loads, so changing the DSH language preference
  needs a reload to affect them.
- Reversal: adding a locale means adding a complete dictionary and a locale
  match case; allowing partial dictionaries would require an explicit coverage
  test instead of the `Record` type.

## ADR-20: Finding.message carries i18n keys as an optional contract extension

- Scope: how a stored finding can be rendered in another language without
  changing its identity or its canonical text.
- Decision: add an optional `message` object to `$defs/Finding` with
  `titleKey`, `textKey`, and scalar `params`. `title` and `renderedText` remain
  required English canonical text. The renderer uses `message` only when both
  keys exist in the English dictionary; otherwise it falls back to the stored
  text. `message` is excluded from the fingerprint and every digest, so report
  ids are stable across translations. The field is listed in `EXTENDED` in
  `scripts/sync-contracts.mjs`, so the frozen design pack must not contain it
  and the repository copy must.
- Rationale: findings are stored in reports and referenced by evidence, so a
  translated title cannot be the only text. A separate sidecar would drift from
  the report; an optional field is visible in the schema and validated by Ajv.
- Consequence: a rule that adds a finding should also add its keys to all six
  dictionaries and a round-trip test. A custom or synthetic finding without
  `message` still renders its stored text.
- Reversal: removing the extension is a schema change with the same review
  process; `contracts.lock.json` is regenerated with the pack check.
## ADR-21: Settings are a Settings page over the public config channel

- Scope: where a person edits the engine settings used by the DSH tools, and what
  that page is allowed to touch.
- Decision: the package ships a Web client half through `exports "./client"` and
  `dsh.client`. It registers one `settings.section` entry, **CI Diet**, in the
  DSH Settings sidebar and renders the analysis rules, history caps, storage
  limits, cost estimate, network switch, and state directory.
- The page reads and writes one `ConfigForm` obtained with
  `ctx.configForms.get("ciDiet.bootstrap")`, the id of the bundle's loader entry.
  `ctx.configForms` is a public settings channel: the host validates the complete
  `Config` contract, merges the change, and refuses a stale revision. The page
  stages edits locally and sends them as one `mutate` batch with the snapshot
  revision; a per-field reset sends `unset`. It shows the scope and the point at
  which a change applies, and it has no apply, approval, or revert controls.
- Every field maps to a live Host `Config` field consumed by the same
  `engineSettingsOf` path the CLI contract uses, so defaults and validation do
  not fork between CLI and plugin. The CLI keeps its own `--config`, which the
  page never writes. `localApplyEnabled` is not exposed because no apply tool
  exists. `stateDir` does not migrate an existing store.
- The page is translated through `ctx.locale` with complete en, ko, zh (also
  registered as zh-Hans), hi, es, and fr dictionaries, per ADR-19. Client text is
  registered when the plugin loads, and a language the host does not ship is
  contributed with an English fallback; a language change needs a reload.
- Rationale: ADR-16 deferred DSH screens because they would read report data
  through `ctx.remote` and a host-compiled Typert descriptor. A settings page
  reads no report data and needs no private remote shape. `configForms` is
  already the public mechanism behind the host-rendered plugin cards, so the
  page adds a surface without inventing a protocol. Keeping the page out of
  apply and approval preserves the single-use approval boundary in the CLI.
- Consequence: ADR-15's "no client bundle yet" and ADR-16's deferral now describe
  only report and apply data screens, which remain deferred. A new engine field
  needs the contract, the host schema, a page descriptor, and six translations in
  the same change. The client bundle is built at pack time into `client/` and
  requires only `react` from the loader; it must not require a Harness Client
  package.
- Reversal: dropping the client export removes the page and leaves the Plugins
  card and CLI untouched. A report screen is still a separate decision under
  ADR-16, not an extension of this page.

## ADR-22: Offline cache plans and deployment preflight

- Decision: enable CD006 by default for the narrowly validated npm workflow
  shape described in [rules](rules.md). Extend the v2 rule vocabulary and
  coverage table explicitly; retain the original design pack and compare all
  non-extended fields. Cache plans need current workflow bytes and pinned root
  manifests, not historical run durations or remote retention/protection data.
- Savings remain unknown until comparable runs measure the cache's benefit.
  Only dependency downloads are cached; installation and tests still execute.
  Plans use the existing human approval, dependency checks, journal and revert.
- Decision: enable an advisory deployment preflight in the DSH stateless bash
  tool. A candidate pauses the first recognized command for that session and
  source fingerprint; a retry is allowed. Users can disable the setting. The
  hook never grants a permission another listener denied, changes a workflow,
  or fetches remote history. Persistent shells and unrecognized command syntax
  are outside its scope because their effective directories are not established.
- Rationale: tools that are only called on request are easy to miss during a
  coding-and-deployment session. A bounded reminder exposes an opportunity at
  the decision point without making an optimization mandatory.

## ADR-23: Report review uses public session and connection RPC channels

- Scope: how report, plan, approval, apply, and revert state reaches a DSH Web
  page, and where human intent is checked.
- Decision: add the **Settings → CI Diet Reports** section. It reads the current
  DSH session from the public `ctx.uiSession.adapter.current` scope binding and calls the public
  `ctx.connection.rpc.call("/api", "ci-diet-review", payload)` channel with
  `load`, `approve`, `apply`, or `revert`. An exact authenticated Fetch route receives the RPC envelope, leaving the Gateway interceptor intact. The connection's `browserPeer` owner
  check is the authorization boundary. The page uses no private Typert
  descriptor. This supersedes ADR-16's deferral for these report and review
  screens; its static HTML report remains supported.
- A load returns the workspace root, binding, `localApplyEnabled`, the latest
  report, plans with diffs and blockers, and applied changes. Results are for
  the current session. A session switch clears visible state, and a generation
  guard discards responses from requests started under an earlier session.
- Approval is a separate human action: the person types the final 12 characters
  of a plan digest. The plan card also shows evidence completeness, source
  validity, blockers, expiry, and diff. Apply is available only for an approved,
  unexpired plan with valid source, no blockers, and `localApplyEnabled` on;
  the host still rechecks all of those conditions. The model tools do not gain
  approve, apply, or revert actions.
- Revert requires typing the exact applied change ID before the explicit revert
  action. The host rechecks the backup and current bytes. Existing approval TTL,
  one-use nonce, policy freshness, dependency hashes, source hashes, backup, and
  lock gates remain authoritative for both writes.
- `localApplyEnabled` is a Connection switch on the existing CI Diet settings
  page and defaults to false. The review page remains read-only when it is off
  and explains how to enable local apply in settings.
- Rationale: the public session observable and connection RPC expose host data
  without a private remote contract, while keeping every write decision on the
  host. Splitting approval from apply gives a person a review point after a
  digest challenge instead of treating a button click as authorization for a
  later file write.
- Consequence: a report-screen change uses the same session-scoped review RPC,
  six complete client dictionaries, and host response state; old ADRs 15, 16,
  and 21 are not rewritten. A failed or refused host result stays visible to the
  user and the page reloads state after the request.
- Reversal: removing the section registration and client export removes this
  UI without changing contracts, stored reports, plans, or CLI behavior.

## ADR-24: DSH defaults are opt-out and migrate once per profile

- Scope: the DSH plugin's first-use switches, default rules, and the upgrade of
  settings saved by older plugin versions. This supersedes the `false`
  `networkEnabled` and `localApplyEnabled` defaults stated in ADR-15 and ADR-23.
  ADR-13's rule-default reasoning remains historical; CD003 and CD005 stay off.
- Decision: `defaultPluginSettings` and the bundle `cordis.patch.yml` set
  `preflightEnabled`, `networkEnabled`, and `localApplyEnabled` to `true`. The
  default rule set is CD001, CD002, CD004, CD006, and CD008. Network access on
  by default permits a user-requested `ci_diet_sync` to run with an authenticated
  `gh`; installation and startup do not call `gh` or collect history. The
  standalone CLI keeps `DEFAULT_CONFIG.networkEnabled=false` and its explicit
  `--network` requirement.
- Migration: a profile whose raw `defaultsRevision` is absent or below `1` is
  migrated when the plugin starts. The plugin locates its own active loader
  entry and calls DSH `configEditor.edit`, so the change is made under the
  editor's profile lock against the latest raw config. The same save sets all
  three switches to `true`, unions the default rules into the existing rule
  list, and writes `defaultsRevision: 1`. The marker lives in the profile, not
  the bundle. State paths, history limits, storage limits and quotas, billing
  inputs, and an existing explicit CD003 or CD005 enablement are preserved. A
  legacy explicit `false` is upgraded once because it predates the revision;
  an explicit `false` or rule exclusion saved after the marker survives later
  restarts and updates. A failed edit keeps the old configuration and remains
  retryable. Billing estimates stay off by default and need explicit activation;
  an existing on setting is preserved.
- Safety: turning local apply on does not approve a plan. Human digest approval,
  separate apply, source and dependency checks, TTL, single-use nonce, policy
  freshness, backup, and lock checks remain authoritative. Model tools still
  have no approve, apply, or revert actions.
- Evidence: the defaults migration was exercised on DSH `0.2.1-rc.2` with its
  `configEditor`, `SettingsForms`, and Loader in a temporary profile. A legacy
  `false` became `true` on disk, and an explicit `false` saved afterward stayed
  false after restart. This runtime check did not add a new browser render
  test. The **CI Diet Reports** approval, apply, and revert UI had already
  passed a real-browser E2E check in an earlier commit.
- Rationale: rules and checks that are only found on request are easy to miss.
  Useful DSH defaults reduce that friction, while a revision marker makes the
  upgrade deterministic and prevents later startup or plugin updates from
  overwriting a deliberate opt-out.
- Consequence: DSH and CLI now have intentionally different network defaults.
  The plugin guide states both contracts, and the first migration's rule union
  can add a default rule that an older profile had excluded. Only settings
  saved after the marker are treated as later user policy.
- Reversal: ship a new higher `defaultsRevision` with a new ADR. Reverting only
  the bundle defaults would not reprocess profiles whose marker is already `1`.
