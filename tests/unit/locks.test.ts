import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { acquireLock, LEASE_TOKEN_FILE } from "../../src/core/patch/locks.ts";
import { LEASE_CLAIM_STALE_MS } from "../../src/core/policy/constants.ts";

const NOW = new Date("2026-10-25T00:00:00Z");
const CLOCK = { now: () => NOW };
const LIVE_OWNER = "lease_" + process.pid.toString(36) + "_live_other";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ci-diet-claim-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "write.claim");
  return { root, path, owner: join(path, LEASE_TOKEN_FILE) };
}

test("an owner published after an empty claim's age check is never deleted", (t) => {
  const f = fixture(t);
  mkdirSync(f.path);
  const old = new Date(NOW.getTime() - LEASE_CLAIM_STALE_MS - 1000);
  utimesSync(f.path, old, old);
  const stat = fs.statSync;
  let published = false;
  const mocked = t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    const result = stat(...args);
    if (!published && String(args[0]) === f.path) {
      published = true;
      // The age check observed an empty old directory. Its creator resumes
      // before the contender removes it and publishes its live owner token.
      writeFileSync(f.owner, LIVE_OWNER);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireLock(f.root, "write", 0, "WRITE_CONFLICT", { clock: CLOCK }), /WRITE_CONFLICT/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(published, true);
  assert.equal(readFileSync(f.owner, "utf8"), LIVE_OWNER);
});

test("failed claim creation never recursively removes another owner's token", (t) => {
  const f = fixture(t);
  const write = fs.writeFileSync;
  let published = false;
  const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (!published && String(args[0]) === f.owner) {
      published = true;
      write(f.owner, LIVE_OWNER);
    }
    // The exclusive owner write fails with EEXIST, as when an earlier creator
    // resumes after its empty directory was reclaimed and replaced.
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireLock(f.root, "write", 0, "WRITE_CONFLICT", { clock: CLOCK }), /WRITE_CONFLICT/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(published, true);
  assert.equal(readFileSync(f.owner, "utf8"), LIVE_OWNER);
});

test("an actually empty stale claim remains recoverable", (t) => {
  const f = fixture(t);
  mkdirSync(f.path);
  const old = new Date(NOW.getTime() - LEASE_CLAIM_STALE_MS - 1000);
  utimesSync(f.path, old, old);
  const lock = acquireLock(f.root, "write", 0, "WRITE_CONFLICT", { clock: CLOCK });
  assert.match(readFileSync(f.owner, "utf8"), /^lease_/);
  lock.release();
  assert.equal(existsSync(f.path), false);
});

test("a failed owner write leaves no empty claim behind", (t) => {
  const f = fixture(t);
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]) === f.owner) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireLock(f.root, "write", 0, "WRITE_CONFLICT", { clock: CLOCK }), /WRITE_CONFLICT/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(f.path), false);
});
