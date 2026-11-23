// Going to a project from its name: a space that works in it, or Clone, or Open without cloning.
import { check, settle, makeCx, find, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

// Outside any repo.
world.spaces = [{ id: "s1", name: "home", active: true, folder: "/Users/demo", machine: null, tabs: [{ id: "t1", active: true }] }];
world.panes = [{ pane: "p1", tab: "t1", cwd: "/Users/demo", mod: null }];
world.focused = { cwd: "/Users/demo", space: "s1", pane: "p1" };
const { default: Tickets } = await import("../mods/codebasehq/main.js");
const cx = makeCx();
const list = new Tickets();
list.init(undefined, cx);
await settle(); list.watch(cx); await settle();

check("outside a repo the list is All projects", list.cwd === "/Users/demo" && list.project().all && list.project().source === "default outside a repo" && list.entryFor("*").tickets !== null, { cwd: list.cwd, source: list.project().source });
list.openClone({ project: "example-blog", projectName: "Example Blog" }, cx);
await settle();
let tree = list.render();
check("Clone offers the project's repositories and Open without cloning", /Clone and open/.test(text(tree)) && Boolean(find(tree, "clone-open")));
click(tree, "clone-open", cx);
await settle();
const made = world.runs.find(([c]) => c === "space.new")?.[1];
check("Open without cloning opens a space named after the project, in the project folder", made?.name === "Example Blog" && made.folder === "/Users/demo/Sites", made);
list.watch(cx); await settle();
check("the list there shows that project", list.project().permalink === "example-blog" && list.project().source === "chosen for this space", list.project());
world.focused = { cwd: "/Users/demo", space: "s1", pane: "p1" };
for (const s of world.spaces) s.active = s.id === "s1";
list.watch(cx); await settle();
check("the first space keeps All projects", list.project().all, list.project());
