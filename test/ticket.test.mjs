// The ticket pane: the ticket and its notes, the header's actions, changing a detail, and
// posting a response with files.
import { check, settle, makeCx, t, find, findHandler, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "ticket", project: "example-shop", id: 118, projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle(5);

let tree = v.render(t);
check("the ticket and its notes show", /#118/.test(text(tree)) && v.notes?.length === 5, v.notes?.length);
check("a paragraph with an @mention is drawn in pieces", /@alex/.test(text(tree)));
const prep = v.notes[0].prep;
v.render(t);
check("a note is parsed once, not per render", prep && v.notes[0].prep === prep);
check("the commit note shows as a commit, title and body", v.commits.size === 1 && /Lift the cookie banner above the checkout bar/.test(text(tree)));

// The header: copy and open by the title, outside its click area.
const toggle = find(tree, "details-toggle");
check("Copy and Open sit by the title, not in its click area", Boolean(find(tree, "view-copy")) && !find(toggle, "view-copy") && !find(toggle, "view-open"));
click(tree, "view-copy", cx);
check("Copy copies #id and summary", cx.clipboard === "#118 Checkout button hides behind the cookie banner on mobile" && v.details === false);
click(tree, "details-toggle", cx);
check("clicking the title shows the details", v.details === true);

// A detail changed from the details.
v.detailMenu = "status";
tree = v.render(t);
click(tree, "detail-status-14", cx);
check("a picked status shows at once", v.ticket.status === "Review");
await settle(4);
check("… is saved as a change", world.saved.some((s) => s.kind === "update" && s.id === 118 && s.changes.status_id === 14), world.saved);

// A diff, rows sorted once (no local clone in the mock: shown from rows put in place).
const c = v.commits.values().next().value;
v.diffs.set(c.ref, { open: true, loading: false, error: null, limit: 1, rows: [{ file: "a.css" }, { line: "+x", colour: "ansi2" }] });
check("an open diff draws, and says what is left", /1 more lines/.test(text(v.render(t))));

// Going to another ticket and back keeps the commits found.
world.shared["codebasehq.open"] = { project: "example-shop", id: 121, uid: "example-shop-121" }; v.check(cx); await settle(5);
world.shared["codebasehq.open"] = { project: "example-shop", id: 118, uid: "example-shop-118" }; v.check(cx);
check("going back to a ticket keeps its commits", v.commits.size === 1);
await settle(5);

// A response with files only.
v.reply.open = true;
tree = v.render(t);
findHandler(tree, "on_drop").on.on_drop({ paths: ["/tmp/x/Offer.pdf", "/tmp/x/screen.png", "/tmp/x/Offer.pdf"] }, cx);
check("dropped files are attached, once each", v.reply.files.join() === "/tmp/x/Offer.pdf,/tmp/x/screen.png");
click(v.render(t), "reply-file-x-1", cx);
check("× drops a file", v.reply.files.join() === "/tmp/x/Offer.pdf");
world.exec = (cmd, args) => (String(args?.[1]).includes("files[]=@") ? { code: 0, stdout: '[{"upload":{"identifier":"token-1"}}]', stderr: "" } : undefined);
click(v.render(t), "respond-post", cx);
await settle(6);
const note = world.saved.find((s) => s.kind === "note");
check("Post uploads the files first, then the note takes their tokens", note?.uploadTokens?.join() === "token-1" && note.content === "", note);
check("the form is cleared after", v.reply.files.length === 0 && !v.reply.open);

// Changing the title.
click(v.render(t), "view-rename", cx);
check("the pencil turns the title into a field, filled in", v.titleInput.value() === "Checkout button hides behind the cookie banner on mobile" && Boolean(find(v.render(t), "title-save")));
v.titleInput.set_value("   ");
click(v.render(t), "title-save", cx);
check("an empty title is refused", /needs a title/.test(v.titleEdit?.error ?? ""));
v.titleInput.set_value("Checkout  button hidden by the cookie banner");
click(v.render(t), "title-save", cx);
check("Save shows the new title at once", v.ticket.summary === "Checkout button hidden by the cookie banner");
await settle(5);
check("… and saves it as the change Codebase calls subject", world.saved.some((s) => s.kind === "update" && s.id === 118 && s.changes.subject === "Checkout button hidden by the cookie banner"), world.saved.at(-1));
check("… and the field goes", v.titleEdit === null);
