// A0a supplementary probe: docs-only share among recent pull requests.
// Read-only. Uses the same token and REST surface as a0a-collect.mjs.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve("evidence/a0a");
const API = "https://api.github.com/";
const TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const REPOS = [
  "microsoft/vscode", "facebook/react", "vercel/next.js", "rust-lang/rust",
  "denoland/deno", "oven-sh/bun", "vitejs/vite", "withastro/astro",
  "tailwindlabs/tailwindcss", "microsoft/TypeScript-Website",
];
const PRS_PER_REPO = 30;
const DOCS_PATH = /^(docs?\/|.*\.mdx?$|.*\.markdown$|license|contributing|changelog|code_of_conduct|\.github\/(issue_template|pull_request_template|funding)|readme|\.[a-z]+\.md$)/i;
let requests = 0;
function count(p) { requests += 1; return p; }
async function get(p) {
  const res = await fetch(new URL(count(p), API), {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${TOKEN}`, "user-agent": "ci-diet-a0a-spike" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${p}`);
  return res.json();
}

const out = { generatedAt: new Date().toISOString(), repos: [] };
for (const repo of REPOS) {
  const pulls = await get(`repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=${PRS_PER_REPO}`);
  const prs = [];
  for (const pr of pulls) {
    const files = await get(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    const changed = files.map((f) => f.filename);
    const docsOnly = changed.length > 0 && changed.every((f) => DOCS_PATH.test(f));
    prs.push({ number: pr.number, files: changed.length, docsOnly, truncated: files.length === 100 });
  }
  out.repos.push({ repo, prs });
  console.log(`${repo}: ${prs.length} PRs, docsOnly ${prs.filter((p) => p.docsOnly).length}`);
}
out.requests = requests;
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "pr-probe.json"), JSON.stringify(out, null, 2));
console.log(`requests ${requests}`);
