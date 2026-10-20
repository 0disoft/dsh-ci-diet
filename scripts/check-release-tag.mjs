#!/usr/bin/env node
// Compare a release tag (vX.Y.Z) with the version in package.json.
// Read-only: no network, no writes. Exit 1 with a reason on mismatch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function checkReleaseTag(tag, version) {
  if (!SEMVER.test(version)) {
    return { ok: false, message: 'package.json version "' + version + '" is not semver' };
  }
  const expected = "v" + version;
  if (tag !== expected) {
    return {
      ok: false,
      message:
        'tag "' + tag + '" does not match package.json version "' + version + '" (expected "' + expected + '")',
    };
  }
  return { ok: true, message: "tag " + tag + " matches package.json version " + version };
}

function main(argv) {
  const tag = argv[0];
  if (typeof tag !== "string" || tag.length === 0) {
    console.error("usage: node scripts/check-release-tag.mjs <tag>");
    return 1;
  }
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version : "";
  const result = checkReleaseTag(tag, version);
  if (result.ok) {
    console.log(result.message);
    return 0;
  }
  console.error(result.message);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
