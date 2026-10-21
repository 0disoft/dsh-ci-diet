# Cost and savings model

## Metric values

Every externally observed or converted number is a `Metric<T>`:

- `known`: value plus `basis`.
- `unknown`: the data was not obtained. `value` is null and a `reason` is
  mandatory.
- `not_applicable`: the concept does not apply to this target. `value` is
  null.

Missing data is never written as 0. USD amounts are stored as six-decimal
strings and computed as integer microUSD. Seconds are displayed as integers or
three-decimal strings, while normalization, intervals, and arithmetic use
integer milliseconds so that 60.001 seconds never becomes 1 minute.

## Reported fields

| Field | Meaning |
| --- | --- |
| `observedRunnerSeconds` | Sum of every confirmed job's run interval; parallel jobs are added individually. |
| `candidateRemovableSeconds` | Union of removable intervals under valid scenarios. |
| `modeledRoundedMinutes` | Baseline and scenario values after per-job minute rounding. |
| `listPriceUsd` | Reference amount at confirmed SKU list prices. |
| `estimatedMarginalUsd` | Marginal cost estimate when the account allowance is known from `billing.includedMinutes` and `billing.accountMinutesUsed`. |
| `actualBilledUsd` | Actual charge from billing data. v0.1 does not query billing, so this is `unknown`. |
| `standaloneRunnerSeconds` | Interval removed by one finding in isolation. |

`listPriceUsd` is not a bill. If some jobs have unknown SKUs, the total amount
must not become `known`; expose a `knownSubsetListPriceUsd` partial sum with
the covered item count instead, and never use it as the ranking value for
"savings".

## Rounding and overlap

For a job `j` with a normal completion, `d_j = completed_at - started_at`.
Missing or inverted timestamps mean `unknown`. Baseline minutes are
`ceil(d_j / 60)`; zero seconds is zero minutes. Rounding is applied per job,
never once to the summed duration.

For explanation, a removable interval is the half-open
`[a, b)` in seconds relative to the job start. The stored contract uses
`durationMillis`, `startMillis`, and `endMillis`, and the implementation
divides by 60000. Clip each interval to `[0, d_j)`, sort, then merge touching
or overlapping intervals. With union length `u_j`, the scenario is
`d'_j = d_j - u_j` and the new minutes are `ceil(d'_j / 60)`. A full-job
removal and a partial removal are never added twice.

A finding's `standaloneRunnerSeconds` uses only its own intervals. The report
total re-computes the union of all selected findings per job. The two numbers
may legitimately differ. If a candidate cannot justify an interval at all (for
example an unverified CD002 equivalence), its standalone value is `unknown`.

## Synthetic example

| Job | SKU | Baseline s | Scenario s | Baseline min | New min | List price delta USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | `actions_linux` | 125 | 70 | 3 | 2 | 0.006000 |
| B | `actions_windows` | 59 | 10 | 1 | 1 | 0.000000 |
| C | `actions_linux` | 120 | 0 | 2 | 0 | 0.012000 |
| Total | mixed | 304 | 80 | 6 | 3 | 0.018000 |

Total runner reduction is 224 seconds; B's 49-second reduction does not change its
rounded minutes. For a 300-second Linux job where two findings remove
`[0,100)` and `[60,160)`, the union is 160 seconds, the remainder is 140
seconds, and 5 minutes become 3 (0.012000 USD). Adding the two 100-second
findings would be wrong.

CD001 removes the interval after a replacement run was created. Because
cancellation delivery and teardown latency are not observed, present the range
computed with `cancellationLagSeconds = 0` and `30`. The result is a simulation,
not a prediction of actual runner teardown.

CD005 does not reduce normal successful runtime. Without a confirmed abnormal
run, its time saving is `not_applicable`; adding a timeout is not forced into a
money-saving story.

## Wait, span, and critical path

