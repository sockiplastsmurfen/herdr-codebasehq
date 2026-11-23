// Start work's git, for real, in a repository made for the test (with an origin of its own).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { check } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";
import { startBranch, currentBranch } from "../mods/codebasehq/codebase.js";

world.real = true;
const dir = mkdtempSync(`${tmpdir()}/codebasehq-git-`);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).toString();
try {
  git(dir, "init", "-q", "--bare", "-b", "master", "origin.git");
  git(dir, "clone", "-q", "origin.git", "work");
  const work = `${dir}/work`;
  git(work, "commit", "-q", "--allow-empty", "-m", "init");
  git(work, "push", "-q", "origin", "master");
  git(work, "remote", "set-head", "origin", "-a");
  git(dir, "clone", "-q", "origin.git", "other");
  git(`${dir}/other`, "switch", "-q", "-c", "584-pushed-elsewhere");
  git(`${dir}/other`, "push", "-q", "origin", "584-pushed-elsewhere");
  git(work, "switch", "-q", "-c", "unrelated");
  writeFileSync(`${work}/changed.txt`, "work in progress\n");

  let r = await startBranch(work, "583-new-work");
  check("a new branch starts from origin's default branch", r.how === "new" && r.base === "origin/master" && await currentBranch(work) === "583-new-work", r);
  check("changes in the working tree come along", git(work, "status", "--short").includes("changed.txt"));
  r = await startBranch(work, "584-pushed-elsewhere");
  check("a branch only on origin is checked out, tracking it", r.how === "remote" && git(work, "rev-parse", "--abbrev-ref", "@{u}").trim() === "origin/584-pushed-elsewhere", r);
  r = await startBranch(work, "583-new-work");
  check("a local branch is switched to", r.how === "existing" && await currentBranch(work) === "583-new-work", r);
  let refused = null;
  try { await startBranch(work, "--orphan"); } catch (e) { refused = e.message; }
  check("a name git could read as an option is refused", /Not a branch name/.test(refused ?? ""), refused);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// The diff's fetch takes a branch from the API: only a plain name, never a refspec or an option.
{
  const { commitDiff } = await import("../mods/codebasehq/codebase.js");
  world.real = false;
  const fetched = [];
  world.exec = (cmd, args) => { if (args[0] === "fetch") fetched.push(args.at(-1)); return args[0] === "show" ? { code: 128, stdout: "", stderr: "fatal: bad object\n" } : undefined; };
  for (const branch of ["+refs/heads/x:refs/heads/main", "a:b", "--upload-pack=x", "118-cookie-banner"]) await commitDiff("/tmp", "3f9c2a1e7b", branch).catch(() => null);
  check("a refspec or an option from the API is never fetched; a plain branch is", fetched.join() === "118-cookie-banner", fetched);
  world.exec = null;
}
