# Bun cache removal: a measured single-run pair

Collected on 2026-10-25 using existing GitHub Actions runs. No workflow was
triggered for this measurement. The [machine-readable evidence](../../evidence/measurements/2026-10-25-bun-cache.json)
contains the observations, comparison warnings, and immutable workflow hashes.

## Selected runs

Both runs succeeded on `main`, event `push`, workflow `.github/workflows/ci.yml`,
job `check`, and runner label `ubuntu-latest`. Each is attempt 1.

| Phase | Run | Commit | Workflow |
| --- | --- | --- | --- |
| Before | [40016328106](https://github.com/0disoft/dsh-ci-diet/actions/runs/40016328106) | `30e645cf064172ce448ae8ab5c563012e9e935a0` | Bun download cache enabled |
| After | [40017821322](https://github.com/0disoft/dsh-ci-diet/actions/runs/40017821322) | `e4dd3ac6f8f23199ffac2f82b6d6b58c3e348911` | Cache removed by this commit |

The workflow bytes fetched at each immutable commit match the local Git objects.
Other source changes and runner/cache-state variation remain uncontrolled.

## Observed timings

| Scope | Before | After | Observed reduction |
| --- | ---: | ---: | ---: |
| Total runner time | 62 s | 35 s | 27 s (43.55%) |
| Cache restore + post-save steps | 4 s | Absent | 4 s of cache steps removed |
| `bun install --frozen-lockfile` | 0 s | 1 s | -1 s |
| Cache + install subtotal | 4 s | 1 s | 3 s |
| `bun run test:core` | 38 s | 17 s | 21 s |

GitHub step timestamps have second-level resolution. A recorded 0 s does not
mean the operation did no work. Job time also includes gaps between steps.

**The 27-second difference is not verified savings caused by removing the cache.**
The test step alone accounts for 21 seconds of that difference. The directly
relevant cache/install subtotal was 4 versus 1 seconds in these samples; that is
consistent with keeping this repository's very short installation uncached,
but a single pair cannot establish a typical or causal benefit.

This result does not validate the new Bun cache patch on another repository.
For slower installations, review and apply a patch through the normal approval
flow, then collect multiple comparable cold and warm samples with
[`measure --change`](../guide/plugin.md#measuring-an-applied-change).
Do not add a cache to this repository solely because CD006 finds a static candidate.

## Reproduction and limits

```sh
ci-diet compare --repo 0disoft/dsh-ci-diet --before-run 40016328106 --after-run 40017821322 --network --format json
```

The stored result preserves `SINGLE_PAIR_NOT_CAUSAL_PROOF`,
`RUNNER_IMAGE_AND_CACHE_STATE_UNVERIFIED`, and
`SOURCE_CHANGED_REVIEW_DIFF_AND_TEST_SCOPE`. Its `verifiedCausalSavings` is
`false` and `actualBilledUsd` is `null`. It is a manually selected run comparison,
not a journal-linked `measure --change` result or a billing claim.
