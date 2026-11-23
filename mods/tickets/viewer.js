// The whole ticket in a pane: its fields and every note, oldest first.
//   Opened by the list (clicking a ticket's title) with
//   pane.split {mod: "tickets", props: {view: "ticket", project, id}}.
//   Which ticket it shows is shared("tickets.open"), so clicking another title in the list
//   shows that one here instead of opening a second pane.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, props, shared, checking, settings, spaces, appHome } from "herdr";
import {
  loadCredentials, accountOf, ticketDetail, ticketNotes, accountUsers, ticketUrl, defaultBase, ago,
  noteCommits, commitUrl, plainMessage as plainText, findClone, commitDiff, uploadId, downloadUpload,
} from "./codebase.js";
import { TITLES, typeIcon, initials, colourOf, personColour } from "./ui.js";

const CHECK = 300;        // look at shared("tickets.open") (no request unless it changed)
const REFRESH = 60000;    // new notes

// What a note's "updates" names its fields.
const UPDATE_NAMES = {
  status_id: "Status", priority_id: "Priority", assignee_id: "Assigned to", category_id: "Category",
  type_id: "Type", milestone_id: "Milestone", summary: "Summary", deadline: "Deadline", start_on: "Start",
  estimated_time: "Estimate", tags: "Tags",
};

const errText = (e) => String(e?.message ?? e);
const DIFF_LINES = 1500;  // a diff shows this many lines, then "Show more"

function dateText(ms) {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Codebase's Markdown -> what TextView shows, so it reads as it does in Codebase:
 * - every line break is a break (Codebase works like GitHub; plain Markdown joins the lines),
 * - links to Codebase are absolute, and images are taken out (blocks() shows them as image
 *   boxes where they were).
 * Code (``` blocks and `inline`) is left as it is.
 */
function markdown(text, base) {
  const prose = (part) => part
    .replace(/([^\n])\n(?!\n)/g, "$1  \n")
    .split(/(`[^`\n]*`)/)
    .map((bit, i) => i % 2 ? bit : bit
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, ""))
    .join("")
    .replace(/\]\((\/[^)]*)\)/g, (_m, path) => `](${base}${path})`);
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/(^```[\s\S]*?^```[^\n]*$)/m)
    .map((part, i) => (i % 2 ? part : prose(part)))
    .join("");
}

