import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clockOf, idsOf } from "../support/clock.ts";
import type { Clock, RuntimeSeams } from "../support/clock.ts";
import { CLAIM_POLL_MS, LEASE_CLAIM_STALE_MS, STORE_WRITE_LOCK_WAIT_MS } from "../policy/constants.ts";

export const LEASE_TOKEN_FILE = "owner";

/** Anything with the store root works, which keeps this module independent of PatchStore. */
export interface LockRoot {
  readonly root: string;
}

/** What a takeover observed about a lease before it tried to move it. */
export interface LeaseObservation {
  readonly owner: string;
  readonly mtimeMs: number;
}

export interface StoreLock {
  release(): void;
}

/** Tokens are lease_<pid base36>_<created base36>_<random>. */
export function leaseOwnerPid(owner: string): number | null {
  const match = /^lease_([0-9a-z]+)_/.exec(owner);
  if (match === null) return null;
  const pid = Number.parseInt(match[1]!, 36);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * A stale mtime is not proof that the owner stopped: a long apply can run past
 * the threshold. Ask the operating system whether the recorded process still
 * exists and fail closed when the token cannot be parsed, because moving a
 * live owner outside the lease path would let a third writer start next to it.
 */
export function leaseOwnerAlive(owner: string): boolean {
  const pid = leaseOwnerPid(owner);
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A claim is held for microseconds. Breaking a claim whose owner process is
 * gone is safe even when its mtime is fresh: a dead process cannot release it.
 * A claim directory without an owner token is only broken once it is old,
 * because its creator may still be inside its mkdir/write window.
 */
export function acquireLock(lockRoot: string, name: string, waitMs: number, message: string, seams?: RuntimeSeams): StoreLock {
  mkdirSync(lockRoot, { recursive: true });
  const path = join(lockRoot, name + ".claim");
  const clock = clockOf(seams);
  const ids = idsOf(seams);
  // The token must stay parseable by leaseOwnerAlive: a claim left behind by a
  // crashed process is broken immediately, not held until its mtime expires.
  const token = "lease_" + process.pid.toString(36) + "_" + clock.now().getTime().toString(36) + "_" + ids.suffix(8);
  const deadline = clock.now().getTime() + waitMs;
  for (;;) {
    try {
      createClaim(path, token);
      return { release: () => releaseLock(path, token) };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw new Error(message);
    }
    const observed = readLeaseObservation(path);
    if (observed === null) {
      const age = ageOf(path, clock);
      if (age === null) continue;
      if (age > LEASE_CLAIM_STALE_MS && removeEmptyLockDirectory(path)) {
        continue;
      }
    } else if (!leaseOwnerAlive(observed.owner)) {
      breakStaleClaim(path, observed, token, message);
      continue;
    }
    if (clock.now().getTime() >= deadline) throw new Error(message);
    sleepSync(CLAIM_POLL_MS);
  }
}

/** Take a named store lock (a directory with an owner token) and return its release handle. */
export function acquireStoreLock(store: LockRoot, name: string, waitMs: number, seams?: RuntimeSeams): StoreLock {
  return acquireLock(join(store.root, "locks"), name, waitMs, "WRITE_CONFLICT: another ci-diet process is updating the same record", seams);
}

/**
 * Serialize one store mutation with the quota check. The lock doubles as the
 * reservation: the store re-scans usage after acquiring it, so a second process
 * cannot admit a write from bytes cached before the first process wrote.
 */
export function withStoreWriteLock<T>(store: LockRoot, run: () => T, seams?: RuntimeSeams): T {
  const lock = acquireLock(
    join(store.root, "locks"),
    "write",
    STORE_WRITE_LOCK_WAIT_MS,
    "WRITE_CONFLICT: another ci-diet process is writing the store",
    seams,
  );
  try {
    return run();
  } finally {
    lock.release();
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lock directories live inside the 0700 store and hold only an owner token, but
 * they must not inherit a wider umask mode either. Filesystems without POSIX
 * modes (a mounted share, a FAT volume) keep working without the tighten.
 */
export function tightenLockPath(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}

export function createLockDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  tightenLockPath(path, 0o700);
}

export function ageOf(path: string, clock: Clock): number | null {
  try {
    return clock.now().getTime() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function createClaim(path: string, token: string): void {
  mkdirSync(path);
  tightenLockPath(path, 0o700);
  try {
    writeFileSync(join(path, LEASE_TOKEN_FILE), token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    try { removeEmptyLockDirectory(path); } catch { /* Preserve the owner write error. */ }
    throw error;
  }
}

/**
 * An absent owner is only an observation: a creator may publish it before
 * cleanup. Non-recursive rmdir checks emptiness atomically with removal, so
 * neither stale recovery nor failed creation can erase a newly published token.
 */
export function removeEmptyLockDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function breakStaleClaim(path: string, observed: LeaseObservation, token: string, message: string): void {
  // rename is atomic, so only one breaker can move the stale claim aside.
  const trash = path + ".stale-" + token;
  try {
    renameSync(path, trash);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw new Error(message);
  }
  const moved = readLeaseObservation(trash);
  if (moved === null || moved.owner !== observed.owner) {
    restorePath(trash, path);
    return;
  }
  rmSync(trash, { recursive: true, force: true });
}

export function releaseLock(path: string, token: string): void {
  const current = readLeaseObservation(path);
  if (current === null || current.owner !== token) return;
  const trash = path + ".release-" + token;
  try {
    renameSync(path, trash);
  } catch {
    return;
  }
  const moved = readLeaseObservation(trash);
  if (moved === null || moved.owner !== token) {
    restorePath(trash, path);
    return;
  }
  rmSync(trash, { recursive: true, force: true });
}

export function readLeaseObservation(lease: string): LeaseObservation | null {
  let owner: string;
  let mtimeMs: number;
  try {
    owner = readFileSync(join(lease, LEASE_TOKEN_FILE), "utf8");
    mtimeMs = statSync(lease).mtimeMs;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error("WRITE_CONFLICT: could not read the writer lease");
  }
  return { owner, mtimeMs };
}

export function restorePath(trash: string, path: string): void {
  try {
    renameSync(trash, path);
  } catch {
    // The path is occupied again or cannot be restored. Keep the moved record
    // under its trash name: deleting it would erase a live owner token.
  }
}
