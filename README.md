<p align="center"><img src="docs/assets/readme-banner.svg" alt="CI Diet" width="820"></p>

# CI Diet

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-Hans.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Français](README.fr.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ci-diet"><img src="https://img.shields.io/npm/v/dsh-ci-diet.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <a href="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml"><img src="https://github.com/0disoft/dsh-ci-diet/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

**Find likely wasted GitHub Actions runner time, keep the evidence, and turn small fixes into plans for human review.**

CI Diet is an alpha CLI and DeepSeek Harness (DSH) plugin. It reads workflow definitions and, when enabled, GitHub Actions history; then it shows findings and prepares narrow YAML edits without changing a workflow on its own.

## Install

The CLI requires Node `^22.19.0 || >=24.0.0`. This is the current npm release, `0.5.2`.

```bash
npm install --global dsh-ci-diet@0.5.2
ci-diet --version
dsh plugin --profile web add dsh-ci-diet@0.5.2
dsh --profile web
```

The plugin registers DSH tools plus the **Settings → CI Diet** and **CI Diet review** screens. Installation alone does not scan a repository, save runner minutes, or modify a workflow. If you skip the global CLI install, use `npx dsh-ci-diet@0.5.2` in place of `ci-diet`.

## First scan and history

Run these commands from the repository you want to inspect. The static scan is offline and saves its report. History sync is a separate network step that reads recent runs and jobs through the authenticated `gh` CLI using read-only GitHub API requests.

```bash
ci-diet scan --cwd .
gh auth status
ci-diet sync --cwd . --network
ci-diet report --cwd .
ci-diet report --cwd . --format html --out report.html
```

`gh` needs read access to the repository's Actions runs and jobs. CI Diet never needs GitHub write access. The HTML report is one self-contained file with inline CSS, no scripts, and no external requests. In DSH, `ci_diet_scan` and `ci_diet_sync` both save reports; network access and preflight are on by default for new plugin profiles.

![CI Diet flow: scan, preview, human approval, apply, measure](docs/assets/workflow.svg)

## What it finds

<p align="center">
  <img src="docs/assets/settings-preview.png" alt="CI Diet configuration page with default-on preflight in the Korean UI" width="560">
</p>
<p align="center"><sub>Settings → CI Diet configuration. Korean UI shown; preflight is on by default.</sub></p>

| Rule | Default | Looks for | Usual output |
| --- | --- | --- | --- |
| CD001 | on | PR runs superseded by a newer commit | `concurrency` plan |
| CD002 | on | overlapping or duplicate trigger candidates | explanation |
| CD003 | off | heavy checks for declared docs-only changes | explanation |
| CD004 | on | large, resolvable matrices | review note |
| CD005 | off | jobs without a timeout | measured `timeout-minutes` plan |
| CD006 | on | supported npm, pnpm, or Bun frozen-install jobs without an explicit cache | download-cache plan |
| CD008 | on | artifact retention longer than needed | `retention-days` plan with human attestation |

CD003 and CD005 are disabled by default. CD002, CD003, and CD004 do not produce patches. CD005 caps abnormal runs; it does not shorten normal execution. CD008 changes artifact storage retention, not runner minutes. Every plan remains a hypothesis until you review it and measure the result.

## Supported npm cache example

CD006 recognizes a narrow shape: a supported `actions/setup-node@v7` step followed by `npm ci`, with a tracked manifest and lockfile. The plan adds cache inputs only; versions, installation, and tests stay in place. The example assumes `package.json` does not declare npm in either `packageManager` or `devEngines.packageManager`; v7 enables caching automatically when npm is declared, so CI Diet does not propose a redundant cache.

**Before**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
```

**After**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci
```

For a plan command, `--step 1` means the second step in this YAML array: checkout is step `0`, setup-node is step `1`. It is a zero-based index, not a step label. See the [plugin guide](docs/guide/plugin.md) for pnpm, Bun, timeouts, retention, and current guards.

## Review before write

The workflow is **scan → preview → human approval → apply → measure**. The model tools, including `ci_diet_plan`, preview edits and compute a plan digest; they cannot approve, apply, or revert. The review screen can approve, apply, and revert after a person types the plan digest suffix or change ID. Local writes are byte-range edits to one existing workflow file.

```bash
ci-diet plan --cwd . --rule CD006 --workflow .github/workflows/ci.yml --job test --step 1
ci-diet plans --cwd . --plan PLAN_ID
ci-diet approve --cwd . --plan PLAN_ID --confirm CONFIRMATION
ci-diet apply --cwd . --plan PLAN_ID
ci-diet measure --cwd . --change CHANGE_ID --before-runs 100,101 --after-runs 110,111 --network
ci-diet revert --cwd . --change CHANGE_ID
```

Approval authorizes only that plan. Apply creates a backup, rewrites the planned bytes, and performs source, dependency, policy, digest, lock, and backup checks. Revert restores the backup. CI Diet does not commit, push, deploy, run a workflow, change branch protection, or delete artifacts.

## Evidence and honest limits

- No savings are claimed before measurement. A finding can be wrong when history or workflow attribution is incomplete.
- A dependency cache can add restore/save time. Its overhead can exceed the installation time it avoids; compare compatible cold and warm runs and include cache steps.
- `measure` compares selected real runs and reports observed runner-time differences, success and rerun rates. It is evidence about those samples, not proof of causality or actual billing.
- The Settings page stores tool configuration and shows session-scoped reports and plans. It does not optimize a workflow by itself.
- Policy and evidence checks can block an otherwise useful edit. Review the report, the diff, and the repository's own checks before keeping a change.

| Measure | Meaning |
| --- | --- |
| `observedRunnerSeconds` | Runner time observed in the collected runs |
| `modeledRoundedMinutes` | Per-job minutes rounded up; an estimate only |
| `listPriceUsd` | List-price estimate from the embedded pricing snapshot |
| `actualBilledUsd` | `unknown` until an actual bill can be proven |

Keeping these values separate prevents modeled minutes from becoming a billing claim.

## Documentation

| Need | Read |
| --- | --- |
| Installation, settings, CLI, review, and measurement | [Plugin guide](docs/guide/plugin.md) · [measurement section](docs/guide/plugin.md#measuring-an-applied-change) |
| Normative product and contract map | [Specification index](docs/spec/README.md) |
| Rule guards, cost model, patches, and storage | [Rules](docs/spec/rules.md) · [cost model](docs/spec/cost-model.md) · [patch model](docs/spec/patch-model.md) · [storage](docs/spec/storage.md) |
| A real cache-overhead measurement | [2026-10-25 cache review](docs/measurements/2026-10-25-cache-review.md) |

<details>
<summary>Plugin defaults, migration, and compatibility</summary>

New DSH profiles enable `preflightEnabled`, `networkEnabled`, `localApplyEnabled`, and rules CD001, CD002, CD004, CD006, and CD008. The one-time migration records `defaultsRevision: 2`; later switch and rule choices survive restarts. CD003 and CD005 stay off until explicitly enabled. State paths, retention, quotas, and existing billing inputs are preserved.

The plugin targets DSH `>=0.2.1-rc.2 <0.3.0-0` and `>=0.2.2-rc.1 <0.3.0-0`. DSH `0.3.0` is not supported. Plugin preflight checks supported deployment commands before they run, but it makes no network request or file change and skips opaque shells. CLI history requires `--network`; the plugin network switch permits `gh` calls only when the sync tool is invoked. Update with the same commands and `@latest`, then restart DSH.

</details>

## Contributing and license

Bug reports and focused proposals are welcome in [GitHub Issues](https://github.com/0disoft/dsh-ci-diet/issues). For rule or contract changes, read the [guide](docs/guide/plugin.md) and [decisions](docs/spec/decisions.md) first. Detailed specifications and public documentation are English.

MIT © Rodisoft
