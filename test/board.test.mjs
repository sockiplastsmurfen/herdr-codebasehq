// The Kanban board: columns, dragging a card to another status, a card's menu and filters.
import { check, settle, makeCx, t, find, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "kanban", project: "example-shop", projectName: "Example Shop" };
world.shared["codebasehq.board"] = { project: "example-shop", projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle();

let tree = v.render(t);
check("a column per status, in the project's order", v.board.columns.map((c) => c.name).join() === "New,Accepted,In Progress,Review,Completed,Invalid", v.board.columns.map((c) => c.name));
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
await settle();
check("… and it is saved", world.saved.some((s) => s.kind === "update" && s.id === card.id && s.changes.status_id === accepted.id));

// A card's menu.
v.cardMenu = { id: card.id, kind: "assignee" };
check("a card's menu lists the people", /Sam Lee/.test(text(v.render(t))));

// The Unassigned filter, with the project's values kept.
const meta = v.board.meta;
v.setBoardFilter("example-shop", { ...v.boardFilter("example-shop"), assignee: ["none"] }, cx);
await settle();
check("the Unassigned filter leaves the unassigned", v.board.tickets.length > 0 && v.board.tickets.every((k) => k.assigneeId == null), v.board.tickets.map((k) => k.id));
check("a filter click keeps the project's values (no new requests)", v.board.meta === meta);

// A big column draws 30 cards, with Show more.
const newId = v.board.statuses.find((s) => s.name === "New").id;
const many = Array.from({ length: 45 }, (_, i) => ({ ...v.board.tickets[0], id: 1000 + i, statusId: newId, status: "New", closed: false, updated: Date.now() - i * 1000 }));
v.board = { ...v.board, tickets: [...v.board.tickets, ...many], columns: null };
tree = v.render(t);
check("a column of 45+ draws 30 cards and offers the rest", Boolean(find(tree, "card-1029")) && !find(tree, "card-1030") && /Show 16 more \(16 not shown\)/.test(text(tree)), text(find(tree, `col-more-${newId}`)));
click(tree, `col-more-${newId}`, cx);
tree = v.render(t);
check("Show more draws the next ones", Boolean(find(tree, "card-1044")));
v.board = { ...v.board, columns: null };
check("… and a reload of the board keeps them shown", Boolean(find(v.render(t), "card-1044")));
