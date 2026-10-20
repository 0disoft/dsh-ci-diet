import type { BudgetLedger, QuotaLedger } from "../../core/contracts/schema.ts";
import { GitHubError } from "./errors.ts";

export const FAMILIES = ["discovery", "jobs", "definitions", "policyAndFiles"] as const;
export type Family = (typeof FAMILIES)[number];

export type FamilyLimits = Readonly<Record<Family, number>>;

interface FamilyState {
  initialQuota: number;
  borrowed: number;
  donated: number;
  used: number;
  reserved: number;
  state: QuotaLedger["state"];
}

/** Deterministic request ledger: every dispatch attempt consumes one token. */
export class RequestBudget {
  readonly limit: number;
  private readonly families = new Map<Family, FamilyState>();
  private dispatchAttempts = 0;
  private inFlight = 0;

  constructor(limits: FamilyLimits) {
    this.limit = FAMILIES.reduce((total, family) => total + limits[family], 0);
    for (const family of FAMILIES) {
      this.families.set(family, {
        initialQuota: limits[family],
        borrowed: 0,
        donated: 0,
        used: 0,
        reserved: 0,
        state: limits[family] === 0 ? "unavailable" : "pending",
      });
    }
  }

  get used(): number {
    return this.dispatchAttempts;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.dispatchAttempts);
  }

  remainingIn(family: Family): number {
    const state = this.stateOf(family);
    return Math.max(0, state.initialQuota + state.borrowed - state.donated - state.used);
  }

  /** Consume one dispatch token or fail without side effects. */
  consume(family: Family): void {
    const state = this.stateOf(family);
    if (state.state === "finished" || state.state === "unavailable") {
      throw new GitHubError("BUDGET_EXHAUSTED", "family " + family + " is " + state.state);
    }
    if (this.remaining <= 0) throw new GitHubError("BUDGET_EXHAUSTED", "global request budget exhausted");
    if (this.remainingIn(family) <= 0) throw new GitHubError("BUDGET_EXHAUSTED", "family " + family + " budget exhausted");
    state.used += 1;
    state.state = "active";
    this.dispatchAttempts += 1;
    this.inFlight += 1;
  }

  settle(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Mark a family complete and donate what it never used to the next pending family. */
  finish(family: Family): void {
    const state = this.stateOf(family);
    if (state.state === "finished" || state.state === "unavailable") return;
    state.state = "finished";
    let spare = this.remainingIn(family);
    for (const target of FAMILIES) {
      if (spare <= 0) break;
      if (target === family) continue;
      const other = this.stateOf(target);
      if (other.state !== "pending" && other.state !== "active") continue;
      other.borrowed += spare;
      other.state = "pending";
      state.donated += spare;
      spare = 0;
    }
  }

  markUnavailable(family: Family): void {
    this.stateOf(family).state = "unavailable";
  }

  familyState(family: Family): FamilyState {
    const state = this.stateOf(family);
    return { ...state };
  }

  snapshot(): BudgetLedger {
    const families: Record<string, QuotaLedger> = {};
    for (const family of FAMILIES) {
      const state = this.stateOf(family);
      families[family] = {
        initialQuota: state.initialQuota,
        borrowed: state.borrowed,
        donated: state.donated,
        used: state.used,
        reserved: state.reserved,
        remaining: this.remainingIn(family),
        state: state.state,
      };
    }
    return {
      limit: this.limit,
      dispatchAttempts: this.dispatchAttempts,
      reserved: 0,
      inFlight: this.inFlight,
      remaining: this.remaining,
      wireRequestCount: {
        status: "unknown",
        value: null,
        basis: "gh api hides its internal wire-level retries",
        reason: "WIRE_REQUEST_COUNT_UNOBSERVED",
      },
      families: families as BudgetLedger["families"],
    };
  }

  private stateOf(family: Family): FamilyState {
    const state = this.families.get(family);
    if (state === undefined) throw new GitHubError("BUDGET_EXHAUSTED", "unknown request family: " + String(family));
    return state;
  }
}
