// Codebase HQ tickets: every open ticket in the project of the focused terminal.
//   The project comes from the repo's git remote (git@codebasehq.com:<account>/<project>/<repo>.git);
//   "Project" picks another one for this repo (or All projects), remembered per repo. Outside a
//   Codebase repo the default is All projects: every active project is asked, the answers merged.
//   Click a ticket's title to see the whole ticket and its notes in a pane beside (viewer.js);
//   click it again to close that pane.
//   Click a ticket's status, priority, type, category or assignee to pick another value (saved as a Codebase note with changes).
//   The copy icon copies "#<id> <summary>"; the arrow icon opens the ticket in the browser.
// The API username and key live in the macOS keychain (service "herdr-codebasehq"), set up
// from the panel (the gear in the header). The web address for links (default
// https://<account>.codebasehq.com, or your own domain) is kept in this mod's localStorage.
// Neither is ever written to the mod's folder.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, focused, spaces, panes, theme, checking, props, notify, run, shared, setShared, appHome } from "herdr";
import {
  loadCredentials, saveCredentials, forgetCredentials, accountOf,
  ticketPage, projects, repoOf, ticketUrl, ticketsUrl, ago, ApiError, defaultBase, normalizeBase, choices, updateTicket,
  accountUsers, downloadAvatars,
} from "./codebase.js";
import { TITLES, typeIcon, initials, colourOf, personColour, personBadge, wantPictures } from "./ui.js";
import { Viewer } from "./viewer.js";

const WATCH = 1500;       // how often to look at which folder is focused (no exec unless it changed)
const REFRESH = 120000;   // tickets
const STALE = 60000;      // switching back to a project reloads it if older than this
const BATCH = 3;          // pages (20 tickets each) loaded at a time; "Load more" gets the next ones
const ALL = "*";          // the "project" that means every active project
const PARALLEL = 8;       // requests at a time when asking every project
const REFRESH_ALL = 600000; // all projects means one request per project: refresh by itself less often

const errText = (e) => String(e?.message ?? e);

/** A ticket with its project; ticket numbers are only unique within a project, so uid is both. */
const tag = (k, project, projectName) => ({ ...k, project, projectName: projectName ?? project, uid: `${project}-${k.id}` });

// The list's filter, per project. Values are what Codebase's search takes: names, and usernames
// (or "me") for the assignee. resolution: "open" | "closed" | "all".
const DEFAULT_FILTER = { assignee: ["me"], status: [], priority: [], category: [], type: [], resolution: "open" };
const FILTER_KINDS = ["assignee", "status", "priority", "category", "type"];

