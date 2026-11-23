// The Kanban board: columns, dragging a card to another status, a card's menu and filters.
import { check, settle, makeCx, t, find, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "kanban", project: "example-shop", projectName: "Example Shop" };
world.shared["codebasehq.board"] = { project: "example-shop", projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle(5);

let tree = v.render(t);
check("a column per status, in order", ["New", "Accepted", "In Progress", "Review", "Completed", "Invalid"].every((s) => text(tree).includes(s)));
const columns = v.board.columns;
v.render(t);
check("the columns are worked out once, not per render", columns && v.board.columns === columns);
check("the header counts the open tickets", /11 open/.test(text(tree)));

// Drag a New card to Accepted.
const card = v.board.tickets.find((k) => k.status === "New");
const accepted = v.board.statuses.find((s) => s.name === "Accepted");
v.drag = { k: card, from: card.statusId, start: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, at: { x: 9, y: 9 }, active: true, over: accepted.id };
tree = v.render(t);
check("while dragging, the column says where the card goes", /Move to Accepted/.test(text(tree)));
click(tree, `col-${accepted.id}`, cx, "on_mouse_up");
check("letting go there changes the status at once", card.status === "Accepted");
v.render(t);
check("… and the card is first in its new column", v.board.columns.find((c) => c.id === accepted.id).tickets[0] === card);
await settle(4);
check("… and it is saved", world.saved.some((s) => s.kind === "update" && s.id === card.id && s.changes.status_id === accepted.id));

// A card's menu.
v.cardMenu = { id: card.id, kind: "assignee" };
check("a card's menu lists the people", /Sam Lee/.test(text(v.render(t))));

// The Unassigned filter, with the project's values kept.
const meta = v.board.meta;
v.setBoardFilter("example-shop", { ...v.boardFilter("example-shop"), assignee: ["none"] }, cx);
await settle(6);
check("the Unassigned filter leaves the unassigned", v.board.tickets.length > 0 && v.board.tickets.every((k) => k.assigneeId == null), v.board.tickets.map((k) => k.id));
check("a filter click keeps the project's values (no new requests)", v.board.meta === meta);