const MENTION = /(^|[\s(,;:])@([a-z0-9][\w.-]*[a-z0-9])/i;
// Inline pieces of a line: a link [text](url), a bare URL, **bold**, `code`, or an @mention.
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)|\*\*([^*]+)\*\*|`([^`]+)`|(^|[\s(,;:])@([a-z0-9][\w.-]*[a-z0-9])/gi;

/**
 * A note's text as blocks: Markdown blocks go to TextView as they are; a paragraph or list
 * that @mentions someone is returned as { lines } so each name can be drawn in its own colour
 * (TextView draws text in one colour only).
 */
function blocks(text, base) {
  const out = [];
  let prose = [];
  const flush = () => { if (prose.length) out.push({ markdown: markdown(prose.join("\n\n"), base) }); prose = []; };
  const parts = (text ?? "").replace(/\r\n?/g, "\n").split(/(^```[\s\S]*?^```[^\n]*$)/m);
  parts.forEach((part, i) => {
    if (i % 2) { prose.push(part); return; }
    // An image in the text is a block of its own, where it is: ![name](/upload/<id>/…).
    part.split(/(!\[[^\]]*\]\([^)\s]+\))/).forEach((piece, k) => {
      if (k % 2) {
        const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(piece);
        const id = uploadId(m[2]);
        if (id) { flush(); out.push({ image: { id, name: m[1] || "image", url: m[2] } }); }
        return;
      }
      for (const block of piece.split(/\n{2,}/)) {
        const lines = block.split("\n");
        const plain = !lines.some((l) => /^(#{1,6}\s|>|\||    |\t)/.test(l));
        if (plain && MENTION.test(block)) { flush(); out.push({ lines: lines.filter((l) => l.trim()) }); }
        else if (block.trim()) prose.push(block);
      }
    });
  });
  flush();
  return out;
}

/** Attached images that the text doesn't show itself: these go below the text. */
function imagesBelow(n) {
  const inText = new Set([...(n.content ?? "").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => uploadId(m[1])).filter(Boolean));
  return (n.attachments ?? []).filter((a) => a.id && /^image\//.test(a.type) && !inText.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, url: a.url }));
}

export class Viewer {
  init(cx) {
    this.creds = undefined;
    this.key = undefined;       // "<project>-<id>" being shown
    this.ref = null;            // { project, id, projectName }
    this.ticket = null;
    this.notes = null;
    this.users = null;          // { byId, byUsername } -> name, for the whole account
    this.commits = new Map();   // note id -> the commit it came from (see noteCommits)
    this.checked = new Set();   // note ids already looked up (matched or not)
    this.diffs = new Map();     // commit ref -> { loading, text, error, limit } for the opened commits
    this.clones = new Map();    // clone url -> local folder (or null: none here)
    this.images = new Map();    // upload id -> { open, loading, path, width, height, error }
    this.width = 0;             // the pane's width, for scaling images
    this.looking = false;       // looking the commits up
    this.error = null;
    this.loading = false;
    this.copied = false;
    this.details = false;       // the fields are folded away until "Details" is clicked
    if (checking()) return;
    cx.spawn(async (cx) => {
      try { this.creds = await loadCredentials(); } catch { this.creds = null; }
      if (!this.creds) this.error = "No Codebase credentials yet: set them up in the Tickets panel.";
      this.check(cx);
      cx.notify();
    });
    cx.timer.every(CHECK, (cx) => this.check(cx));
    cx.timer.every(REFRESH, (cx) => this.load(cx));
  }

  wanted() {
    const s = shared("tickets.open");
    if (s?.project && s?.id) return s;
    const p = props() ?? {};
    return p.project && p.id ? { project: p.project, id: p.id, projectName: p.projectName } : null;
  }

  check(cx) {
    if (this.creds === undefined) return;
    const w = this.wanted();
    const key = w ? `${w.project}-${w.id}` : null;
    if (key === this.key) return;
    this.key = key;
    this.ref = w;
    this.ticket = null;
    this.notes = null;
    this.commits = new Map();
    this.checked = new Set();
    this.error = this.creds ? null : this.error;
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const ref = this.ref;
    if (!ref || !this.creds || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [ticket, notes, users] = await Promise.all([
          ticketDetail(this.creds, ref.project, ref.id),
          ticketNotes(this.creds, ref.project, ref.id),
          this.users ?? accountUsers(this.creds).catch(() => ({ byId: new Map(), byUsername: new Map() })),
        ]);
        this.users = users;
        if (this.ref === ref) {
          this.ticket = ticket; this.notes = notes; this.error = null;
          this.findCommits(ref, notes, cx);
        }
      } catch (e) {
        if (this.ref === ref) this.error = errText(e);
      }
      this.loading = false;
      // Another ticket was picked while this one loaded: load that one now.
      if (this.ref !== ref) this.load(cx);
      cx.notify();
    });
  }

  /** Which notes came from commits: looked up after the notes show, as it takes a few requests. */
  findCommits(ref, notes, cx) {
    // Only notes not looked up yet (new ones since the last refresh).
    const fresh = notes.filter((n) => !this.checked.has(n.id));
    if (this.looking || !fresh.length) return;
    this.looking = true;
    cx.spawn(async (cx) => {
      try {
        const found = await noteCommits(this.creds, ref.project, ref.id, fresh);
        if (this.ref === ref) {
          for (const [id, c] of found) this.commits.set(id, c);
          for (const n of fresh) this.checked.add(n.id);
        }
      } catch { /* the notes still show as notes */ }
      this.looking = false;
      cx.notify();
    });
  }

  /** Opens or closes a commit's diff; the first time, finds a local clone and runs git show there. */
  toggleDiff(c, cx) {
    const d = this.diffs.get(c.ref);
    if (d) { d.open = !d.open; cx.notify(); return; }
    const entry = { open: true, loading: true, text: null, error: null, limit: DIFF_LINES };
    this.diffs.set(c.ref, entry);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let folder = this.clones.get(c.cloneUrl);
        if (folder === undefined) {
          folder = await findClone(c.cloneUrl, spaces().map((x) => x.folder).filter((f) => f && !spaces().find((y) => y.folder === f)?.machine));
          this.clones.set(c.cloneUrl, folder);
        }
        if (!folder) throw new Error(`No local clone of ${c.repoName} was found next to your spaces' folders. Open the commit in Codebase instead.`);
        entry.text = await commitDiff(folder, c.ref, c.branch);
        entry.folder = folder;
      } catch (e) {
        entry.error = errText(e);
      }
      entry.loading = false;
      cx.notify();
    });
  }

  /** Opens or closes an image; the first time, downloads it through the API (see downloadUpload). */
  toggleImage(img, cx) {
    const d = this.images.get(img.id);
    if (d) { d.open = !d.open; cx.notify(); return; }
    const entry = { open: true, loading: true, path: null, width: 0, height: 0, error: null };
    this.images.set(img.id, entry);
    cx.notify();
    cx.spawn(async (cx) => {
      try { Object.assign(entry, await downloadUpload(this.creds, appHome(), img.id, img.name)); }
      catch (e) { entry.error = errText(e); }
      entry.loading = false;
      cx.notify();
    });
  }

  /** An image box: like a commit, a row to open it, and the picture, scaled to the pane. */
  imageView(t, n, img, base) {
    const d = this.images.get(img.id);
    const url = img.url?.startsWith("/") ? base + img.url : img.url;
    const room = Math.max(120, (this.width || 480) - 36 - 26);
    const w = d?.width ? Math.min(d.width, room) : 0;
    const h = d?.width ? Math.round(w * d.height / d.width) : 0;
    return v_flex().gap(6).px(12).py(8).rounded(8).border(1).border_color(d?.open ? t.input : t.border).bg(t.raised)
      .child(h_flex().id(`img-${n.id}-${img.id}`).gap(6).items_center().text_size(12).cursor_pointer()
        .tooltip(d?.open ? "Hide the image" : "Show the image")
        .on_click((_e, cx) => this.toggleImage(img, cx))
        .child(svg(`mods/tickets/icons/chevron-${d?.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(svg("mods/tickets/icons/image.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(img.name))
        .when(Boolean(url), (el) => el.child(div().id(`img-open-${n.id}-${img.id}`).flex_none().size(22).rounded(5).flex().items_center().justify_center()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Open the image in the browser")
          .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [url]).catch(() => {}); })
          .child(svg("mods/tickets/external.svg").size(13)))))
      .when(Boolean(d?.open), (el) => el.child(
        d.loading ? div().py(4).text_size(12).text_color(t.dim).child("Loading the image…")
        : d.error ? div().py(4).text_size(12).text_color(t.ansi1).child(d.error)
        : w && h ? image(d.path).w(w).h(h).rounded(4)
        : image(d.path).w_full().h(240)));
  }

  /** A diff, line by line: files as headings, additions green, removals red, hunks dim. */
  diffView(t, c, d, mono) {
    if (d.loading) return div().py(6).text_size(12).text_color(t.dim).child("Loading the diff…");
    if (d.error) return div().py(6).text_size(12).text_color(t.ansi1).child(d.error);
    const all = d.text.replace(/\n$/, "").split("\n");
    const lines = all.slice(0, d.limit);
    const rows = [];
    lines.forEach((line, i) => {
      if (line.startsWith("diff --git ")) {
        const path = / b\/(.*)$/.exec(line)?.[1] ?? line.slice(11);
        rows.push(div().mt(i ? 10 : 0).mb(2).px(8).py(3).rounded(4).bg(t.surface).font_semibold().text_color(t.foreground).child(path));
        return;
      }
      if (/^(index |--- |\+\+\+ |similarity index|new file mode|deleted file mode|old mode|new mode)/.test(line)) {
        if (/^(new file|deleted file|rename (from|to))/.test(line)) rows.push(div().px(8).text_color(t.dim).child(line));
        return;
      }
      const colour = line.startsWith("+") ? t.ansi2 : line.startsWith("-") ? t.ansi1 : line.startsWith("@@") ? t.ansi6 : t.muted;
      rows.push(div().px(8).whitespace_nowrap().text_color(colour).child(line || " "));
    });
    return v_flex()
      .child(div().id(`diff-${c.ref}`).w_full().overflow_x_scrollbar()
        .child(v_flex().min_w_full().font_family(mono).text_size(11.5).children(rows)))
      .when(all.length > d.limit, (el) => el.child(h_flex().pt(8).gap(8).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child(`${all.length - d.limit} more lines`))
        .child(div().id(`diff-more-${c.ref}`).px(8).h(22).rounded(5).flex().items_center().text_size(12)
          .border(1).border_color(t.border).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { d.limit += DIFF_LINES; cx.notify(); }).child("Show more"))));
  }

  /** One paragraph or list with @mentions: words wrap, names in their person's colour. */
  richBlock(t, lines, base, id) {
    const space = 3.6;
    const word = (text, style) => text.split(/(\s+)/).filter((w) => w && !/^\s+$/.test(w))
      .map((w) => style(div().mr(space).child(w)));
    const open = (url) => exec("open", [url.startsWith("/") ? base + url : url]).catch(() => {});
    const inline = (line, key) => {
      const els = [];
      let last = 0, m, n = 0;
      INLINE.lastIndex = 0;
      const plain = (text) => els.push(...word(text, (el) => el));
      while ((m = INLINE.exec(line))) {
        // The character before an @mention ("(" or ",") belongs to it, not a word of its own.
        const lead = m[6] ?? "";
        const glued = lead.trim();
        plain(line.slice(last, m.index) + (glued ? "" : lead));
        const k = `${key}-${n++}`;
        if (m[1]) {
          const label = m[1].replace(/^!/, "");
          els.push(...word(label, (el) => el.text_color(t.accent)).map((el, j) => el.id(`${k}-${j}`).cursor_pointer().on_click(() => open(m[2]))));
        } else if (m[3]) {
          els.push(div().id(k).mr(space).text_color(t.accent).cursor_pointer().on_click(() => open(m[3])).child(m[3]));
        } else if (m[4]) {
          els.push(...word(m[4], (el) => el.font_semibold()));
        } else if (m[5]) {
          els.push(div().mr(space).px(4).rounded(4).bg(t.raised).text_size(12).child(m[5]));
        } else if (m[7]) {
          const name = this.users?.byUsername?.get(m[7].toLowerCase());
          els.push(h_flex().id(k).mr(space)
            .when(Boolean(glued), (el) => el.child(div().child(glued)))
            .child(div().font_semibold().text_color(personColour(t, name ?? m[7]).bg).child(`@${m[7]}`))
            .tooltip(name ?? `@${m[7]}`));
        }
        last = m.index + m[0].length;
      }
      plain(line.slice(last));
      return els;
    };
    return v_flex().gap(4).children(lines.map((raw, i) => {
      // ![image](url) is a link here too (Codebase only shows images to a logged-in browser).
      const line = raw.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "");
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      const wrap = (text) => h_flex().flex_wrap().flex_1().min_w(0).children(inline(text, `${id}-${i}`));
      if (!item) return wrap(line.trim());
      const indent = Math.min(item[1].replace(/\t/g, "  ").length, 12) * 5;
      return h_flex().items_start().pl(indent)
        .child(div().w(18).flex_none().text_color(t.muted).child(/\d/.test(item[2]) ? item[2] : "•"))
        .child(wrap(item[3]));
    }));
  }

  base() {
    return shared("tickets.base") ?? defaultBase(accountOf(this.creds));
  }

  userName(id, fallback) {
    return (id != null && this.users?.byId?.get(id)) || fallback || (id != null ? `User ${id}` : "Unknown");
  }

  render(t) {
    const root = v_flex().id("ticket-view").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } });
    const note = (text, color) => div().p(16).text_size(12.5).text_color(color ?? t.dim).child(text);
    if (!this.ref) return root.child(note("Click a ticket's title in the Tickets panel to see it here."));
    if (this.error && !this.ticket) return root.child(note(this.error, t.ansi1));
    if (!this.ticket) return root.child(note(`Loading #${this.ref.id}…`));

    const k = this.ticket, base = this.base(), url = ticketUrl(base, this.ref.project, k.id);
    const iconButton = (id, path, onClick, color) =>
      div().id(id).flex_none().size(26).rounded(6).flex().items_center().justify_center()
        .text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
        .on_click((_e, cx) => onClick(cx)).child(svg(path).size(14));
    const avatar = (name, size) => div().size(size).flex_none().rounded(size / 2).bg(personColour(t, name).bg)
      .flex().items_center().justify_center().text_size(size * 0.42).font_semibold().text_color(personColour(t, name).fg).child(initials(name));

    const field = (label, value) => h_flex().gap(8).min_h(22).items_center()
      .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5).children([].concat(value)));
    const assignee = k.assigneeId != null ? this.userName(k.assigneeId, k.assignee) : null;

    const header = v_flex().flex_none().px(18).pt(14).pb(14).gap(10).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate()
          .child(`${this.ref.projectName ?? this.ref.project}${this.loading ? " · updating…" : ""}`))
        .child(iconButton("view-copy", this.copied ? "mods/tickets/check.svg" : "mods/tickets/copy.svg", (cx) => {
          cx.write_to_clipboard(`#${k.id} ${k.summary}`);
          this.copied = true;
          cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
          cx.notify();
        }, this.copied ? t.ansi2 : null))
        .child(iconButton("view-open", "mods/tickets/external.svg", () => { exec("open", [url]).catch(() => {}); })))
      .child(h_flex().gap(10).items_start()
        .child(div().flex_none().text_size(17).font_semibold().text_color(t.muted).child(`#${k.id}`))
        .child(div().flex_1().min_w(0).text_size(17).font_semibold().child(k.summary)))
      .child(h_flex().id("details-toggle").ml(-6).px(6).h(24).gap(4).rounded(5).items_center()
        .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.details = !this.details; cx.notify(); })
        .child(svg(`mods/tickets/icons/chevron-${this.details ? "down" : "right"}.svg`).size(13).flex_none())
        .child(div().child("Details")))
      .when(this.details, (el) => el.child(v_flex().gap(2)
        .child(field(TITLES.status, [div().size(7).rounded(4).flex_none().bg(colourOf(t, k.statusColour)), div().child(k.status ?? "—")]))
        .child(field(TITLES.priority, [svg("mods/tickets/icons/flag.svg").size(13).flex_none().text_color(colourOf(t, k.priorityColour)), div().child(k.priority ?? "—")]))
        .child(field(TITLES.type, [svg(typeIcon(k.typeIcon)).size(13).flex_none().text_color(t.muted), div().child(k.type ?? "—")]))
        .child(field(TITLES.category, div().child(k.category ?? "—")))
        .child(field(TITLES.assignee, assignee ? [avatar(assignee, 18), div().child(assignee)] : div().text_color(t.dim).child("Unassigned")))
        .child(field("Reported by", div().child(this.userName(k.reporterId, k.reporter))))
        .when(Boolean(k.milestone), (el) => el.child(field("Milestone", div().child(k.milestone))))
        .child(field("Created", div().child(`${dateText(k.created)} · updated ${ago(k.updated)} ago`)))));

    const mono = settings().font ?? "JetBrains Mono";
    // A note made by a commit: who, the commit (linked), where, and its message.
    const commitView = (n, c, i) => {
      const who = c.author ?? this.userName(n.userId);
      const diff = this.diffs.get(c.ref);
      const [title, ...rest] = plainText(c.message).split("\n");
      const body = rest.join("\n").trim();
      return v_flex().id(`note-${n.id}`).flex_none().px(18).py(12).gap(8)
        .when(i > 0, (el) => el.border_t(1).border_color(t.border))
        .child(h_flex().gap(8).items_center()
          .child(avatar(who, 22))
          .child(h_flex().flex_1().min_w(0).gap(5).items_center().text_size(12.5)
            .child(div().flex_none().font_semibold().child(who))
            .child(div().flex_none().text_color(t.dim).child("committed")))
          .child(div().id(`note-time-${n.id}`).flex_none().text_size(11.5).text_color(t.dim).tooltip(dateText(c.at || n.created)).child(ago(c.at || n.created))))
        .child(v_flex().gap(6).px(12).py(10).rounded(8).border(1).border_color(diff?.open ? t.input : t.border).bg(t.raised)
          .child(v_flex().id(`commit-${n.id}`).gap(6).cursor_pointer()
            .tooltip(diff?.open ? "Hide the diff" : "Show the diff")
            .on_click((_e, cx) => this.toggleDiff(c, cx))
            .child(h_flex().gap(6).items_center().text_size(11.5)
              .child(svg(`mods/tickets/icons/chevron-${diff?.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
              .child(svg("mods/tickets/icons/commit.svg").size(13).flex_none().text_color(t.muted))
              .child(div().flex_none().px(5).rounded(4).bg(t.surface).font_family(mono).text_size(11.5).text_color(t.accent).child(c.short))
              .child(svg("mods/tickets/icons/branch.svg").size(12).flex_none().text_color(t.dim))
              .child(div().flex_1().min_w(0).text_color(t.dim).truncate().child(c.branch))
              .child(div().id(`commit-open-${n.id}`).flex_none().size(22).rounded(5).flex().items_center().justify_center()
                .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Open the commit in Codebase")
                .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [commitUrl(base, this.ref.project, c.repo, c.ref)]).catch(() => {}); })
                .child(svg("mods/tickets/external.svg").size(13))))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title)))
          .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.muted)
            .child(TextView.markdown(`commit-body-${n.id}`, markdown(body, base)).selectable(true)
              .on_link_click((link) => { exec("open", [link]).catch(() => {}); }))))
          .when(Boolean(diff?.open), (el) => el.child(div().pt(4).border_t(1).border_color(t.border).child(this.diffView(t, c, diff, mono)))));
    };

    const noteView = (n, i) => {
      const commit = this.commits.get(n.id);
      if (commit) return commitView(n, commit, i);
      const who = this.userName(n.userId);
      const changes = Object.entries(n.updates ?? {}).filter(([, v]) => Array.isArray(v));
      const content = blocks(n.content, base).filter((b) => b.image || b.lines || b.markdown.trim());
      // Images (in the text or attached) show as image boxes; other attachments as files.
      // Images in the text show where they are; attached images the text doesn't show go below,
      // other attachments as files.
      const images = imagesBelow(n);
      const named = new Map(n.attachments.map((a) => [a.id, a.name]));
      const attachments = n.attachments.filter((a) => !/^image\//.test(a.type) && !content.some((b) => b.image?.id === a.id));
      return v_flex().id(`note-${n.id}`).flex_none().px(18).py(12).gap(8)
        .when(i > 0, (el) => el.border_t(1).border_color(t.border))
        .child(h_flex().gap(8).items_center()
          .child(avatar(who, 22))
          .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().truncate().child(who))
          .child(div().id(`note-time-${n.id}`).flex_none().text_size(11.5).text_color(t.dim).tooltip(dateText(n.created)).child(ago(n.created))))
        .when(changes.length > 0, (el) => el.child(v_flex().gap(2).children(changes.map(([key, [from, to]]) =>
          div().text_size(11.5).text_color(t.muted)
            .child(`${UPDATE_NAMES[key] ?? key}: ${from || "—"} → ${to || "—"}`)))))
        .when(content.length > 0, (el) => el.child(v_flex().gap(10).text_size(13).text_color(t.foreground)
          .children(content.map((b, j) => b.image
            ? this.imageView(t, n, { ...b.image, name: named.get(b.image.id) ?? b.image.name }, base)
            : b.lines
            ? this.richBlock(t, b.lines, base, `note-${n.id}-${j}`)
            : TextView.markdown(`note-text-${n.id}-${j}`, b.markdown.trim()).selectable(true)
              .on_link_click((link) => { exec("open", [link]).catch(() => {}); })))))
        .when(images.length > 0, (el) => el.child(v_flex().gap(6).children(images.map((img) => this.imageView(t, n, img, base)))))
        .when(attachments.length > 0, (el) => el.child(v_flex().gap(2).children(attachments.map((a, j) =>
          div().id(`att-${n.id}-${j}`).text_size(12).text_color(t.accent).hover((s) => s.text_color(t.foreground))
            .on_click(() => { if (a.url) exec("open", [a.url.startsWith("/") ? base + a.url : a.url]).catch(() => {}); })
            .child(`📎 ${a.name}`)))));
    };

    const notes = this.notes ?? [];
    return root
      .child(header)
      .child(v_flex().id("ticket-notes").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.ansi1)))
        .when(notes.length === 0, (el) => el.child(note("No notes.")))
        .children(notes.map(noteView)));
  }
}
