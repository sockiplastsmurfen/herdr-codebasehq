// An attachment in a Herdr dialog: openOverlay({ mod: "codebasehq", kind: "dialog", props: {
// view: "file", id, name, url } }) from the ticket pane. Herdr draws pictures and text, so the
// file is shown as page pictures (attachmentView in codebase.js: PDFs and Word documents page
// by page, other files as their first page), or as text. Download saves it in ~/Downloads,
// Quick Look shows it as macOS does, the arrow opens it in the browser; Esc closes the dialog.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, appHome, notify, checking, settings } from "herdr";
import { loadCredentials, attachmentView, saveToDownloads, quickLook } from "./codebase.js";
import { errText, openLink, iconLink, paneNote } from "./ui.js";

const TEXT_LINES = 5000; // a text file shows this many lines

export class FileView {
  init(cx) {
    const p = props() ?? {};
    this.file = { id: p.id, name: p.name ?? "attachment", url: p.url ?? null };
    this.view = null;           // attachmentView(): { kind, pages, count, text }
    this.error = null;
    this.width = 0;             // the pages' room, for scaling them
    this.busy = null;           // "download" | "quicklook" while it runs
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        this.creds = await loadCredentials();
        if (!this.creds) throw new Error("No Codebase credentials yet: set them up in the Tickets panel.");
        this.view = await attachmentView(this.creds, appHome(), this.file.id, this.file.name);
      } catch (e) {
        this.error = errText(e);
      }
      cx.notify();
    });
  }

  /** Runs one of the header's actions (download, Quick Look), one at a time. */
  act(kind, cx) {
    if (this.busy || !this.creds) return;
    this.busy = kind;
    cx.notify();
    cx.spawn(async (cx) => {
      const { id, name } = this.file;
      try {
        if (kind === "download") {
          const path = await saveToDownloads(this.creds, appHome(), id, name);
          notify({ title: `Saved ${path.split("/").pop()}`, body: "In Downloads", level: "success", timeout: 5000 });
        } else {
          await quickLook(this.creds, appHome(), id, name);
        }
      } catch (e) {
        notify({ title: `Could not ${kind === "download" ? "download" : "preview"} ${name}`, body: errText(e), level: "error", timeout: 10000 });
      }
      this.busy = null;
      cx.notify();
    });
  }

  render(t) {
    const f = this.file, v = this.view;
    const pages = v?.pages ?? [];
    const info = !v ? "" : v.kind === "pages" ? `${v.count} page${v.count === 1 ? "" : "s"}` : v.kind === "first" ? "first page" : "";
    const header = h_flex().flex_none().h(44).px(14).gap(6).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/codebasehq/icons/paperclip.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_shrink_1().min_w(0).truncate().text_size(13).font_semibold().child(f.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.busy === "download" ? "Saving…" : info))
      .child(iconLink(t, "file-download", "mods/codebasehq/icons/download.svg", (cx) => this.act("download", cx), null, "Download (to Downloads)"))
      .child(iconLink(t, "file-quicklook", "mods/codebasehq/icons/eye.svg", (cx) => this.act("quicklook", cx), null, "Show it in Quick Look (as macOS does)"))
      .when(Boolean(f.url), (el) => el.child(iconLink(t, "file-browser", "mods/codebasehq/external.svg", (cx) => openLink(cx, f.url), null, "Open it in the browser")))
      .child(iconLink(t, "file-close", "mods/codebasehq/icons/x.svg", () => { const id = props()?.overlay; if (id) closeOverlay(id); }, null, "Close (Esc)"));

    const room = Math.max(200, (this.width || 800) - 48);
    const page = (pg, i) => {
      // Never larger than drawn (a small picture stays small), at most the dialog's width.
      const w = Math.min(pg.width || room, room), h = pg.width ? Math.round(w * pg.height / pg.width) : room;
      return image(pg.path).w(w).h(h).flex_none().rounded(3).when(v.kind !== "image", (el) => el.bg("#ffffff"));
    };
    const note = (text, color) => paneNote(t, text, color);
    const mono = settings().font ?? "JetBrains Mono";
    let body;
    if (this.error) body = note(this.error, t.ansi1);
    else if (!v) body = note(`Opening ${f.name}…`);
    else if (v.kind === "text") {
      const lines = v.text.replace(/\r\n?/g, "\n").split("\n");
      body = v_flex().w_full().font_family(mono).text_size(12)
        .children(lines.slice(0, TEXT_LINES).map((l) => div().whitespace_nowrap().child(l || " ")))
        .when(lines.length > TEXT_LINES, (el) => el.child(div().pt(8).text_color(t.dim).child(`${lines.length - TEXT_LINES} more lines: download it to see them.`)));
    } else if (v.kind === "none") body = note("This kind of file has no preview here. Download it, or show it in Quick Look.");
    else {
      body = v_flex().items_center().gap(12)
        .when(v.kind === "first", (el) => el.child(div().text_size(12).text_color(t.dim).child("The first page only: Quick Look shows the rest.")))
        .children(pages.map(page))
        .when(v.count > pages.length && v.kind === "pages", (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(`${v.count - pages.length} more pages: Quick Look shows them.`)));
    }
    return v_flex().size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .child(header)
      .child(div().id("file-body").flex_1().min_h(0).overflow_y_scrollbar().p(24).bg(t.background)
        .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
        .child(body));
  }
}
