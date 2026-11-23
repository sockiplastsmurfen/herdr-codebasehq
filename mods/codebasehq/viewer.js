// The whole ticket in a pane: its fields and every note, oldest first.
//   Opened by the list (clicking a ticket's title) with
//   pane.split {mod: "codebasehq", props: {view: "ticket", project, id}}.
//   Which ticket it shows is shared("codebasehq.open"), so clicking another title in the list
//   shows that one here instead of opening a second pane. Opened with props.view "kanban", the
//   copy is the board pane instead, following shared("codebasehq.board"); both can be open at once.
//   "Post a response" (the header's speech-bubble icon) opens a form at the bottom that posts a note (Markdown) and, as in Codebase, any
//   details picked under it (status, priority, type, category, assignee, milestone); ⌘↩ posts too.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { props, shared, setShared, checking, settings, spaces, appHome, notify } from "herdr";
import {
  loadCredentials, accountOf, ticketDetail, ticketNotes, accountUsers, ticketUrl, defaultBase, ago,
  noteCommits, commitUrl, plainMessage as plainText, findClone, commitDiff, uploadId, downloadUpload,
  downloadAvatars, postNote, choices, updateTicket,
} from "./codebase.js";
import {
  TITLES, FIELDS, personColour, personBadge, wantPictures, CHANGED, copyId, announceChange, changeIsAbout, errText, openLink, iconLink, fieldMark, setField,
} from "./ui.js";
import { fetchBoard, boardView } from "./kanban.js";
import { NO_FILTER, searchOf } from "./filters.js";

const CHECK = 300;        // look at what to show (no request unless it changed)
const REFRESH = 60000;    // new notes

// What a note's "updates" names its fields.
const UPDATE_NAMES = {
  status_id: "Status", priority_id: "Priority", assignee_id: "Assigned to", category_id: "Category",
  type_id: "Type", ticket_type_id: "Type", milestone_id: "Milestone", summary: "Summary", subject: "Summary",
  deadline: "Deadline", start_on: "Start", estimated_time: "Estimate", estimated_time_string: "Estimate", tags: "Tags",
};

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

/** Nobody, when the account's people can't be read: notes still show, with "User <id>". */
const NO_USERS = () => ({ byId: new Map(), byUsername: new Map(), idByName: new Map(), avatars: new Map() });

export class Viewer {
  init(cx) {
    this.creds = undefined;
    this.notesScroll = ScrollHandle.new(); // the notes, for "Go to the latest note"
    this.me = copyId();         // to know our own change announcements (the board's)
    this.seenChange = shared(CHANGED)?.at ?? 0;
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
    this.people = null;         // = this.users once loaded (wantPictures reads it)
    try { this.boardFilters = JSON.parse(localStorage.getItem("boardFilters") ?? "{}") ?? {}; } catch { this.boardFilters = {}; }
    this.boardFilterMenu = null; // the board filter whose values are open
    this.pictures = new Map();  // user id -> picture path (or null: initials)
    this.width = 0;             // the pane's width, for scaling images
    this.looking = false;       // looking the commits up
    this.error = null;
    this.loading = false;
    this.boardAgain = false;    // the board's filter changed while it loaded: load it again
    this.copied = false;
    this.details = false;       // the fields are folded away until the ticket's title is clicked
    this.detailMenu = null;     // the detail whose values are open under it
    this.savingDetail = null;   // { key, kind } while a changed detail is saved
    this.loadAgain = false;     // a response was posted while the ticket loaded: load it again
    // Post a response, per ticket (see replyFor): what is being written stays with its ticket.
    this.replies = new Map();   // "<project>-<id>" -> reply
    this.reply = this.replyFor(null);
    this.metas = new Map();     // project -> choices() (what details can be set to), or { loading } / { error }
    this.response = TextareaState.new({ placeholder: "Write a response (Markdown)", rows: 4 });
    this.response.set_auto_grow(4, 14);
    this.response.on("submit", (e, cx) => { if (e?.secondary) this.postResponse(cx); });
    if (checking()) return;
    cx.spawn(async (cx) => {
      try { this.creds = await loadCredentials(); } catch { this.creds = null; }
      if (!this.creds) this.error = "No Codebase credentials yet: set them up in the Tickets panel.";
      this.check(cx);
      cx.notify();
    });
    cx.timer.every(CHECK, (cx) => { this.check(cx); this.followChanges(cx); });
    cx.timer.every(REFRESH, (cx) => this.load(cx));
  }

