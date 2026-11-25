// The panel's ticket list: loading, a card's change, search, All projects, the project line,
// and going to a project's space.
import { check, settle, makeCx, t, find, text, click } from "./lib.mjs";
import { world, sendCommand } from "./fake/herdr.mjs";

const { default: Tickets } = await import("../mods/codebasehq/main.js");
const cx = makeCx();
const list = new Tickets();
list.init(undefined, cx);
await settle(); list.watch(cx); await settle();

const p = list.project();
check("in the shop's checkout the list is the shop's", p.permalink === "example-shop" && p.source === "from git remote", p);
const entry = list.entryFor("example-shop");
check("it shows your open tickets", entry.tickets?.length === 6 && entry.tickets.every((k) => k.assignee === "alex" && !k.closed), entry.tickets?.map((k) => k.id));
let tree = list.render();
check("the line under the header has the project's name and a link icon", /Example Shop/.test(text(tree)) && Boolean(find(tree, "project-link")));
click(tree, "project-link", cx);
check("… which opens its tickets in Codebase", cx.opened === "https://example.codebasehq.com/projects/example-shop/tickets", cx.opened);

// A card's priority, changed from its menu.
const k = entry.tickets[0];
list.menu = { id: k.uid, kind: "priority" };
tree = list.render();
check("a card's menu lists the values", Boolean(find(tree, `opt-${k.uid}-priority-21`)));
click(tree, `opt-${k.uid}-priority-21`, cx);
check("picking one shows at once", k.priority === "Critical");
await settle();
check("… and saves it as a change", world.saved.some((s) => s.kind === "update" && s.id === k.id && s.changes.priority_id === 21), world.saved);

// Search.
list.searchInput.set_value("cookie banner"); list.searchChanged(cx, true); await settle();
check("words search with the filter", list.searchFor("example-shop") === "assignee:me resolution:open cookie banner");
check("… and the list follows", list.entryFor("example-shop").tickets?.map((x) => x.id).join() === "118", list.entryFor("example-shop").tickets?.map((x) => x.id));
list.searchInput.set_value("#117"); list.searchChanged(cx, true); await settle();
check("#117 is that ticket", list.entryFor("example-shop").tickets?.map((x) => x.id).join() === "117");
list.searchInput.set_value("gift"); list.searchChanged(cx);
check("while typing it waits", list.searchText === "#117");
await settle();
check("… and searches a moment later", list.searchText === "gift");
click(list.render(), "search-clear", cx); await settle();
check("× clears the search", list.searchText === "" && list.entryFor("example-shop").tickets?.length === 6);

// All projects.
world.asked.length = 0;
list.choose("*", cx); await settle();
check("All projects asks every project", list.project().all && ["example-blog", "example-shop"].every((p) => world.asked.includes(p)) && list.entryFor("*").tickets?.length === 6, world.asked);
const merged = list.mergedChoices();
check("its filter values are merged once, not per render", merged === list.mergedChoices() && merged.statuses?.length > 0);
tree = list.render();
check("cards say their project there", Boolean(find(tree, "project-example-shop-118")));
list.filterMenu = "assignee";
check("the assignee filter offers Me and Unassigned", /Me .*Unassigned/.test(text(list.render())));
list.filterMenu = null;

// A notification's click: "open:<project>:<id>" comes as a command and shows the ticket.
sendCommand("open:example-shop:117"); await settle();
check("a note notification's click shows the ticket", world.shared["codebasehq.open"]?.uid === "example-shop-117", world.shared["codebasehq.open"]);

// The list puts the most urgent first, the most recently updated first within a priority.
list.choose(null, cx); await settle();
const shown = list.ordered(list.entryFor("example-shop")).map((x) => `${x.priority}#${x.id}`);
// (#118 became Critical above.)
check("the most urgent priority first; within one, started, other open, then new", shown.join(" ") === "Critical#118 High#117 Normal#112 Normal#121 Low#115 Low#109", shown.join(" "));
list.filters["example-shop"] = { ...list.filterFor("example-shop"), assignee: [], resolution: "all" }; list.load(cx, true); await settle();
const all = list.ordered(list.entryFor("example-shop")).filter((x) => x.priority === "Normal").map((x) => `${x.status}#${x.id}`);
check("… closed ones last (Open and closed)", all.join(" ") === "Accepted#116 Review#114 Accepted#112 New#122 New#121 New#119 Invalid#110 Completed#108", all.join(" "));

// In All projects, a change made in another copy asks only that project again.
{
  list.choose("*", cx); await settle();
  world.asked.length = 0;
  world.shared["codebasehq.changed"] = { from: "another-copy", project: "example-shop", id: 121, ids: [121], at: Date.now() };
  list.followChanges(cx); await settle();
  check("a change elsewhere in All projects asks only its project again", world.asked.join() === "example-shop", world.asked);
  list.choose(null, cx); await settle();
}

// Settings: the tab bar's button name, shared with the tab-bar mod.
{
  check("the button is called CodebaseHQ by default (no shared name: the tab bar's default)", (world.shared["codebasehq.label"] ?? "CodebaseHQ") === "CodebaseHQ" && list.buttonLabel === "CodebaseHQ", world.shared["codebasehq.label"]);
  list.openSetup(cx);
  check("Settings has a field for the button's name", /Button name/.test(text(list.render())));
  list.buttonLabelInput.set_value("  Ärenden  ");
  list.save(cx); await settle();
  check("saving shares the new name", world.shared["codebasehq.label"] === "Ärenden" && list.view === "list", world.shared["codebasehq.label"]);
  list.openSetup(cx); list.buttonLabelInput.set_value(""); list.save(cx); await settle();
  check("… and an empty field goes back to CodebaseHQ", world.shared["codebasehq.label"] === "CodebaseHQ", world.shared["codebasehq.label"]);
}
