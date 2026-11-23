// The mod's pure functions: names, patterns, the search the filters make.
import { check } from "./lib.mjs";
import { branchName, validBranch, isTicketBranch, canShow, expandHome } from "../mods/codebasehq/codebase.js";
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