  /** A ticket changed (in the panel, or noticed by it): the board (or the ticket, if it is that one) reloads. */
  followChanges(cx) {
    const c = shared(CHANGED);
    if (!c?.at || c.at <= this.seenChange) return;
    this.seenChange = c.at;
    if (c.from === this.me || !this.ref || c.project !== this.ref.project) return;
    if (this.ref.view === "kanban" || changeIsAbout(c, this.ref.id)) this.load(cx);
  }

  /** What to show: a ticket ({project, id}) or a project's board ({view: "kanban", project}). */
  wanted() {
    const board = props()?.view === "kanban";
    const s = shared(board ? "codebasehq.board" : "codebasehq.open");
    if (board && s?.project) return { ...s, view: "kanban" };
    if (!board && s?.project && s?.id) return s;
    // Nothing shared (yet): what the pane was opened with.
    const p = props() ?? {};
    if (p.view === "kanban" && p.project) return { view: "kanban", project: p.project, projectName: p.projectName };
    return p.project && p.id ? { project: p.project, id: p.id, projectName: p.projectName } : null;
  }

  check(cx) {
    if (this.creds === undefined) return;
    const w = this.wanted();
    const key = !w ? null : w.view === "kanban" ? `kanban:${w.project}` : `${w.project}-${w.id}`;
    if (key === this.key) return;
    // A response being written stays with its ticket.
    this.reply.text = this.response.value();
    this.reply = this.replyFor(key);
    this.response.set_value(this.reply.text);
    this.detailMenu = null;
    this.key = key;
    this.ref = w;
    this.ticket = null;
    this.notes = null;
    this.commits = new Map();
    this.checked = new Set();
    // Going back to the same board shows it at once and refreshes it.
    if (this.board?.project !== w?.project || w?.view !== "kanban") this.board = null;
    this.error = this.creds ? null : this.error;
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const ref = this.ref;
    if (!ref || !this.creds || this.loading) return;
    this.loading = true;
    if (ref.view === "kanban") return this.loadBoard(ref, cx);
    cx.spawn(async (cx) => {
      try {
        const [ticket, notes, users] = await Promise.all([
          ticketDetail(this.creds, ref.project, ref.id),
          ticketNotes(this.creds, ref.project, ref.id),
          this.users ?? accountUsers(this.creds).catch(NO_USERS),
        ]);
        this.users = users;
        if (this.ref === ref) {
          this.ticket = ticket; this.notes = notes; this.error = null;
          this.loadMeta(ref.project, cx);
          this.findCommits(ref, notes, cx);
          // Pictures for the people shown: note authors, the assignee, the reporter.
          this.people = users;
          wantPictures(this, [...notes.map((n) => n.userId), ticket.assigneeId, ticket.reporterId], cx, downloadAvatars, appHome());
        }
      } catch (e) {
        if (this.ref === ref) this.error = errText(e);
      }
      this.loading = false;
      // Another ticket was picked while this one loaded, or a response was posted: load again.
      if (this.ref !== ref || this.loadAgain) { this.loadAgain = false; this.load(cx); }
      cx.notify();
    });
  }

  /**
   * A ticket's response: { open (the form shows), posting, error, text (while another ticket
   * shows), changes: kind -> picked option, menu: the detail whose values are open }.
   */
  replyFor(key) {
    let r = this.replies.get(key);
    if (!r) { r = { open: false, posting: false, error: null, text: "", changes: {}, menu: null }; this.replies.set(key, r); }
    return r;
  }

  /** Puts a ticket's response away: posted or cancelled. */
  clearReply(key) {
    this.replies.delete(key);
    if (this.key === key) { this.reply = this.replyFor(key); this.response.set_value(""); }
  }

