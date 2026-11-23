// Start work: when it shows, what it plans, and starting.
import { check, settle, makeCx, t, find, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "ticket", project: "example-shop", id: 122, projectName: "Example Shop" };
// git answers from the panes' branch (symbolic-ref) and as if switching worked.
let branch = "master", failSwitch = false;
world.exec = (cmd, args) => {
  if (cmd === "git" && args[0] === "symbolic-ref") return branch ? { code: 0, stdout: `${branch}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
  if (String(args?.[1]).includes("git switch")) return failSwitch ? { code: 1, stdout: "", stderr: "fatal: no such branch\n" } : { code: 0, stdout: "new origin/master\n", stderr: "" };
  return undefined;
};
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const { watchCheckouts } = await import("../mods/codebasehq/startwork.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle();

const at = async (cwd, b) => { branch = b; world.panes = [{ pane: "p1", tab: "t1", cwd, branch: b, mod: null }]; world.spaces[0].folder = cwd; watchCheckouts(v, cx); await settle(); };
const icon = () => Boolean(find(v.render(t), "view-start"));

await at("/Users/demo/Sites", "master");
check("no checkout of the project in the space: no Start work", !icon());
await at("/Users/demo/example-shop/web", "master");
check("a checkout in the space: Start work shows", icon() && v.checkouts.join() === "/Users/demo/example-shop");
await at("/Users/demo/example-shop/web", "122-show-the-stock-level");
check("on the ticket's branch already: it doesn't", !icon());
await at("/Users/demo/example-shop/web", "master");

click(v.render(t), "view-start", cx);
await settle();
check("the branch is named after the ticket", v.branchInput.value() === "122-show-the-stock-level-on-the-product-page");
check("the form says what will change", /Status: New → In Progress · Assigned to: you/.test(text(v.render(t))), text(v.render(t)).slice(0, 300));

failSwitch = true;
click(v.render(t), "start-run", cx);
check("the icon goes as soon as Start is clicked", !icon());
await settle();
check("if git fails, it says so and the icon is back", /no such branch/.test(v.start?.error ?? "") && icon(), v.start?.error);

failSwitch = false;
click(v.render(t), "start-run", cx);
await settle();
const git = world.execs.findLast((e) => String(e.args?.[1]).includes("git switch"));
check("Start switches the checkout to the branch", git?.args[3] === "/Users/demo/example-shop" && git.args[4] === "122-show-the-stock-level-on-the-product-page", git?.args?.slice(3));
check("… and sets the ticket going, as one change", world.saved.some((s) => s.kind === "update" && s.id === 122 && s.changes.status_id === 13 && s.changes.assignee_id === 1), world.saved);
check("the icon stays away while the checkout is on the branch", !icon() && v.start === null);
// The terminal shows the new branch, then goes back to master.
await at("/Users/demo/example-shop/web", "122-show-the-stock-level-on-the-product-page");
check("the terminal on the new branch: still no icon", !icon());
await at("/Users/demo/example-shop/web", "master");
check("… and it comes back on another branch", icon());

// Another ticket shown while git works: the changes still go to the ticket Start was for.
{
  await at("/Users/demo/example-shop/web", "master");
  world.shared["codebasehq.open"] = { project: "example-shop", id: 119, uid: "example-shop-119" }; v.check(cx); await settle();
  click(v.render(t), "view-start", cx); await settle();
  let release;
  const slow = world.exec;
  world.exec = (cmd, args) => (String(args?.[1]).includes("git switch") ? new Promise((r) => { release = () => r({ code: 0, stdout: "new origin/master\n", stderr: "" }); }) : slow(cmd, args));
  const before = world.saved.length;
  click(v.render(t), "start-run", cx); await settle(3);   // git held open on purpose
  world.shared["codebasehq.open"] = { project: "example-shop", id: 121, uid: "example-shop-121" }; v.check(cx); await settle(6);
  release(); await settle();
  const made = world.saved.slice(before);
  check("switching ticket while git works: the change goes to the ticket Start was for", made.length === 1 && made[0].id === 119 && made[0].changes.status_id === 13, made);
  world.exec = slow;
}
