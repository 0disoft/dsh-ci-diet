import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapWithConcurrency } from "../../src/core/support/concurrency.ts";

describe("mapWithConcurrency", () => {
  it("preserves input order when work finishes out of order", async () => {
    const delays = [30, 5, 15, 1];
    const results = await mapWithConcurrency(delays, 2, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { index, delay };
    });
    assert.deepEqual(results.map((result) => result.index), [0, 1, 2, 3]);
  });

  it("never runs more than the limit and clamps a zero limit to one", async () => {
    for (const limit of [3, 0]) {
      let active = 0;
      let maxActive = 0;
      const results = await mapWithConcurrency([1, 2, 3, 4, 5], limit, async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return item * 2;
      });
      assert.equal(maxActive, limit === 0 ? 1 : limit);
      assert.deepEqual(results, [2, 4, 6, 8, 10]);
    }
  });

  it("stops launching after the first rejection, awaits active work, and rethrows", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const failure = new Error("second item failed");
    const mapped = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      if (item === 1) throw failure;
      return item;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1]);
    gates[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1, 2]);
    gates[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, [0, 1, 2], "no fourth item may launch after the failure");
    gates[2]?.();
    await assert.rejects(mapped, failure);
    assert.deepEqual(started, [0, 1, 2]);
  });

  it("does not launch work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    let calls = 0;
    await assert.rejects(
      mapWithConcurrency([1, 2], 2, async () => {
        calls += 1;
        return 0;
      }, { signal: controller.signal }),
      /stop now/,
    );
    assert.equal(calls, 0);
  });

  it("returns an empty array without calling the mapper", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 3, async () => {
      calls += 1;
      return 1;
    });
    assert.deepEqual(results, []);
    assert.equal(calls, 0);
  });
});