  /** Opens the response form under the notes, with the keyboard in it; again, folds it away (the text stays). */
  toggleResponse(cx) {
    if (this.reply.open && !this.reply.posting) { this.reply.open = false; this.reply.menu = null; cx.notify(); return; }
    this.reply.open = true;
    this.reply.error = null;
    if (this.ref) this.loadMeta(this.ref.project, cx);
    this.response.focus();
    cx.notify();
  }

  /** What a project's details can be set to (choices()), once. */
  loadMeta(project, cx) {
    const m = this.metas.get(project);
    if (m && (m.loading || m.statuses)) return;
    const entry = { loading: true, error: null };
    this.metas.set(project, entry);
    cx.spawn(async (cx) => {
      try { Object.assign(entry, await choices(this.creds, project)); }
      catch (e) { entry.error = errText(e); }
      entry.loading = false;
      wantPictures(this, (entry.users ?? []).map((u) => u.id), cx, downloadAvatars, appHome());
      cx.notify();
    });
  }

  /** A detail as the ticket has it now: { id, name, colour, icon }. */
  currentValue(kind) {
    const k = this.ticket, f = FIELDS[kind];
    if (kind === "assignee") return { id: k.assigneeId ?? null, name: k.assigneeId != null ? this.userName(k.assigneeId, k.assignee) : "Unassigned" };
    // A ticket may name its milestone without its id: found by name among the project's.
    if (kind === "milestone" && k.milestoneId == null && k.milestone) {
      const m = this.metas.get(this.ref?.project)?.milestones?.find((x) => x.name === k.milestone);
      return { id: m?.id ?? null, name: k.milestone };
    }
    return { id: k[f.id] ?? null, name: k[f.name] ?? (kind === "milestone" ? "None" : "—"),
      colour: f.colour ? k[f.colour] : null, icon: f.icon ? k[f.icon] : null };
  }

  /** The details picked that differ from the ticket's, as the API takes them: { status_id: 3, … }. */
  replyChanges() {
    const out = {};
    for (const [kind, o] of Object.entries(this.reply.changes)) {
      if ((o.id ?? null) !== this.currentValue(kind).id) out[FIELDS[kind].change] = o.id ?? "";
    }
    return out;
  }

