import { sha256Hex } from "../../shared/cdj1.ts";
import type { AnalysisReport } from "../contracts/schema.ts";

/** Shared by static and history reports: source hashes alone omit result changes. */
export function reportIdFor(content: Omit<AnalysisReport, "reportId">): string {
  // JSON preserves valid fractional metrics; CDJ1 accepts only integer numbers.
  return "r_" + sha256Hex(JSON.stringify(content)).slice(0, 24);
}
