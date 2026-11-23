// Attachments: what clicking one does, and the attachment dialog in each of its states.
import { check, settle, makeCx, t, find, findTag, text, click } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

world.props = { view: "ticket", project: "example-shop", id: 118, projectName: "Example Shop" };
const { Viewer } = await import("../mods/codebasehq/viewer.js");
const cx = makeCx();
const v = new Viewer();
v.init(cx);
await settle();

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
// The save script answers with where it put the file (or fails, the second time).
let saveFails = false;
world.exec = (_cmd, args) => (String(args?.[1]).includes("$HOME/Downloads")
  ? (saveFails ? { code: 1, stdout: "", stderr: "No room\n" } : { code: 0, stdout: "/Users/demo/Downloads/Site backup.zip", stderr: "" }) : undefined);
click(tree, `att-${n.id}-1`, cx);
check("clicking a zip downloads it", v.saving.has("aaaaaaaaaaaaaaaaaaaa2"));
await settle();
check("… and says which file it saved", world.notifications.at(-1)?.title === "Saved Site backup.zip", world.notifications.at(-1));
saveFails = true;
click(v.render(t), `att-download-${n.id}-1`, cx);
await settle();
check("a save that fails says so", world.notifications.at(-1)?.title === "Could not download Site backup.zip" && /No room/.test(world.notifications.at(-1)?.body), world.notifications.at(-1));
world.exec = null;
click(tree, `att-${n.id}-2`, cx);
check("without an upload id it opens in the browser", cx.opened === "https://example.codebasehq.com/files/old.doc", cx.opened);

// The dialog.
world.props = { view: "file", id: "aaaaaaaaaaaaaaaaaaaa1", name: "Offer.pdf", url: "https://example.codebasehq.com/upload/x", overlay: "ov1" };
const { FileView } = await import("../mods/codebasehq/fileview.js");
const f = new FileView();
f.init(makeCx());
check("it says it is opening the file", /Opening Offer.pdf/.test(text(f.render(t))));
await settle();
const states = [
  [{ kind: "pages", count: 80, pages: [{ path: "a/1.png", width: 1400, height: 1811 }] }, /80 pages[\s\S]*79 more pages/],
  [{ kind: "image", count: 1, pages: [{ path: "a/p.png", width: 128, height: 128 }] }, null],
  [{ kind: "first", count: 1, pages: [{ path: "a/f.png", width: 1400, height: 1400 }] }, /first page only/i],
  [{ kind: "text", count: 1, text: "line one\nline two" }, /line one[\s\S]*line two/],
  [{ kind: "none", count: 0 }, /no preview/],
];
for (const [view, says] of states) {
  f.view = view; f.error = null;
  const drawn = f.render(t);
  // A picture: the picture itself is drawn; the others: what they say.
  check(`the dialog shows ${view.kind}`, says ? says.test(text(drawn)) : Boolean(findTag(drawn, "img:a/p.png")), text(drawn).slice(0, 120));
}
tree = f.render(t);
click(tree, "file-close", cx);
check("× closes the dialog", world.closed.includes("ov1"));