  /** Posts the response (text and changed details) as a note; the ticket reloads, the list hears of it. */
  postResponse(cx) {
    const ref = this.ref, key = this.key, reply = this.reply;
    if (!ref || ref.view === "kanban" || !this.ticket || reply.posting) return;
    const content = this.response.value().trim(), changes = this.replyChanges();
    if (!content && !Object.keys(changes).length) { reply.error = "Write a response or change a detail first."; cx.notify(); return; }
    reply.posting = true;
    reply.error = null;
    reply.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await postNote(this.creds, ref.project, ref.id, content, changes);
        announceChange(setShared, this.me, ref.project, ref.id);
        this.clearReply(key);
        if (this.key === key) { if (this.loading) this.loadAgain = true; else this.load(cx); }
      } catch (e) {
        reply.posting = false;
        reply.error = errText(e);
      }
      cx.notify();
    });
  }

  /**
   * The response form at the bottom of a ticket (opened from the header): the text, then the details
   * to change with it (a changed one is outlined; picking the ticket's own value again undoes it).
   */
  responseView(t, avatar) {
    const r = this.reply;
    const person = (o, size) => avatar(o.name, size, o.id);
    const button = (id, label, onClick, strong) => div().id(id).flex_none().px(10).h(26).rounded(6).flex().items_center()
      .text_size(12).border(1).border_color(strong ? t.accent : t.border).bg(t.surface)
      .text_color(strong ? t.accent : t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(label);
    const bar = v_flex().flex_none().px(18).py(12).gap(8).border_t(1).border_color(t.border);

    const kinds = ["status", "priority", "type", "category", "assignee", "milestone"];
    const changed = (kind) => kind in r.changes && (r.changes[kind].id ?? null) !== this.currentValue(kind).id;
    const chip = (kind) => {
      const o = r.changes[kind] ?? this.currentValue(kind), open = r.menu === kind;
      return h_flex().id(`reply-${kind}`).flex_none().max_w(220).h(26).px(7).gap(6).rounded(6).items_center().text_size(12)
        .border(1).border_color(changed(kind) ? t.accent : open ? t.input : t.border).bg(open ? t.selected : t.surface)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`${TITLES[kind]}: ${o.name ?? "—"}`)
        .on_click((_e, cx) => { r.menu = open ? null : kind; this.loadMeta(this.ref.project, cx); cx.notify(); })
        .child(fieldMark(t, kind, o, 13, person))
        .child(div().flex_none().text_color(t.dim).child(TITLES[kind]))
        .child(div().min_w(0).truncate().text_color(changed(kind) ? t.foreground : t.muted).child(o.name ?? "—"));
    };
    const menu = (kind) => {
      const now = this.currentValue(kind).id;
      return this.optionsMenu(t, `reply-${kind}`, kind, (r.changes[kind] ?? this.currentValue(kind)).id ?? null, now, person, (o, cx) => {
        if ((o.id ?? null) === now) delete r.changes[kind]; else r.changes[kind] = o;
        r.menu = null;
        cx.notify();
      });
    };
    const changes = Object.keys(this.replyChanges()).length;

    return bar
      .child(Textarea.new(this.response).px(10).py(6).rounded(7).border(1).border_color(t.input)
        .bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(h_flex().flex_wrap().gap(6).children(kinds.map(chip)))
      .when(Boolean(r.menu), (el) => el.child(menu(r.menu)))
      .when(Boolean(r.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(r.error)))
      .child(h_flex().gap(8).items_center()
        .child(button("respond-post", r.posting ? "Posting…" : "Post", (cx) => this.postResponse(cx), true))
        .child(button("respond-cancel", "Cancel", (cx) => { this.clearReply(this.key); cx.notify(); }))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate()
          .child(changes ? `${changes} detail${changes > 1 ? "s" : ""} changed` : ""))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("⌘↩ posts")));
  }

  /**
   * The values a detail can be set to (the project's, from loadMeta), under the detail:
   * picked is highlighted, now (the ticket's value, if it isn't the picked one) says so,
   * statuses that close the ticket say so. pick(option, cx).
   */
  optionsMenu(t, id, kind, picked, now, person, pick) {
    const meta = this.metas.get(this.ref.project), f = FIELDS[kind];
    const box = v_flex().p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.raised)
      .child(div().px(6).pt(2).pb(2).text_size(11).text_color(t.dim).child(TITLES[kind]));
    if (!meta || meta.loading || meta.error) {
      return box.child(div().p(8).text_size(12).text_color(meta?.error ? t.ansi1 : t.dim).child(meta?.error ?? "Loading…"));
    }
    return box.child(v_flex().id(`${id}-options`).max_h(220).overflow_y_scrollbar().children((meta[f.list] ?? []).map((o) =>
      h_flex().id(`${id}-${o.id ?? "none"}`).h(26).px(6).gap(8).rounded(5).items_center().text_size(12).cursor_pointer()
        .when((o.id ?? null) === picked, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pick(o, cx))
        .child(h_flex().w(18).flex_none().justify_center().child(fieldMark(t, kind, o, 12, person)))
        .child(div().flex_1().min_w(0).truncate().text_color(o.id == null || o.closed ? t.muted : t.foreground).child(o.name))
        .when((o.id ?? null) === now && now !== picked, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("now")))
        .when(Boolean(o.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closes"))))));
  }

  /** Changes a detail of the shown ticket at once, then in Codebase (a note with the change); back if that fails. */
  changeDetail(kind, option, cx) {
    const k = this.ticket, ref = this.ref, key = this.key;
    this.detailMenu = null;
    if (!k || this.savingDetail || (option.id ?? null) === this.currentValue(kind).id) { cx.notify(); return; }
    const before = setField(k, kind, option);
    this.savingDetail = { key, kind };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await updateTicket(this.creds, ref.project, ref.id, { [FIELDS[kind].change]: option.id ?? "" });
        announceChange(setShared, this.me, ref.project, ref.id);
        // The change shows as a note too.
        if (this.key === key) { if (this.loading) this.loadAgain = true; else this.load(cx); }
      } catch (e) {
        Object.assign(k, before);
        notify({ title: `Could not change #${ref.id}`, body: errText(e), level: "error", timeout: 10000 });
      }
      this.savingDetail = null;
      cx.notify();
    });
  }

  /** The board's filter for a project: nothing picked unless chosen (filters.js). */
  boardFilter(project) {
    return { ...NO_FILTER, ...(this.boardFilters[project] ?? {}) };
  }

  setBoardFilter(project, f, cx) {
    this.boardFilters[project] = f;
    try { localStorage.setItem("boardFilters", JSON.stringify(this.boardFilters)); } catch {}
    // Reload now, or as soon as the load under way is done.
    if (this.loading) this.boardAgain = true; else this.load(cx);
    cx.notify();
  }

  loadBoard(ref, cx) {
    const filter = this.boardFilter(ref.project);
    cx.spawn(async (cx) => {
      try {
        const [board, users] = await Promise.all([
          fetchBoard(this.creds, ref.project, filter),
          this.users ?? accountUsers(this.creds).catch(NO_USERS),
        ]);
        this.users = users;
        this.people = users;
        if (this.ref === ref) {
          this.board = { project: ref.project, ...board, error: null };
          wantPictures(this, board.tickets.map((k) => k.assigneeId), cx, downloadAvatars, appHome());
        }
      } catch (e) {
        if (this.ref === ref) this.board = { project: ref.project, ...(this.board ?? {}), error: errText(e) };
      }
      this.loading = false;
      // The filter changed while this loaded, or another view was picked: load again.
      const again = this.boardAgain || searchOf(this.boardFilter(ref.project)) !== searchOf(filter);
      this.boardAgain = false;
      if (this.ref !== ref || again) this.load(cx);
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
          wantPictures(this, [...found.values()].map((c) => this.users?.idByName?.get((c.author ?? "").toLowerCase())), cx, downloadAvatars, appHome());
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
    const room = Math.max(120, (this.width || 480) - 36 - 26);
    const w = d?.width ? Math.min(d.width, room) : 0;
    const h = d?.width ? Math.round(w * d.height / d.width) : 0;
    return v_flex().gap(6).px(12).py(8).rounded(8).border(1).border_color(d?.open ? t.input : t.border).bg(t.raised)
      .child(h_flex().id(`img-${n.id}-${img.id}`).gap(6).items_center().text_size(12).cursor_pointer()
        .tooltip(d?.open ? "Hide the image" : "Show the image")
        .on_click((_e, cx) => this.toggleImage(img, cx))
        .child(svg(`mods/codebasehq/icons/chevron-${d?.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(svg("mods/codebasehq/icons/image.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(img.name))
        .when(Boolean(img.url), (el) => el.child(iconLink(t, `img-open-${n.id}-${img.id}`, "mods/codebasehq/external.svg",
          (cx) => openLink(cx, img.url, base), null, "Open the image in the browser"))))
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
        // The click comes after the loop is done (m is null by then): keep the link itself.
        const href = m[2] ?? m[3];
        if (m[1]) {
          const label = m[1].replace(/^!/, "");
          els.push(...word(label, (el) => el.text_color(t.accent)).map((el, j) => el.id(`${k}-${j}`).cursor_pointer().on_click((_e, cx) => openLink(cx, href, base))));
        } else if (m[3]) {
          els.push(div().id(k).mr(space).text_color(t.accent).cursor_pointer().on_click((_e, cx) => openLink(cx, href, base)).child(m[3]));
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
    return shared("codebasehq.base") ?? defaultBase(accountOf(this.creds));
  }

  userName(id, fallback) {
    return (id != null && this.users?.byId?.get(id)) || fallback || (id != null ? `User ${id}` : "Unknown");
  }

  render(t) {
    const root = v_flex().id("ticket-view").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } });
    const note = (text, color) => div().p(16).text_size(12.5).text_color(color ?? t.dim).child(text);
    // A person's badge: their picture when they have one (by id, or found by name for commit
    // authors), else initials.
    const avatar = (name, size, id) => {
      const uid = id ?? this.users?.idByName?.get((name ?? "").toLowerCase());
      return personBadge(t, name, size, uid != null ? this.pictures.get(uid) : null);
    };
    if (!this.ref) return root.child(note("Click a ticket's title in the Tickets panel to see it here."));
    if (this.ref.view === "kanban") return root.child(boardView(this, t, avatar));
    if (this.error && !this.ticket) return root.child(note(this.error, t.ansi1));
    if (!this.ticket) return root.child(note(`Loading #${this.ref.id}…`));

    const k = this.ticket, base = this.base(), url = ticketUrl(base, this.ref.project, k.id);
    const iconButton = (id, path, onClick, color, tip, active = false) =>
      div().id(id).flex_none().size(26).rounded(6).flex().items_center().justify_center()
        .when(active, (el) => el.bg(t.selected))
        .text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
        .tooltip(tip)
        .on_click((_e, cx) => onClick(cx)).child(svg(path).size(14));

    const field = (label, value) => h_flex().gap(8).min_h(22).items_center()
      .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5).children([].concat(value)));
    // A detail that can be changed: click it for its values, as on a card in the list.
    const person = (o, size) => avatar(o.name, size, o.id);
    const detail = (kind) => {
      const o = this.currentValue(kind), open = this.detailMenu === kind;
      const saving = this.savingDetail?.key === this.key && this.savingDetail?.kind === kind;
      return v_flex()
        .child(h_flex().id(`detail-${kind}`).ml(-6).px(6).gap(8).min_h(24).rounded(5).items_center().cursor_pointer()
          .when(open, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .tooltip(`Change ${TITLES[kind].toLowerCase()}`)
          .on_click((_e, cx) => { this.detailMenu = open ? null : kind; this.loadMeta(this.ref.project, cx); cx.notify(); })
          .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child(TITLES[kind]))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5)
            .child(fieldMark(t, kind, o, 13, person))
            .child(div().min_w(0).truncate().text_color(o.id == null ? t.dim : t.foreground).child(o.name ?? "—")))
          .when(saving, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Saving…"))))
        .when(open, (el) => el.child(div().pt(4).pb(6).child(
          this.optionsMenu(t, `detail-${kind}`, kind, o.id, o.id, person, (opt, cx) => this.changeDetail(kind, opt, cx)))));
    };

    // The project and the actions on one row, then the title: clicking it shows the details.
    const header = v_flex().flex_none().px(18).pt(6).pb(10).gap(2).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(2)
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate()
          .child(`${this.ref.projectName ?? this.ref.project}${this.loading ? " · updating…" : ""}`))
        .child(iconButton("view-latest", "mods/codebasehq/icons/arrow-down-to-line.svg", (cx) => {
          // The last child of the notes is an empty marker after the last note: revealing it shows the end.
          this.notesScroll.scroll_to_item((this.error ? 1 : 0) + Math.max(1, (this.notes ?? []).length));
          cx.notify();
        }, null, "Go to the latest note"))
        .child(iconButton("view-respond", "mods/codebasehq/icons/reply.svg", (cx) => this.toggleResponse(cx),
          this.reply.open ? t.accent : null, this.reply.open ? "Fold the response away (the text stays)" : "Post a response", this.reply.open))
        .child(iconButton("view-copy", this.copied ? "mods/codebasehq/check.svg" : "mods/codebasehq/copy.svg", (cx) => {
          cx.write_to_clipboard(`#${k.id} ${k.summary}`);
          this.copied = true;
          cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
          cx.notify();
        }, this.copied ? t.ansi2 : null, this.copied ? "Copied" : `Copy "#${k.id} ${k.summary}"`))
        .child(iconButton("view-open", "mods/codebasehq/external.svg", (cx) => openLink(cx, url), null, "Open in Codebase")))
      .child(h_flex().id("details-toggle").ml(-6).px(6).py(2).gap(6).rounded(5).items_start().cursor_pointer()
        .text_size(15).font_semibold().hover((s) => s.bg(t.hover))
        .tooltip(this.details ? "Hide the details" : "Show the details")
        .on_click((_e, cx) => { this.details = !this.details; cx.notify(); })
        .child(svg(`mods/codebasehq/icons/chevron-${this.details ? "down" : "right"}.svg`).size(13).flex_none().mt(4).text_color(t.dim))
        .child(div().flex_none().text_color(t.muted).child(`#${k.id}`))
        .child(div().flex_1().min_w(0).child(k.summary)))
      .when(this.details, (el) => el.child(v_flex().pt(6).gap(2)
        .children(["status", "priority", "type", "category", "assignee", "milestone"].map(detail))
        .child(field("Reported by", div().child(this.userName(k.reporterId, k.reporter))))
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
              .child(svg(`mods/codebasehq/icons/chevron-${diff?.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
              .child(svg("mods/codebasehq/icons/commit.svg").size(13).flex_none().text_color(t.muted))
              .child(div().flex_none().px(5).rounded(4).bg(t.surface).font_family(mono).text_size(11.5).text_color(t.accent).child(c.short))
              .child(svg("mods/codebasehq/icons/branch.svg").size(12).flex_none().text_color(t.dim))
              .child(div().flex_1().min_w(0).text_color(t.dim).truncate().child(c.branch))
              .child(iconLink(t, `commit-open-${n.id}`, "mods/codebasehq/external.svg",
                (cx) => openLink(cx, commitUrl(base, this.ref.project, c.repo, c.ref)), null, "Open the commit in Codebase")))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(title)))
          .when(Boolean(body), (el) => el.child(div().text_size(12).text_color(t.muted)
            .child(TextView.markdown(`commit-body-${n.id}`, markdown(body, base)).selectable(true)
              .on_link_click((link, cx) => openLink(cx, link, base)))))
          .when(Boolean(diff?.open), (el) => el.child(div().pt(4).border_t(1).border_color(t.border).child(this.diffView(t, c, diff, mono)))));
    };

    const noteView = (n, i) => {
      const commit = this.commits.get(n.id);
      if (commit) return commitView(n, commit, i);
      const who = this.userName(n.userId);
      const changes = Object.entries(n.updates ?? {}).filter(([, v]) => Array.isArray(v));
      const content = blocks(n.content, base).filter((b) => b.image || b.lines || b.markdown.trim());
      // Images in the text show where they are; attached images the text doesn't show go below,
      // other attachments as files.
      const images = imagesBelow(n);
      const named = new Map(n.attachments.map((a) => [a.id, a.name]));
      const attachments = n.attachments.filter((a) => !/^image\//.test(a.type) && !content.some((b) => b.image?.id === a.id));
      return v_flex().id(`note-${n.id}`).flex_none().px(18).py(12).gap(8)
        .when(i > 0, (el) => el.border_t(1).border_color(t.border))
        .child(h_flex().gap(8).items_center()
          .child(avatar(who, 22, n.userId))
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
              .on_link_click((link, cx) => openLink(cx, link, base))))))
        .when(images.length > 0, (el) => el.child(v_flex().gap(6).children(images.map((img) => this.imageView(t, n, img, base)))))
        .when(attachments.length > 0, (el) => el.child(v_flex().gap(2).children(attachments.map((a, j) =>
          div().id(`att-${n.id}-${j}`).text_size(12).text_color(t.accent).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => openLink(cx, a.url, base))
            .child(`📎 ${a.name}`)))));
    };

    const notes = this.notes ?? [];
    return root
      .child(header)
      .child(v_flex().id("ticket-notes").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.notesScroll)
        .when(Boolean(this.error), (el) => el.child(note(this.error, t.ansi1)))
        .when(notes.length === 0, (el) => el.child(note("No notes.")))
        .children(notes.map(noteView))
        .child(div().flex_none().h(16)))
      .when(this.reply.open, (el) => el.child(this.responseView(t, avatar)));
  }
}
