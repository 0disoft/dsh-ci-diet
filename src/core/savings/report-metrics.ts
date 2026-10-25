import type { AnalysisReport, JobInput } from "../contracts/schema.ts";
import { pricePerMinuteMicro } from "../data/index.ts";
import { jobScenario } from "./intervals.ts";
import {
  formatUsd,
  knownCount,
  knownSeconds,
  knownUsd,
  secondsFromMillis,
  unknownCount,
  unknownSeconds,
  unknownUsd,
} from "./metrics.ts";

export interface BillingEstimate {
  /** Account-wide hosted runner minutes already used in the billing period. */
  readonly accountMinutesUsed: number;
  /** Hosted runner minutes included by the account plan for the same period. */
  readonly includedMinutes: number;
}

export interface MetricsOptions {
  /** Reason reported for every field that needs history this run did not collect. */
  readonly unavailableReason: string;
  /** When known, estimate the marginal charge avoided by the modeled savings. */
  readonly billing?: BillingEstimate | null;
}

export interface ComputedMetrics {
  readonly metrics: AnalysisReport["metrics"];
  readonly baselineMinutes: number;
  readonly scenarioMinutes: number;
}

export function computeReportMetrics(jobs: readonly JobInput[], options: MetricsOptions): ComputedMetrics {
  const unknownReason = options.unavailableReason;

  if (jobs.length === 0) {
    const metrics: AnalysisReport["metrics"] = {
      observedRunnerSeconds: unknownSeconds("no_observed_jobs", unknownReason),
      candidateRemovableSeconds: unknownSeconds("no_observed_jobs", unknownReason),
      modeledRoundedMinutes: unknownCount("no_observed_jobs", unknownReason),
      listPriceUsd: unknownUsd("no_observed_jobs", unknownReason),
      estimatedMarginalUsd: options.billing
        ? unknownUsd("no_observed_jobs", unknownReason)
        : unknownUsd("allowance_unknown", "BILLING_ESTIMATE_UNCONFIGURED"),
      actualBilledUsd: unknownUsd("billing_not_queried", "BILLING_NOT_QUERIED"),
      queueSeconds: unknownSeconds("queue_not_observed", unknownReason),
      executionSpanSeconds: unknownSeconds("span_not_observed", unknownReason),
      criticalPathWorkSeconds: unknownSeconds("dag_not_observed", unknownReason),
      estimatedUserWaitReductionSeconds: unknownSeconds("causality_not_observed", unknownReason),
    };
    return { metrics, baselineMinutes: 0, scenarioMinutes: 0 };
  }

  let observedMillis = 0;
  let removedMillis = 0;
  let baselineMinutes = 0;
  let scenarioMinutes = 0;
  let knownSkuJobs = 0;
  let unknownSku = false;
  let knownRateMinutes = 0;
  let knownRateMicroUsd = 0;

  for (const job of jobs) {
    const scenario = jobScenario(job.durationMillis, job.removals);
    observedMillis += scenario.baselineMillis;
    removedMillis += scenario.removedMillis;
    baselineMinutes += scenario.baselineMinutes;
    scenarioMinutes += scenario.scenarioMinutes;
    const savedMinutes = scenario.baselineMinutes - scenario.scenarioMinutes;
    if (job.sku.status === "known" && typeof job.sku.value === "string") {
      const rate = pricePerMinuteMicro(job.sku.value);
      if (rate === null) {
        unknownSku = true;
      } else {
        knownSkuJobs += 1;
        knownRateMinutes += savedMinutes;
        knownRateMicroUsd += savedMinutes * rate;
      }
    } else {
      unknownSku = true;
    }
  }

  const listPriceUsd = unknownSku
    ? unknownUsd(
        "known subset " + formatUsd(knownRateMicroUsd) + " USD across " + knownSkuJobs + "/" + jobs.length + " jobs",
        "UNKNOWN_SKU",
      )
    : knownUsd(formatUsd(knownRateMicroUsd), "list price delta at confirmed SKUs");

  const billing = options.billing ?? null;
  let estimatedMarginalUsd;
  if (unknownSku || knownSkuJobs === 0) {
    estimatedMarginalUsd = unknownUsd(
      "known subset " + formatUsd(knownRateMicroUsd) + " USD across " + knownSkuJobs + "/" + jobs.length + " jobs",
      "UNKNOWN_SKU",
    );
  } else if (knownRateMinutes <= 0) {
    // Nothing removable means nothing billed, even though the SKU is known.
    estimatedMarginalUsd = knownUsd("0.000000", "no removable minutes at confirmed SKUs");
  } else if (billing === null) {
    estimatedMarginalUsd = unknownUsd(
      "configure billing.includedMinutes and billing.accountMinutesUsed",
      "BILLING_ESTIMATE_UNCONFIGURED",
    );
  } else {
    // accountMinutesUsed is current usage and already includes the analyzed
    // runs, so savings only avoid a charge for minutes that are over the
    // allowance now: overage before minus overage after. An account under its
    // allowance saves no billed minutes today even though the list price drops.
    const overageMinutes = Math.max(0, billing.accountMinutesUsed - billing.includedMinutes);
    const billableMinutes = Math.min(knownRateMinutes, overageMinutes);
    const billableMicro = Math.round((knownRateMicroUsd * billableMinutes) / knownRateMinutes);
    estimatedMarginalUsd = knownUsd(
      formatUsd(billableMicro),
      "saved " + knownRateMinutes + " min at confirmed SKUs; " + overageMinutes
        + " min of the account were already over " + billing.includedMinutes + " included minutes",
    );
  }

  const metrics: AnalysisReport["metrics"] = {
    observedRunnerSeconds: knownSeconds(secondsFromMillis(observedMillis), "sum of confirmed job durations"),
    candidateRemovableSeconds: knownSeconds(secondsFromMillis(removedMillis), "union of removable intervals"),
    modeledRoundedMinutes: knownCount(
      scenarioMinutes,
      "baseline " + baselineMinutes + " min, scenario " + scenarioMinutes + " min after per-job rounding",
    ),
    listPriceUsd,
    estimatedMarginalUsd,
    actualBilledUsd: unknownUsd("billing_not_queried", "BILLING_NOT_QUERIED"),
    queueSeconds: unknownSeconds("queue_not_observed", unknownReason),
    executionSpanSeconds: unknownSeconds("span_not_observed", unknownReason),
    criticalPathWorkSeconds: unknownSeconds("dag_not_observed", unknownReason),
    estimatedUserWaitReductionSeconds: unknownSeconds("causality_not_observed", unknownReason),
  };

  return { metrics, baselineMinutes, scenarioMinutes };
}
