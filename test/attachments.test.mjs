// Attachments: what clicking one does, and the attachment dialog in each of its states.
import { check, settle, makeCx, t, find, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "ticket", project: "example-shop", id: 118, projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle(5);

const n = v.notes[0];
n.attachments = [
  { name: "Offer.pdf", url: "/upload/aaaaaaaaaaaaaaaaaaaa1/show/original", id: "aaaaaaaaaaaaaaaaaaaa1", type: "application/pdf" },
  { name: "Site backup.zip", url: "/upload/aaaaaaaaaaaaaaaaaaaa2/show/original", id: "aaaaaaaaaaaaaaaaaaaa2", type: "application/zip" },
  { name: "old.doc", url: "/files/old.doc", id: null, type: "" },
];
n.prep = null;
let tree = v.render(t);
check("a file the dialog shows has no icons after it", !find(tree, `att-download-${n.id}-0`) && !find(tree, `att-open-${n.id}-0`));
click(tree, `att-${n.id}-0`, cx);
const spec = world.overlays.at(-1);
check("clicking it opens the attachment dialog", spec?.kind === "dialog" && spec.props.view === "file" && spec.props.name === "Offer.pdf", spec);
check("a zip has a download icon", Boolean(find(tree, `att-download-${n.id}-1`)) && !find(tree, `att-open-${n.id}-1`));
click(tree, `att-${n.id}-1`, cx);
check("clicking a zip downloads it", v.saving.has("aaaaaaaaaaaaaaaaaaaa2"));
await settle(4);
check("… and says where it went", world.notifications.some((x) => /^Saved/.test(x.title) || /^Could not download/.test(x.title)), world.notifications);
click(tree, `att-${n.id}-2`, cx);
check("without an upload id it opens in the browser", cx.opened === "https://example.codebasehq.com/files/old.doc", cx.opened);

// The dialog.
world.props = { view: "file", id: "aaaaaaaaaaaaaaaaaaaa1", name: "Offer.pdf", url: "https://example.codebasehq.com/upload/x", overlay: "ov1" };
const { FileView } = await import("../mods/codebasehq/fileview.js");
const f = new FileView();
f.init(makeCx());
check("it says it is opening the file", /Opening Offer.pdf/.test(text(f.render(t))));
await settle(5);
const states = [
  [{ kind: "pages", count: 80, pages: [{ path: "a/1.png", width: 1400, height: 1811 }] }, /80 pages[\s\S]*79 more pages/],
  [{ kind: "image", count: 1, pages: [{ path: "a/p.png", width: 128, height: 128 }] }, /Offer.pdf/],
  [{ kind: "first", count: 1, pages: [{ path: "a/f.png", width: 1400, height: 1400 }] }, /first page only/i],
  [{ kind: "text", count: 1, text: "line one\nline two" }, /line one[\s\S]*line two/],
  [{ kind: "none", count: 0 }, /no preview/],
];
for (const [view, says] of states) { f.view = view; f.error = null; check(`the dialog shows ${view.kind}`, says.test(text(f.render(t))), text(f.render(t)).slice(0, 120)); }
tree = f.render(t);
click(tree, "file-close", cx);
check("× closes the dialog", world.closed.includes("ov1"));
