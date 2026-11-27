// The mod's pure functions: names, patterns, the search the filters make.
import { check } from "./lib.mjs";
import { branchName, validBranch, isTicketBranch, canShow, expandHome, ticketPage } from "../mods/codebasehq/codebase.js";
import { searchOf, NO_FILTER, UNASSIGNED } from "../mods/codebasehq/filters.js";

check("a branch is the ticket number and the summary's words", branchName(583, "Drupal 11 i november/december") === "583-drupal-11-i-november-december");
check("accents go, other marks become dashes", branchName(12, "Räkna åäö & tecken!!") === "12-rakna-aao-tecken", branchName(12, "Räkna åäö & tecken!!"));
check("a branch name stops at 60 characters, at a word", branchName(7, "a very long summary that goes on and on about many many things in the checkout flow").length <= 60);
check("git's branch names pass", ["583-x", "ok/feat", "release-2.4"].every(validBranch));
check("an option, .., a trailing slash or .lock don't", !["-rf", "a..b", "x/", "x.lock", "x.", ""].some(validBranch));
check("a ticket's branch is 583, 583-… or ticket-583", ["583", "583-drupal", "ticket-583"].every((b) => isTicketBranch(b, 583)));
check("… not 5830-…, x-583 or master", !["5830-x", "x-583", "master", null].some((b) => isTicketBranch(b, 583)));
check("the dialog shows PDFs, Word, office files, images and text", ["a.PDF", "b.docx", "c.xlsx", "d.pptx", "e.png", "f.txt", "g.rtf"].every(canShow));
check("… and downloads zips and the like", !["a.zip", "b.tar.gz", "c.dmg", "noext"].some(canShow));
check("~ is the home folder", expandHome("~/Sites/") === "/Users/demo/Sites" && expandHome("/opt/x") === "/opt/x");
check("the filter becomes Codebase's search", searchOf({ ...NO_FILTER, assignee: ["me"], status: ["In Progress", "New"], resolution: "open" }) === 'assignee:me status:"In Progress",New resolution:open');
check("Unassigned is a term of its own, ORed with the others", searchOf({ ...NO_FILTER, assignee: [UNASSIGNED, "me"] }) === "assignee:none assignee:me");
check("no resolution term when asked not to", searchOf({ ...NO_FILTER, resolution: "open" }, false) === "");
// The list asks Codebase for the most urgent first, so its next pages carry on in that order.
const asked = [];
globalThis.fetch = async (url) => { asked.push(decodeURIComponent(String(url))); return { ok: true, status: 200, json: async () => [], text: async () => "[]" }; };
await ticketPage({ user: "a/b", key: "k" }, "shop", "assignee:me", 1, "priority").catch(() => {});
await ticketPage({ user: "a/b", key: "k" }, "shop", "assignee:me", 1).catch(() => {});
check("the list's pages come most urgent first", asked[0]?.includes("assignee:me sort:priority order:desc"), asked[0]);
check("… others' most recently updated first", asked[1]?.includes("assignee:me sort:updated_at order:desc"), asked[1]);
// The commit lookup's answers are kept a while: asking twice asks Codebase once.
{
  const { repositories, forgetRemembered } = await import("../mods/codebasehq/codebase.js");
  asked.length = 0;
  await repositories({ user: "a/b", key: "k" }, "shop");
  await repositories({ user: "a/b", key: "k" }, "shop");
  check("repositories are asked for once in a while, not per ticket", asked.filter((u) => u.includes("/shop/repositories")).length === 1, asked);
  forgetRemembered();
  await repositories({ user: "a/b", key: "k" }, "shop");
  check("… and again after a reload or another account", asked.filter((u) => u.includes("/shop/repositories")).length === 2);
}
// Disabled people aren't offered: the project's people don't say who is, the account's do.
{
  const { choices, forgetRemembered } = await import("../mods/codebasehq/codebase.js");
  forgetRemembered();
  const answers = {
    "/shop/assignments": [{ user: { id: 1, first_name: "Anna", username: "anna" } }, { user: { id: 2, first_name: "Bo", username: "bo" } }],
    "/users": [{ user: { id: 1, enabled: true } }, { user: { id: 2, enabled: false } }, { user: { id: 3, enabled: false } }],
  };
  const saved = globalThis.fetch;
  asked.length = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    asked.push(path);
    const body = JSON.stringify(answers[path] ?? []);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  const creds = { user: "a/b", key: "k" };
  const c = await choices(creds, "shop");
  check("disabled people are left out of the project's people", c.users.map((u) => u.username ?? u.name).join() === "Unassigned,anna", c.users);
  await choices(creds, "shop");
  check("… and the account's people are asked for once in a while, not per project", asked.filter((p) => p === "/users").length === 1, asked);
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/users") return { ok: false, status: 500, text: async () => "" };
    const body = JSON.stringify(answers[path] ?? []);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  forgetRemembered();
  const all = await choices(creds, "shop");
  check("… everyone on the project is shown if the account's people can't be read", all.users.length === 3, all.users);
  globalThis.fetch = saved;
  forgetRemembered();
}