const quote = (v) => (/[\s,:"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

/** { assignee: ["me"], resolution: "open" } -> 'assignee:me resolution:open' */
function searchOf(f) {
  const parts = FILTER_KINDS.filter((k) => f[k]?.length).map((k) => `${k}:${f[k].map(quote).join(",")}`);
  if (f.resolution !== "all") parts.push(`resolution:${f.resolution}`);
  return parts.join(" ");
}

// The fields a card shows and lets you change: where the choices are, what the API calls
// the change, and the ticket's own keys for the id, the name and a colour.
const FIELDS = {
  status:   { list: "statuses",   change: "status_id",   id: "statusId",   name: "status",   colour: "statusColour" },
  priority: { list: "priorities", change: "priority_id", id: "priorityId", name: "priority", colour: "priorityColour" },
  type:     { list: "types",      change: "type_id",     id: "typeId",     name: "type",     icon: "typeIcon" },
  category: { list: "categories", change: "category_id", id: "categoryId", name: "category" },
  assignee: { list: "users",      change: "assignee_id", id: "assigneeId", name: "assignee" },
};

export default class Tickets extends View {
  init(_props, cx) {
    // A copy opened as a pane to show one ticket (see viewer.js).
    if (props()?.view === "ticket") {
      this.viewer = new Viewer();
      this.viewer.init(cx);
      return;
    }
    this.creds = undefined;     // undefined: not read yet; null: none saved
    this.view = "list";         // "list" | "picker" | "setup"
    this.cwd = undefined;
    this.repo = null;           // { root, remote: {account, project} | null }
    this.cache = new Map();     // project -> { tickets, error, at, loading }
    this.projectList = null;    // [{ name, permalink }] for the picker
    this.projectError = null;
    this.copied = null;
    this.meta = new Map();      // project -> { statuses, priorities, error, loading }
    this.menu = null;           // { id, kind: "status" | "priority" } while a picker is open on a card
    this.updating = new Set();  // ticket ids being saved
    try { this.chosen = JSON.parse(localStorage.getItem("projects") ?? "{}") ?? {}; } catch { this.chosen = {}; }
    try { this.filters = JSON.parse(localStorage.getItem("filters") ?? "{}") ?? {}; } catch { this.filters = {}; }
    this.filterMenu = null;     // the filter whose values are open under the bar
    this.people = null;         // everyone on the account (accountUsers): names and pictures
    this.pictures = new Map();  // user id -> picture path (or null: initials)

    this.user = InputState.new({ placeholder: "account/username" });
    this.key = InputState.new({ placeholder: "API key" });
    this.key.set_masked(true);
    try { this.baseUrl = localStorage.getItem("baseUrl") || null; } catch { this.baseUrl = null; }
    this.base = InputState.new({ placeholder: "https://example.codebasehq.com" });
    this.base.on("submit", (_e, cx) => this.save(cx));
    this.filter = InputState.new({ placeholder: "Filter projects" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.key.on("submit", (_e, cx) => this.save(cx));
    this.saving = false;
    this.setupError = null;

    if (checking()) return;
    // The ticket view (another copy) makes its links with the same address.
    if (this.baseUrl) setShared("tickets.base", this.baseUrl);
    cx.spawn(async (cx) => {
      try { this.creds = await loadCredentials(); } catch { this.creds = null; }
      if (!this.creds) this.view = "setup";
      else this.loadPeople(cx);
      this.watch(cx);
      cx.notify();
    });
    cx.timer.every(WATCH, (cx) => this.watch(cx));
    cx.timer.every(REFRESH, (cx) => this.load(cx, "timer"));
  }

  // --- where we are ------------------------------------------------------------

  watch(cx) {
    if (this.creds === undefined) return;
    const f = focused();
    const cwd = f?.cwd ?? null;
    if (cwd === this.cwd) return;
    // A pane with no folder (the ticket view, another mod) isn't somewhere else: keep showing
    // what was shown. Only the very first look settles for "outside a repo".
    const pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    if (this.cwd !== undefined && (!cwd || pane?.mod)) return;
    this.cwd = cwd;
    const machine = spaces().find((s) => s.id === f?.space)?.machine ?? undefined;
    cx.spawn(async (cx) => {
      let repo = null;
      try { repo = await repoOf(cwd, machine); } catch { repo = null; }
      if (this.cwd !== cwd) return;
      this.repo = repo;
      this.load(cx, false);
      cx.notify();
    });
  }

  /** Where a choice is remembered: the repo, or "" for anywhere outside one. */
  choiceKey() {
    return this.repo?.root ?? "";
  }

  /** What this place shows when nothing was chosen: the remote's project, else all projects. */
  defaultProject() {
    return this.repo?.remote?.project ?? ALL;
  }

  project() {
    const chosen = this.chosen[this.choiceKey()];
    const permalink = chosen ?? this.defaultProject();
    const source = chosen ? (this.repo?.root ? "chosen for this repo" : "chosen outside a repo")
      : this.repo?.remote ? "from git remote"
      : this.repo?.root ? "default: this repo has no Codebase remote"
      : "default outside a repo";
    return { permalink, all: permalink === ALL, name: permalink === ALL ? "All projects" : permalink, source };
  }

  account() {
    return this.repo?.remote?.account ?? accountOf(this.creds);
  }

  /** Where ticket links go: the saved address, else https://<account>.codebasehq.com. */
  webBase() {
    return this.baseUrl ?? defaultBase(this.account());
  }

  // --- data --------------------------------------------------------------------

  filterFor(project) {
    return { ...DEFAULT_FILTER, ...(this.filters[project] ?? {}) };
  }

  setFilter(project, f, cx) {
    this.filters[project] = f;
    try { localStorage.setItem("filters", JSON.stringify(this.filters)); } catch {}
    this.load(cx, false);
    cx.notify();
  }

  /** Tickets are cached per project and search. */
  entryFor(project) {
    const key = `${project}\n${searchOf(this.filterFor(project))}`;
    let entry = this.cache.get(key);
    if (!entry) { entry = { tickets: null, error: null, at: 0, loading: false, pages: 0, more: false }; this.cache.set(key, entry); }
    return entry;
  }

  /**
   * Loads the list BATCH pages at a time: a refresh reloads as many pages as are shown,
   * `more` adds the next batch. A first load shows each page as it comes.
   */
  load(cx, force, more = false) {
    const p = this.project();
    if (!p || !this.creds) return;
    if (p.all) return this.loadAll(cx, force, more);
    const search = searchOf(this.filterFor(p.permalink));
    const entry = this.entryFor(p.permalink);
    if (entry.loading) return;
    if (!more && !force && Date.now() - entry.at < STALE) return;
    if (more && !entry.more) return;
    const first = more ? entry.pages + 1 : 1;
    const last = more ? entry.pages + BATCH : Math.max(entry.pages, BATCH);
    entry.loading = true;
    this.loadChoices(p.permalink, cx);
    cx.notify();
    cx.spawn(async (cx) => {
      let list = more ? [...(entry.tickets ?? [])] : [];
      const fresh = !entry.tickets;
      let page = first, hasMore = true;
      try {
        for (; page <= last && hasMore; page++) {
          const r = await ticketPage(this.creds, p.permalink, search, page);
          const seen = new Set(list.map((k) => k.uid));
          list = list.concat(r.tickets.map((k) => tag(k, p.permalink)).filter((k) => !seen.has(k.uid)));
          hasMore = r.more;
          if (fresh || more) { entry.tickets = list; cx.notify(); }
        }
        entry.tickets = list;
        entry.pages = page - 1;
        entry.more = hasMore;
        entry.error = null;
      } catch (e) {
        entry.error = errText(e);
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { this.setupError = entry.error; this.view = "setup"; }
      }
      entry.at = Date.now();
      entry.loading = false;
      this.wantShownPictures(cx);
      cx.notify();
    });
  }

  /**
   * All projects: one page from every active project (PARALLEL at a time), merged and sorted
   * by last update; "Load more" asks the projects that had more for their next page.
   */
  loadAll(cx, force, more) {
    const entry = this.entryFor(ALL);
    if (entry.loading) return;
    if (!more && !force && Date.now() - entry.at < STALE) return;
    if (force === "timer" && Date.now() - entry.at < REFRESH_ALL) return;
    if (more && !entry.more) return;
    const search = searchOf(this.filterFor(ALL));
    entry.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!this.projectList) this.projectList = await projects(this.creds);
        // project -> next page to ask for (only those that may have more)
        const next = more ? new Map(entry.next) : new Map(this.projectList.map((x) => [x.permalink, 1]));
        const names = new Map(this.projectList.map((x) => [x.permalink, x.name]));
        let list = more ? [...(entry.tickets ?? [])] : [];
        const fresh = !entry.tickets;
        const failed = [];
        const queue = [...next.keys()];
        const sort = () => list.sort((a, b) => b.updated - a.updated);
        const worker = async () => {
          for (let project = queue.shift(); project; project = queue.shift()) {
            try {
              const r = await ticketPage(this.creds, project, search, next.get(project));
              list = list.concat(r.tickets.map((k) => tag(k, project, names.get(project))));
              if (r.more) next.set(project, next.get(project) + 1); else next.delete(project);
            } catch (e) {
              if (e instanceof ApiError && e.status === 401) throw e;
              failed.push(project);
              next.delete(project);
            }
            if (fresh || more) { entry.tickets = sort(); cx.notify(); }
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
        entry.tickets = sort();
        entry.next = next;
        entry.more = next.size > 0;
        entry.error = failed.length ? `${failed.length} project${failed.length > 1 ? "s" : ""} could not be read: ${failed.join(", ")}` : null;
        // Names for people and the filters' values come from each project's settings.
        for (const project of new Set(list.slice(0, 200).map((k) => k.project))) this.loadChoices(project, cx);
      } catch (e) {
        entry.error = errText(e);
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { this.setupError = entry.error; this.view = "setup"; }
      }
      entry.at = Date.now();
      entry.loading = false;
      this.wantShownPictures(cx);
      cx.notify();
    });
  }

  /** Everyone on the account once, for their pictures. */
  loadPeople(cx) {
    if (this.people || this.peopleLoading || !this.creds) return;
    this.peopleLoading = true;
    cx.spawn(async (cx) => {
      try { this.people = await accountUsers(this.creds); } catch { /* initials, then */ }
      this.peopleLoading = false;
      this.wantShownPictures(cx);
      cx.notify();
    });
  }

  /** Pictures for the people the list shows (assignees) and its menus offer. */
  wantShownPictures(cx) {
    const p = this.project();
    const ids = (this.entryFor(p.permalink).tickets ?? []).map((k) => k.assigneeId);
    for (const m of this.meta.values()) for (const u of m.users ?? []) ids.push(u.id);
    wantPictures(this, ids, cx, downloadAvatars, appHome());
  }

  loadChoices(project, cx) {
    const m = this.meta.get(project);
    if (m && (m.loading || m.statuses)) return;
    const entry = { statuses: null, error: null, loading: true };
    this.meta.set(project, entry);
    cx.spawn(async (cx) => {
      try { Object.assign(entry, await choices(this.creds, project)); }
      catch (e) { entry.error = errText(e); }
      entry.loading = false;
      this.wantShownPictures(cx);
      cx.notify();
    });
  }

  toggleMenu(project, k, kind, cx) {
    const open = this.menu?.id === k.uid && this.menu.kind === kind;
    this.menu = open ? null : { id: k.uid, kind };
    if (!open) this.loadChoices(project, cx);
    cx.notify();
  }

  change(project, k, kind, option, cx) {
    this.menu = null;
    const f = FIELDS[kind];
    if ((k[f.id] ?? null) === option.id || this.updating.has(k.uid)) { cx.notify(); return; }
    const before = { ...k };
    // Show it at once; put it back if Codebase says no.
    k[f.id] = option.id;
    k[f.name] = option.id === null ? null : kind === "assignee" ? option.username : option.name;
    if (f.colour) k[f.colour] = option.colour;
    this.updating.add(k.uid);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await updateTicket(this.creds, project, k.id, { [f.change]: option.id ?? "" });
        k.updated = Date.now();
        if (kind === "status") k.closed = Boolean(option.closed);
        const shown = this.project().permalink;
        if (kind === "status" && option.closed && this.filterFor(shown).resolution === "open") {
          const entry = this.entryFor(shown);
          if (entry?.tickets) entry.tickets = entry.tickets.filter((x) => x !== k);
          notify({ title: `#${k.id} ${option.name}`, body: k.summary, level: "success", timeout: 4000 });
        }
      } catch (e) {
        Object.assign(k, before);
        notify({ title: `Could not change #${k.id}`, body: errText(e), level: "error", timeout: 10000 });
      }
      this.updating.delete(k.uid);
      cx.notify();
    });
  }

  openPicker(cx) {
    this.view = "picker";
    this.filter.set_value("");
    this.filter.focus();
    if (!this.projectList) {
      cx.spawn(async (cx) => {
        try { this.projectList = await projects(this.creds); this.projectError = null; }
        catch (e) { this.projectError = errText(e); }
        cx.notify();
      });
    }
    cx.notify();
  }

  choose(permalink, cx) {
    const key = this.choiceKey();
    if (permalink && permalink !== this.defaultProject()) this.chosen[key] = permalink;
    else delete this.chosen[key];
    try { localStorage.setItem("projects", JSON.stringify(this.chosen)); } catch {}
    this.view = "list";
    this.load(cx, false);
    cx.notify();
  }

  openSetup(cx) {
    this.view = "setup";
    this.user.set_value(this.creds?.user ?? "");
    this.key.set_value("");
    this.base.set_value(this.baseUrl ?? "");
    this.setupError = null;
    cx.notify();
  }

  save(cx) {
    const user = this.user.value().trim(), typed = this.key.value().trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(user)) { this.setupError = "The API username looks like account/username."; cx.notify(); return; }
    // An empty key field keeps the saved key.
    const key = typed || this.creds?.key || "";
    if (!key) { this.setupError = "Paste the API key."; cx.notify(); return; }
    let base;
    try { base = normalizeBase(this.base.value()); } catch (e) { this.setupError = errText(e); cx.notify(); return; }
    if (this.saving) return;
    this.saving = true;
    this.setupError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.baseUrl = base;
        try { if (base) localStorage.setItem("baseUrl", base); else localStorage.removeItem("baseUrl"); } catch {}
        setShared("tickets.base", base);
        const changed = !this.creds || this.creds.user !== user || this.creds.key !== key;
        if (changed) {
          await saveCredentials(user, key);
          this.creds = await loadCredentials();
          if (!this.creds) throw new Error("Saved, but could not read it back from the keychain.");
          this.cache.clear();
          this.projectList = null;
        }
        this.key.set_value("");
        this.view = "list";
        this.cwd = undefined;
        this.watch(cx);
      } catch (e) {
        this.setupError = errText(e);
      }
      this.saving = false;
      cx.notify();
    });
  }

  forget(cx) {
    cx.spawn(async (cx) => {
      await forgetCredentials().catch(() => {});
      this.creds = null;
      this.cache.clear();
      this.projectList = null;
      this.openSetup(cx);
    });
  }

  /** The ticket view pane in the shown tab, if there is one. */
  viewerPane() {
    const tab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
    return panes().find((x) => x.mod === "tickets" && x.tab === tab) ?? null;
  }

  /** Shows a ticket in the view pane (opening it beside), or closes the pane if it shows this one. */
  toggleTicket(k) {
    const pane = this.viewerPane();
    const open = shared("tickets.open");
    if (pane && open?.uid === k.uid) {
      setShared("tickets.open", null);
      run("pane.close", { pane: pane.pane });
      return;
    }
    const ref = { project: k.project, id: k.id, uid: k.uid, projectName: k.projectName };
    setShared("tickets.open", ref);
    if (!pane) run("pane.split", { direction: "right", mod: "tickets", props: { view: "ticket", ...ref } });
  }

  openUrl(url) {
    exec("open", [url]).catch(() => {});
  }

  // --- drawing -----------------------------------------------------------------

  render() {
    const t = theme();
    if (this.viewer) return this.viewer.render(t);
    const root = props()?.overlay ? v_flex().w_full().h(600) : v_flex().size_full();
    const body =
      this.creds === undefined ? this.note(t, "Loading…")
      : this.view === "setup" ? this.renderSetup(t)
      : this.view === "picker" ? this.renderPicker(t)
      : this.renderList(t);
    return root.bg(t.surface).text_color(t.foreground).child(body);
  }

  note(t, text, color) {
    return div().p(14).text_size(12).text_color(color ?? t.dim).child(text);
  }

  button(t, id, label, onClick, strong) {
    return div().id(id).flex_none().px(10).h(24).rounded(6).flex().items_center().text_size(12)
      .border(1).border_color(strong ? t.accent : t.border).bg(t.surface)
      .text_color(strong ? t.accent : t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  link(t, id, label, onClick) {
    return div().id(id).flex_none().px(6).h(22).rounded(5).flex().items_center().text_size(12).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  icon(t, id, path, onClick) {
    return div().id(id).flex_none().size(24).rounded(6).flex().items_center().justify_center()
      .border(1).border_color(t.border).bg(t.surface).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(svg(path).size(13));
  }

  /** A bare icon button (Copy ref, Open on a card). */
  iconLink(t, id, path, onClick, color) {
    return div().id(id).flex_none().size(22).rounded(5).flex().items_center().justify_center()
      .text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(svg(path).size(13));
  }

  header(t, title, subtitle, buttons) {
    return h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(14).font_semibold().child(title))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).truncate().child(subtitle ?? ""))
      .children(buttons);
  }

  renderList(t) {
    const p = this.project();
    const entry = p ? this.entryFor(p.permalink) : null;
    const tickets = entry?.tickets;
    const resolution = p ? this.filterFor(p.permalink).resolution : "open";
    const count = tickets ? ` · ${tickets.length}${entry.more ? "+" : ""}${resolution === "all" ? "" : ` ${resolution}`}` : "";
    const subtitle = p ? `${p.name}${count}` : "";
    const header = this.header(t, "Tickets", subtitle, [
      this.button(t, "project", "Project", (cx) => this.openPicker(cx)),
      this.button(t, "refresh", entry?.loading ? "…" : "↻", (cx) => this.load(cx, true)),
      this.icon(t, "settings", "mods/tickets/settings.svg", (cx) => this.openSetup(cx)),
    ]);

    let content;
    if (entry?.error && !tickets) {
      content = this.note(t, entry.error, t.ansi1);
    } else if (!tickets) {
      content = this.note(t, "Loading tickets…");
    } else {
      const base = this.webBase();
      const now = Date.now();
      const colour = (c) => this.colour(t, c);
      const label = (k, kind) => {
        if (kind === "assignee") {
          if (k.assigneeId == null && !k.assignee) return "Unassigned";
          return this.meta.get(k.project)?.users?.find((u) => u.id === k.assigneeId)?.name ?? k.assignee;
        }
        return k[FIELDS[kind].name] ?? "—";
      };
      const avatar = (name, size) => name == null
        ? svg("mods/tickets/user.svg").size(size - 4).flex_none().text_color(t.dim)
        : div().size(size).flex_none().rounded(size / 2).bg(personColour(t, name).bg).flex().items_center().justify_center()
          .text_size(size * 0.5).font_semibold().text_color(personColour(t, name).fg).child(initials(name));
      // What shows for a field, on the card and in its menu: status keeps its name; the rest are icons.
      const mark = (kind, o, size) => {
        if (kind === "status") return div().size(size * 0.45).rounded(size).flex_none().bg(colour(o.colour));
        if (kind === "priority") return svg("mods/tickets/icons/flag.svg").size(size).flex_none().text_color(colour(o.colour));
        if (kind === "type") return svg(typeIcon(o.icon)).size(size).flex_none().text_color(t.muted);
        if (kind === "category") return svg("mods/tickets/icons/tag.svg").size(size - 1).flex_none().text_color(t.dim);
        return o.id == null ? avatar(null, size + 4) : personBadge(t, o.name, size + 4, this.pictures.get(o.id));
      };
      const chip = (k, kind) => {
        const f = FIELDS[kind];
        const open = this.menu?.id === k.uid && this.menu.kind === kind;
        const value = { id: k[f.id] ?? null, name: label(k, kind), colour: f.colour ? k[f.colour] : null, icon: f.icon ? k[f.icon] : null };
        if (kind === "assignee" && value.id == null && !k.assignee) value.name = null;
        // Priority and type are icons only (hover for the value); the others show their name too.
        const text = kind === "status" || kind === "category" || kind === "assignee";
        return h_flex().id(`${kind}-${k.uid}`).flex_none().gap(5).h(22).rounded(5).items_center().justify_center()
          .when(text, (el) => el.px(5).min_w(0).flex_shrink_1()).when(!text, (el) => el.w(24))
          .text_size(11.5).text_color(open ? t.foreground : t.muted).when(open, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`${TITLES[kind]}: ${value.name ?? "Unassigned"}`)
          .on_click((_e, cx) => this.toggleMenu(k.project, k, kind, cx))
          .child(mark(kind, value, 13))
          .when(text, (el) => el.child(div().min_w(0).truncate().child(value.name ?? "Unassigned")));
      };
      const menu = (k) => {
        const kind = this.menu.kind, f = FIELDS[kind];
        const meta = this.meta.get(k.project);
        const head = div().px(6).pt(6).pb(2).text_size(11).text_color(t.dim).child(TITLES[kind]);
        if (!meta || meta.loading) return v_flex().border_t(1).border_color(t.border).child(head).child(this.note(t, "Loading…"));
        if (meta.error) return this.note(t, meta.error, t.ansi1);
        const options = meta[f.list] ?? [];
        const current = k[f.id] ?? null;
        return v_flex().gap(1).border_t(1).border_color(t.border).child(head).children(options.map((o) =>
          h_flex().id(`opt-${k.uid}-${o.id ?? "none"}`).h(26).px(6).gap(8).rounded(5).items_center().text_size(12)
            .when(o.id === current, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.change(k.project, k, kind, o, cx))
            .child(h_flex().w(16).flex_none().justify_center().child(mark(kind, o, 12)))
            .child(div().flex_1().min_w(0).truncate().text_color(o.closed || o.id === null ? t.muted : t.foreground).child(o.name))
            .when(Boolean(o.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closes")))));
      };
      const viewing = this.viewerPane() ? shared("tickets.open")?.uid : null;
      const card = (k, _i, _all, shown = viewing === k.uid) =>
        v_flex().id(`ticket-${k.uid}`).flex_none().mx(10).mb(8).px(12).pt(10).pb(8).gap(6)
          .rounded(8).border(1).border_color(shown ? t.accent : this.menu?.id === k.uid ? t.input : t.border).bg(t.raised)
          .hover((s) => s.border_color(t.input))
          .when(p.all, (el) => el.child(div().mb(-3).text_size(11).text_color(t.dim).truncate().child(k.projectName ?? k.project)))
          .child(h_flex().gap(8).items_start()
            .child(div().flex_none().text_size(13).font_semibold().text_color(t.muted).child(`#${k.id}`))
            .child(div().id(`title-${k.uid}`).flex_1().min_w(0).text_size(13).rounded(4)
              .text_color(shown ? t.accent : t.foreground).hover((s) => s.text_color(t.accent))
              .tooltip(shown ? "Close the ticket view" : "Show the whole ticket")
              .on_click((_e, cx) => { this.toggleTicket(k); cx.notify(); })
              .child(k.summary))
            .child(h_flex().flex_none().gap(2).mt(-2).mr(-6)
              .child(this.iconLink(t, `copy-${k.uid}`, this.copied === k.uid ? "mods/tickets/check.svg" : "mods/tickets/copy.svg", (cx) => {
                cx.write_to_clipboard(`#${k.id} ${k.summary}`);
                this.copied = k.uid;
                cx.timer.after(1500, (cx) => { if (this.copied === k.uid) { this.copied = null; cx.notify(); } });
                cx.notify();
              }, this.copied === k.uid ? t.ansi2 : null))
              .child(this.iconLink(t, `open-${k.uid}`, "mods/tickets/external.svg", () => this.openUrl(ticketUrl(base, k.project, k.id))))))
          .child(h_flex().gap(1).items_center().ml(-5)
            .child(chip(k, "status"))
            .child(chip(k, "priority"))
            .child(chip(k, "type"))
            .child(chip(k, "category"))
            .child(chip(k, "assignee"))
            .child(div().flex_1().min_w(8))
            .child(div().flex_none().text_size(11.5).text_color(t.dim)
              .child(this.updating.has(k.uid) ? "Saving…" : ago(k.updated, now))))
          .when(this.menu?.id === k.uid, (el) => el.child(menu(k)));
      content = v_flex()
        .when(Boolean(entry.error), (el) => el.child(this.note(t, entry.error, t.ansi1)))
        .when(tickets.length === 0, (el) => el.child(this.note(t, "No tickets match the filter.")))
        .children(tickets.map(card))
        .when(entry.more || (entry.loading && tickets.length > 0), (el) => el.child(h_flex().px(10).pb(12).justify_center()
          .child(entry.loading
            ? div().text_size(12).text_color(t.dim).child("Loading…")
            : this.button(t, "load-more", "Load more", (cx) => this.load(cx, false, true)))));
    }

    return v_flex().size_full().min_h(0)
      .child(header)
      .child(v_flex().id("tickets-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().px(14).pt(10).pb(8).gap(6).items_center()
          .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate().child(`${p.name} · ${p.source}`))
          .when(!p.all, (el) => el.child(this.link(t, "open-all", "All in Codebase", () => this.openUrl(ticketsUrl(this.webBase(), p.permalink))))))
        .child(this.renderFilters(t, p.permalink))
        .child(content));
  }

  /**
   * For All projects: the filter values of the projects in the list, together (by name;
   * people by username).
   */
  mergedChoices() {
    const projects = new Set((this.entryFor(ALL).tickets ?? []).map((k) => k.project));
    const metas = [...projects].map((x) => this.meta.get(x)).filter(Boolean);
    if (metas.some((m) => m.loading) && !metas.some((m) => m.statuses)) return { loading: true };
    const merged = { loading: false };
    for (const [list, key] of [["statuses", "name"], ["priorities", "name"], ["types", "name"], ["categories", "name"], ["users", "username"]]) {
      const seen = new Map();
      for (const m of metas) for (const o of m[list] ?? []) if (o[key] && !seen.has(o[key])) seen.set(o[key], o);
      merged[list] = [...seen.values()];
      if (list === "categories" || list === "users") merged[list].sort((a, b) => a.name.localeCompare(b.name, "sv"));
    }
    return merged;
  }

  colour(t, c) {
    return colourOf(t, c);
  }


  /** The filter bar: one button per field, its values (several can be picked) open below it. */
  renderFilters(t, project) {
    const f = this.filterFor(project);
    const meta = project === ALL ? this.mergedChoices() : this.meta.get(project);
    const me = this.creds?.user?.split("/")[1];
    const userName = (u) => u === "me" ? "Me" : meta?.users?.find((x) => x.username === u)?.name ?? u;
    const summary = (kind) => {
      if (kind === "resolution") return { open: "Open", closed: "Closed", all: "Open and closed" }[f.resolution];
      const v = f[kind];
      if (!v.length) return null;
      const first = kind === "assignee" ? userName(v[0]) : v[0];
      return v.length > 1 ? `${first} +${v.length - 1}` : first;
    };
    const kinds = ["resolution", ...FILTER_KINDS];
    const button = (kind) => {
      const value = summary(kind), open = this.filterMenu === kind;
      const active = kind === "resolution" ? f.resolution !== "all" : Boolean(value);
      return h_flex().id(`filter-${kind}`).flex_none().h(22).px(7).gap(4).rounded(11).items_center().text_size(11.5)
        .border(1).border_color(active ? t.input : t.border).bg(open ? t.selected : active ? t.raised : t.surface)
        .text_color(active ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filterMenu = open ? null : kind; if (project !== ALL) this.loadChoices(project, cx); cx.notify(); })
        .child(kind === "resolution" ? value : value ? `${TITLES[kind].replace("Assigned to", "Assignee")}: ${value}` : TITLES[kind].replace("Assigned to", "Assignee"));
    };
    const isDefault = JSON.stringify(f) === JSON.stringify(DEFAULT_FILTER);

    let menu = null;
    const kind = this.filterMenu;
    if (kind) {
      let options;
      if (kind === "resolution") {
        options = [["open", "Open"], ["closed", "Closed"], ["all", "Open and closed"]].map(([value, name]) => ({ value, name, on: f.resolution === value }));
      } else if (!meta || meta.loading) {
        options = null;
      } else {
        const list = kind === "assignee"
          ? [{ value: "me", name: "Me" }, ...(meta.users ?? []).filter((u) => u.username && u.username !== me).map((u) => ({ value: u.username, name: u.name }))]
          : (meta[FIELDS[kind].list] ?? []).map((o) => ({ value: o.name, name: o.name, colour: o.colour, closed: o.closed }));
        options = list.map((o) => ({ ...o, on: f[kind].includes(o.value) }));
      }
      const pick = (o, cx) => {
        if (kind === "resolution") { this.filterMenu = null; this.setFilter(project, { ...f, resolution: o.value }, cx); return; }
        const values = o.on ? f[kind].filter((v) => v !== o.value) : [...f[kind], o.value];
        this.setFilter(project, { ...f, [kind]: values }, cx);
      };
      menu = v_flex().mx(10).mb(8).p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.raised)
        .child(h_flex().px(6).pt(2).pb(2).items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child(kind === "resolution" ? "Resolution" : TITLES[kind]))
          .when(kind !== "resolution" && f[kind]?.length > 0, (el) => el.child(this.link(t, "filter-clear", "Any", (cx) => this.setFilter(project, { ...f, [kind]: [] }, cx))))
          .child(this.link(t, "filter-done", "Done", (cx) => { this.filterMenu = null; cx.notify(); })))
        .when(!options, (el) => el.child(this.note(t, meta?.error ?? "Loading…", meta?.error ? t.ansi1 : null)))
        .when(Boolean(options), (el) => el.child(v_flex().id("filter-options").max_h(260).overflow_y_scrollbar().children(options.map((o) =>
          h_flex().id(`fopt-${kind}-${o.value}`).h(26).px(6).gap(8).rounded(5).items_center().text_size(12)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(o, cx))
            .child(div().size(14).flex_none().rounded(kind === "resolution" ? 7 : 3).border(1)
              .border_color(o.on ? t.accent : t.input).bg(o.on ? t.accent : t.background)
              .flex().items_center().justify_center()
              .when(o.on, (el) => el.child(svg("mods/tickets/check.svg").size(10).text_color(t.accent_foreground))))
            .when(Boolean(o.colour), (el) => el.child(div().size(7).rounded(4).flex_none().bg(this.colour(t, o.colour))))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(o.name))
            .when(Boolean(o.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closed")))))));
    }

    return v_flex()
      .child(h_flex().flex_wrap().px(10).pb(8).gap(4).items_center()
        .children(kinds.map(button))
        .when(!isDefault, (el) => el.child(this.link(t, "filter-reset", "Reset", (cx) => { this.filterMenu = null; this.setFilter(project, { ...DEFAULT_FILTER }, cx); }))))
      .when(Boolean(menu), (el) => el.child(menu));
  }

  renderPicker(t) {
    const remote = this.repo?.remote?.project;
    const current = this.project()?.permalink;
    const q = this.filter.value().trim().toLowerCase();
    const list = (this.projectList ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.permalink.includes(q));
    const row = (id, title, sub, on, onClick) =>
      h_flex().id(id).flex_none().mx(8).px(8).h(38).gap(8).rounded(6).items_center()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => onClick(cx))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).truncate().child(title))
          .child(div().text_size(11).text_color(t.dim).truncate().child(sub)));
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "Project", this.repo?.root?.split("/").pop() ?? "Outside a repo", [
        this.button(t, "picker-back", "Back", (cx) => { this.view = "list"; cx.notify(); }),
      ]))
      .child(div().flex_none().p(10).child(Input.new(this.filter).h(32).px(10).rounded(7).border(1).border_color(t.input)
        .bg(t.background).text_size(12.5).text_color(t.foreground)))
      .child(v_flex().id("project-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
        .when(Boolean(remote), (el) => el.child(row("pick-remote", "From git remote", remote, current === remote, (cx) => this.choose(null, cx))))
        .when(!q || "all projects".includes(q), (el) => el.child(row("pick-all", "All projects", "Every active project", current === ALL, (cx) => this.choose(ALL, cx))))
        .when(Boolean(this.projectError), (el) => el.child(this.note(t, this.projectError, t.ansi1)))
        .when(!this.projectList && !this.projectError, (el) => el.child(this.note(t, "Loading projects…")))
        .child(v_flex().children(list.map((p) =>
          row(`pick-${p.permalink}`, p.name, p.permalink, current === p.permalink, (cx) => this.choose(p.permalink, cx))))))
      .child(h_flex().flex_none().px(14).h(36).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate().child(this.creds ? `Signed in as ${this.creds.user}` : ""))
        .child(this.link(t, "credentials", "Settings…", (cx) => this.openSetup(cx))));
  }

  renderSetup(t) {
    const fallback = defaultBase(this.account());
    let base = fallback;
    try { base = normalizeBase(this.base.value()) ?? fallback; } catch {}
    const label = (text) => div().pt(14).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const hint = (text) => div().pt(5).text_size(11).text_color(t.dim).child(text);
    const input = (state) => Input.new(state).h(32).px(10).rounded(7).border(1).border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "Settings", "Codebase", this.creds
        ? [this.button(t, "setup-back", "Back", (cx) => { this.view = "list"; cx.notify(); })]
        : []))
      .child(v_flex().id("setup").flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(6).pb(14)
        .child(div().pt(8).text_size(12).text_color(t.muted)
          .child("Your API username and key are under My Profile → API Credentials in Codebase. They are kept in the macOS keychain, never in files."))
        .child(h_flex().pt(6).child(this.link(t, "open-profile", "Open my Codebase profile", () => this.openUrl(`${base}/settings/profile`))))
        .child(label("API username"))
        .child(input(this.user))
        .child(label("API key"))
        .child(input(this.key))
        .when(Boolean(this.creds), (el) => el.child(hint("Leave empty to keep the saved key.")))
        .child(label("Codebase URL"))
        .child(input(this.base))
        .child(hint(`For ticket links. Empty: ${fallback}. Set your own domain if you have one.`))
        .when(Boolean(this.setupError), (el) => el.child(div().pt(10).text_size(12).text_color(t.ansi1).child(this.setupError)))
        .child(h_flex().pt(16).gap(8)
          .child(this.button(t, "save", this.saving ? "Saving…" : "Save", (cx) => this.save(cx), true))
          .when(Boolean(this.creds), (el) => el.child(this.button(t, "forget", "Forget credentials", (cx) => this.forget(cx))))));
  }
}
