// The ticket pane: the ticket and its notes, the header's actions, changing a detail, and
// posting a response with files.
import { check, settle, makeCx, t, find, findHandler, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "ticket", project: "example-shop", id: 118, projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle();

let tree = v.render(t);
check("the ticket and its notes show", /#118/.test(text(tree)) && v.notes?.length === 5, v.notes?.length);
check("a paragraph with an @mention is drawn in pieces, the name one of them", v.notes[2].prep?.content[0]?.rich?.[0]?.pieces.some((p) => p.mention === "alex"));
const prep = v.notes[0].prep;
v.render(t);
check("a note is parsed once, not per render", prep && v.notes[0].prep === prep);
check("the commit note shows as a commit, title and body", Boolean(find(tree, "commit-4004")) && /Lift the cookie banner above the checkout bar/.test(text(tree)) && !text(tree).includes("[touch:118]"));

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
await settle();
check("… is saved as a change", world.saved.some((s) => s.kind === "update" && s.id === 118 && s.changes.status_id === 14), world.saved);

// A diff, rows sorted once (no local clone in the mock: shown from rows put in place).
const c = v.commits.values().next().value;
v.diffs.set(c.ref, { open: true, loading: false, error: null, limit: 1, rows: [{ file: "a.css" }, { line: "+x", colour: "ansi2" }] });
check("an open diff draws, and says what is left", /1 more lines/.test(text(v.render(t))));

// Going to another ticket and back keeps the commits found.
world.shared["codebasehq.open"] = { project: "example-shop", id: 121, uid: "example-shop-121" }; v.check(cx); await settle();
world.shared["codebasehq.open"] = { project: "example-shop", id: 118, uid: "example-shop-118" }; v.check(cx);
check("going back to a ticket keeps its commits", v.commits.size === 1);
await settle();

// A response with files only.
v.reply.open = true;
tree = v.render(t);
findHandler(tree, "on_drop").on.on_drop({ paths: ["/tmp/x/Offer.pdf", "/tmp/x/screen.png", "/tmp/x/Offer.pdf"] }, cx);
check("dropped files are attached, once each", v.reply.files.join() === "/tmp/x/Offer.pdf,/tmp/x/screen.png");
click(v.render(t), "reply-file-x-1", cx);
check("× drops a file", v.reply.files.join() === "/tmp/x/Offer.pdf");
world.exec = (cmd, args) => (String(args?.[1]).includes("files[]=@") ? { code: 0, stdout: '[{"upload":{"identifier":"token-1"}}]', stderr: "" } : undefined);
click(v.render(t), "respond-post", cx);
await settle();
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
await settle();
check("… and saves it as the change Codebase calls subject", world.saved.some((s) => s.kind === "update" && s.id === 118 && s.changes.subject === "Checkout button hidden by the cookie banner"), world.saved.at(-1));
check("… and the field goes", v.titleEdit === null);

// @ and the start of a name in a response offers the project's people.
v.reply = v.replyFor(v.key); v.reply.open = true;
v.response.type("Thanks @sa", cx);
await settle();
tree = v.render(t);
check("@sa offers Sam Lee", Boolean(find(tree, "mention-sam")) && !find(tree, "mention-kim"), text(tree).slice(0, 200));
click(tree, "mention-sam", cx);
check("picking someone puts @username in the text", v.response.value() === "Thanks @sam " && !v.reply.mention, v.response.value());
v.response.type("mail me@example.com", cx);
check("an @ inside a word offers no one", !v.reply.mention);

// An image in a note's text shows unfolded; one attached below it stays folded.
v.notes[0].content = "Here it is:\n\n![screen](/upload/bbbbbbbbbbbbbbbbbbbb1/show/original)\n\nAs you see.";
v.notes[0].attachments = [{ name: "other.png", url: "/upload/bbbbbbbbbbbbbbbbbbbb2/show/original", id: "bbbbbbbbbbbbbbbbbbbb2", type: "image/png" }];
v.notes[0].prep = null;
v.openInlineImages(v.notes, cx);
check("an image in the text unfolds by itself", v.images.get("bbbbbbbbbbbbbbbbbbbb1")?.open === true);
check("an attached image below the text stays folded", !v.images.has("bbbbbbbbbbbbbbbbbbbb2"));
await settle();
// (The mock has no pictures, so the download failed: it came in after all.)
Object.assign(v.images.get("bbbbbbbbbbbbbbbbbbbb1"), { loading: false, error: null, path: "data/x.png", width: 10, height: 10 });
click(v.render(t), `img-${v.notes[0].id}-bbbbbbbbbbbbbbbbbbbb1`, cx);
check("its arrow still folds it", v.images.get("bbbbbbbbbbbbbbbbbbbb1")?.open === false);
click(v.render(t), `img-${v.notes[0].id}-bbbbbbbbbbbbbbbbbbbb1`, cx);
click(v.render(t), `img-show-${v.notes[0].id}-bbbbbbbbbbbbbbbbbbbb1`, cx);
const shown = world.overlays.at(-1);
check("clicking the image shows it in the dialog, as a picture", shown?.kind === "dialog" && shown.props.id === "bbbbbbbbbbbbbbbbbbbb1" && shown.props.name === "screen.png", shown);

// Cancel while a response is being posted doesn't throw it away.
{
  v.reply.open = true; v.response.set_value("A reply");
  let release;
  const before = world.exec;
  world.exec = (cmd, args) => (String(args?.[1]).includes("files[]=@") ? new Promise((r) => { release = () => r({ code: 1, stdout: "", stderr: "upload refused\n" }); }) : undefined);
  v.reply.files = ["/tmp/x/a.pdf"];
  click(v.render(t), "respond-post", cx); await settle(3);   // the upload held open on purpose
  click(v.render(t), "respond-cancel", cx);
  check("Cancel while posting leaves the response alone", v.reply.posting && v.reply.files.length === 1);
  release(); await settle();
  check("… so a failure shows on it", /upload refused/.test(v.reply.error ?? ""), v.reply.error);
  world.exec = before;
}

// Files chosen while another ticket came to show go to the ticket the chooser was opened for.
{
  const key = v.key, r = v.reply;
  r.files = []; r.posting = false;
  let release;
  world.choose = () => new Promise((res) => { release = () => res(["/tmp/x/chosen.pdf"]); });
  click(v.render(t), "respond-attach", cx); await settle(3);   // the chooser held open on purpose
  world.shared["codebasehq.open"] = { project: "example-shop", id: 121, uid: "example-shop-121" }; v.check(cx); await settle(6);
  release(); await settle();
  check("chosen files go to the ticket the chooser was for", r.files.join() === "/tmp/x/chosen.pdf" && v.reply.files.length === 0 && v.key !== key, { was: r.files, now: v.reply.files });
  world.choose = null;
}

// A diff that failed is tried again on the next click.
{
  world.shared["codebasehq.open"] = { project: "example-shop", id: 118, uid: "example-shop-118" }; v.check(cx); await settle();
  const c = v.commits.values().next().value;
  v.diffs.set(c.ref, { open: true, loading: false, rows: null, error: "No local clone", limit: 10 });
  v.toggleDiff(c, cx);
  check("a failed diff is fetched again, not just folded", v.diffs.get(c.ref).loading === true);
  await settle();
}