| Field | Definition and limits |
| --- | --- |
| `queueSeconds` | First attempt's valid `run_started_at - created_at`; negative means unknown. |
| `executionSpanSeconds` | Last job completion minus the attempt's actual start. |
| `observedCompletionSeconds` | Creation to last completion for the first attempt. |
| `criticalPathWorkSeconds` | Longest path of summed job durations in the exactly expanded `needs` DAG. |
| `scenarioCriticalPathWorkSeconds` | Longest path for a supported time-change scenario on the same DAG. |
| `estimatedUserWaitReductionSeconds` | Only with real scheduler/queue causality data; `unknown` in v0.1. |

Never compute a retry attempt's queue time from the original run's creation
time. If an attempt's creation or start is missing, `queueSeconds` is
`unknown`. The API's `updated_at` is not a completion timestamp.

For a DAG in topological order, `finish(v) = duration(v) + max(finish(u) for u
in needs(v))`, with max 0 when there is no predecessor.
`criticalPathWorkSeconds` is the maximum finish over terminal nodes. If matrix
fan-out/fan-in, dynamic `needs`, reusable internals, or conditional branches
cannot be expanded exactly, the value is `unknown`.

This number is a work lower bound that excludes runner queues, idle gaps, and
environment approvals; it is not the observed wall-clock span. Example: A runs
20-80 s, B after A 80-200 s, D after A 80-180 s, C after B and D 230-260 s. The
job-duration sum is 310 s, the longest path A→B→C is 210 s, the observed span is
240 s, the initial queue is 20 s, and creation-to-completion is 260 s. Reducing
B from 120 s to 90 s makes A→D→C the 190 s path; that is not a 20-second user
wait reduction.

## SKUs and pricing snapshot

The price snapshot is frozen in `contracts/pricing-2026-10-20.json` and records
`pricingSnapshotId`, `observedAt`, `sourceUrl`, `sourceRefs`, six `rows`
with integer `usdPerMinuteMicro`, and `contentHash`. The hash is the sha256 of
the CDJ1 encoding of `{pricingSnapshotId, observedAt, rows}`. An
`AnalysisReport` embeds a full copy of the snapshot and refuses to ship when the
copy's hash differs from the contract file. Installation never refreshes prices
from the network; a new snapshot requires a new reviewed data file.

| SKU | Target | USD/min |
| --- | --- | ---: |
| `actions_linux_slim` | Linux x64 1 core | 0.002 |
| `actions_linux` | Linux x64 2 cores | 0.006 |
| `actions_linux_arm` | Linux arm64 2 cores | 0.005 |
| `actions_windows` | Windows x64 2 cores | 0.010 |
| `actions_windows_arm` | Windows arm64 2 cores | 0.010 |
| `actions_macos` | macOS M1 or Intel 3-4 cores | 0.062 |

Labels are candidates only. `ubuntu-latest` and `ubuntu-24.04` suggest the
Linux x64 family, `ubuntu-24.04-arm` suggests arm64, `ubuntu-slim` suggests
slim, `windows-2025` suggests Windows, and `macos-14` / `macos-15` suggest
macOS. The actual image and core count of `latest` are not fixed by a label, and
self-hosted runners may reuse any label, so an unconfirmed provider,
standard/larger class, OS, architecture, or core count makes the SKU
`unknown`. The label map is not billing evidence.

Confirmed standard GitHub-hosted runs in public repositories are shown with zero
direct charge; larger runners are excluded, and self-hosted GitHub-hosted cost is
`not_applicable` with unknown infrastructure cost. Private repository included
minutes are shared across the account, so remaining allowance cannot be derived
from one repository's usage.

`sync` accepts `--included-minutes` and `--account-minutes-used`, or the same
values as `billing` in the config file, to supply the account-wide allowance.
The estimate treats saved minutes as the last minutes consumed:
`billable = max(0, saved - max(0, included - used))`, converted at the confirmed
SKU rates. Jobs with unknown SKUs keep the estimate `unknown` rather than
reporting a partial amount. The CLI accepts both flags or neither; passing only
one is a usage error.

## Artifacts

CD008 changes the retention of future uploads. Current artifacts are not deleted
and already billed storage is not presented as refunded. If size, lifetime,
consumer policy, or price is unavailable, the amount is `unknown`. When
available, report projected GB-hours and runner minutes as separate axes, and
never mix compressed artifact size with original file size.
