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
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { focused, spaces, panes, theme, checking, props, notify, run, shared, setShared, appHome, layout, nextCommand } from "herdr";
import {
  loadCredentials, saveCredentials, forgetCredentials, accountOf, usernameOf,
  ticketPage, projects, repoOf, ticketUrl, ticketsUrl, ago, ApiError, defaultBase, normalizeBase, choices,
  accountUsers, createTicket, findProjectCheckout, repositories, cloneRepository, expandHome, ticketNotes, isStartedStatus,
} from "./codebase.js";
import {
  TITLES, FIELDS, personBadge, wantPictures, CHANGED, copyId, announceChange,
  errText, openLink, iconLink, fieldMark, saveField, optionsMenu, textButton, textLink,
} from "./ui.js";
import { Viewer } from "./viewer.js";
import { FileView } from "./fileview.js";
import { filterBar, searchOf } from "./filters.js";
import { viewerPane, toggleTicket, toggleKanban, showTicket, shownTicket, BOARD } from "./panes.js";

const WATCH = 1500;       // how often to look at which folder is focused (no exec unless it changed)
const REFRESH = 120000;   // tickets
const STALE = 60000;      // switching back to a project reloads it if older than this
const BATCH = 3;          // pages (20 tickets each) loaded at a time; "Load more" gets the next ones
const SEARCH_DELAY = 400; // ms after the last key before the list searches
const SHOWN = 60;         // cards drawn at a time: All projects can load hundreds, and drawing them all is slow
const ALL = "*";          // the "project" that means every active project
const PARALLEL = 8;       // requests at a time when asking every project
const PROJECTS_DIR = "~/Sites"; // the default project folder: clones go there, checkouts are looked for there
const REFRESH_ALL = 600000; // all projects means one request per project: refresh by itself less often
const NOTICE = 20000;     // look for tickets changed elsewhere (Claude, Codebase's web UI): one request

/** The layout's nodes from the root down to this mod's block, or null when layout() leaves blocks' content out. */
function listPath(node = layout(), trail = []) {
  if (!node) return null;
  const here = [...trail, node];
  if (node.content?.mod === "codebasehq") return here;
  for (const child of node.children ?? []) { const found = listPath(child, here); if (found) return found; }
  return null;
}
const layoutNode = (id, node = layout()) =>
  node?.id === id ? node : (node?.children ?? []).map((c) => layoutNode(id, c)).find(Boolean) ?? null;

/**
 * A priority's place by its name, for when the project's own order isn't in yet: urgent and
 * the like first, then high, prioritized, normal, low. The project's positions start at 1 too.
 */
function priorityRank(name) {
  const n = (name ?? "").toLowerCase();
  if (/urgent|critical|blocker|akut|kritisk/.test(n)) return 1;
  if (/high|hög/.test(n)) return 2;
  if (/priorit/.test(n)) return 3;
  if (/low|låg/.test(n)) return 5;
  return 4;
}

/** Where a space's own project is kept among the chosen ones. */
const spaceKey = (id) => (id ? `space:${id}` : null);

/** A ticket with its project; ticket numbers are only unique within a project, so uid is both. */
const tag = (k, project, projectName) => ({ ...k, project, projectName: projectName ?? project, uid: `${project}-${k.id}` });

// The list's filter, per project. Values are what Codebase's search takes: names, and usernames
// (or "me") for the assignee. resolution: "open" | "closed" | "all".
const DEFAULT_FILTER = { assignee: ["me"], status: [], priority: [], category: [], type: [], milestone: [], resolution: "open" };

export default class Tickets extends View {
  init(_props, cx) {
    // A copy opened as a pane to show a ticket or a project's board (see viewer.js), or as a
    // dialog to show an attachment (fileview.js).
    const view = props()?.view;
    if (view === "ticket" || view === "kanban" || view === "file") {
      this.viewer = view === "file" ? new FileView() : new Viewer();
      this.viewer.init(cx);
      return;
    }
    this.creds = undefined;     // undefined: not read yet; null: none saved
    this.me = copyId();         // to know our own change announcements
    this.seenChange = shared(CHANGED)?.at ?? 0;
    this.newest = new Map();    // project -> the newest ticket update seen by notice()
    this.folderRepos = new Map(); // "<machine>\n<folder>" -> repoOf() (null: not a git repo); see repoAt
    this.metaVersion = 0;       // counts finished loadChoices, so mergedChoices knows to merge again
    this.merged = null;         // mergedChoices' last answer
    this.noticing = false;
    this.view = "list";         // "list" | "picker" | "setup" | "new" | "clone"
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
    this.peopleLoading = false;
    this.pictures = new Map();  // user id -> picture path (or null: initials)
    this.projectsLoading = false;

    this.user = InputState.new({ placeholder: "account/username" });
    this.key = InputState.new({ placeholder: "API key" });
    this.key.set_masked(true);
    try { this.baseUrl = localStorage.getItem("baseUrl") || null; } catch { this.baseUrl = null; }
    this.base = InputState.new({ placeholder: "https://example.codebasehq.com" });
    this.base.on("submit", (_e, cx) => this.save(cx));
    try { this.projectsDir = localStorage.getItem("projectsDir") || PROJECTS_DIR; } catch { this.projectsDir = PROJECTS_DIR; }
    this.projectsDirInput = InputState.new({ placeholder: PROJECTS_DIR });
    this.projectsDirInput.on("submit", (_e, cx) => this.save(cx));
    // The New ticket form.
    this.draft = null;          // { project, projectName, status, priority, type, category, assignee, menu, saving, error }
    this.summary = InputState.new({ placeholder: "Subject" });
    this.description = TextareaState.new({ placeholder: "Description (Markdown)", rows: 6 });
    this.description.set_auto_grow(6, 16);
    this.draftFilter = InputState.new({ placeholder: "Filter projects" });
    this.draftFilter.on("change", (_e, cx) => cx.notify());
    this.filter = InputState.new({ placeholder: "Filter projects" });
    // Searching the list (searchFor): words, or a ticket's number.
    this.searchText = "";
    this.searchInput = InputState.new({ placeholder: "Search: words, or #123" });
    this.searchInput.on("change", (_e, cx) => this.searchChanged(cx));
    this.searchInput.on("submit", (_e, cx) => this.searchChanged(cx, true));
    this.filter.on("change", (_e, cx) => cx.notify());
    this.key.on("submit", (_e, cx) => this.save(cx));
    // Cloning a project that has no checkout yet.
    this.cloning = null;        // { project, projectName, repos, picked, busy, progress, error }
    this.cloneDir = InputState.new({ placeholder: "Folder (empty: the default project folder)" });
    this.cloneDir.on("submit", (_e, cx) => this.cloneProject(cx));
    this.saving = false;
    this.setupError = null;

    if (checking()) return;
    // The ticket view (another copy) makes its links with the same address.
    if (this.baseUrl) setShared("codebasehq.base", this.baseUrl);
    cx.spawn(async (cx) => {
      try { this.creds = await loadCredentials(); } catch { this.creds = null; }
      if (!this.creds) this.view = "setup";
      else this.loadPeople(cx);
      this.watch(cx);
      cx.notify();
    });
    cx.timer.every(WATCH, (cx) => { this.watch(cx); this.followChanges(cx); });
    cx.timer.every(REFRESH, (cx) => this.load(cx, "timer"));
    cx.timer.every(NOTICE, (cx) => this.notice(cx));
    if (!checking()) cx.spawn((cx) => this.followCommands(cx));
  }

  // --- where we are ------------------------------------------------------------

  watch(cx) {
    if (this.creds === undefined) return;
    const f = focused();
    const cwd = f?.cwd ?? null;
    // Another space in the same folder can have a project of its own (choiceKey).
    if (f?.space && f.space !== this.space) {
      this.space = f.space;
      if (cwd === this.cwd) { this.load(cx, false); cx.notify(); }
    }
    if (cwd === this.cwd) return;
    // A pane with no folder (the ticket view, another mod) isn't somewhere else: keep showing
    // what was shown. Only the very first look settles for "outside a repo".
    const pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    if (this.cwd !== undefined && (!cwd || pane?.mod)) return;
    this.cwd = cwd;
    const machine = spaces().find((s) => s.id === f?.space)?.machine ?? undefined;
    cx.spawn(async (cx) => {
      const repo = await this.repoAt(cwd, machine);
      if (this.cwd !== cwd) return;
      this.repo = repo;
      this.load(cx, false);
      cx.notify();
    });
  }

  /** Where a choice is remembered: the repo, or "" for anywhere outside one. */
  choiceKey() {
    if (this.repo?.root) return this.repo.root;
    // Outside a repo, a space can have a project of its own (Open without cloning).
    const own = spaceKey(focused()?.space);
    return own && own in this.chosen ? own : "";
  }

  /** What this place shows when nothing was chosen: the remote's project, else all projects. */
  defaultProject() {
    return this.repo?.remote?.project ?? ALL;
  }

  project() {
    const chosen = this.chosen[this.choiceKey()];
    const permalink = chosen ?? this.defaultProject();
    const source = chosen ? (this.repo?.root ? "chosen for this repo" : this.choiceKey() ? "chosen for this space" : "chosen outside a repo")
      : this.repo?.remote ? "from git remote"
      : this.repo?.root ? "default: this repo has no Codebase remote"
      : "default outside a repo";
    // The project's own name ("Example Shop") once the project list is in, else its permalink.
    const name = permalink === ALL ? "All projects" : this.projectList?.find((x) => x.permalink === permalink)?.name ?? permalink;
    return { permalink, all: permalink === ALL, name, source };
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

  /**
   * The search sent to Codebase: the filter, and the words in the search field. "#123" or
   * "123" is that ticket; anything else is free text in summaries and notes.
   */
  searchFor(project) {
    const text = (this.searchText ?? "").trim();
    const words = /^#?\d+$/.test(text) ? `id:${text.replace("#", "")}` : text.replace(/\s+/g, " ");
    return [searchOf(this.filterFor(project)), words].filter(Boolean).join(" ");
  }

  /** The search field changed: the list follows a moment after the typing stops (Enter: at once). */
  searchChanged(cx, now = false) {
    const text = this.searchInput.value();
    if (text === this.searchText && !now) return;
    const token = (this.searchToken ?? 0) + 1;
    this.searchToken = token;
    const apply = (cx) => {
      if (this.searchToken !== token) return;
      this.searchText = this.searchInput.value();
      this.load(cx, false);
      cx.notify();
    };
    if (now) apply(cx); else cx.timer.after(SEARCH_DELAY, apply);
  }

  /**
   * A list's tickets as it shows them: the most urgent priority first (the project's own order
   * of its priorities, by position; else by the name); within one, those being worked on, then
   * the other open ones, then new ones, then closed ones; then the most recently updated first.
   * Worked out again only when the list or a project's values change (render runs often).
   */
  ordered(entry) {
    if (!entry.tickets) return null;
    if (entry.ordered?.from === entry.tickets && entry.ordered.version === this.metaVersion) return entry.ordered.list;
    const priority = (k) => {
      const p = this.meta.get(k.project)?.priorities?.find((x) => x.id === k.priorityId);
      return p?.position ?? priorityRank(k.priority);
    };
    const status = (k) => {
      if (k.closed) return 3;
      if (isStartedStatus(k.status)) return 0;
      // New: the project's first open status (or one named so, until the statuses are in).
      const first = this.meta.get(k.project)?.statuses?.find((s) => !s.closed);
      return (first ? first.id === k.statusId : /^(new|ny|nytt|nya)$/i.test(k.status ?? "")) ? 2 : 1;
    };
    const list = entry.tickets.map((k) => ({ k, p: priority(k), s: status(k) }))
      .sort((a, b) => a.p - b.p || a.s - b.s || b.k.updated - a.k.updated).map((x) => x.k);
    entry.ordered = { from: entry.tickets, version: this.metaVersion, list };
    return list;
  }

  /** Tickets are cached per project and search. */
  entryFor(project) {
    const key = `${project}\n${this.searchFor(project)}`;
    let entry = this.cache.get(key);
    if (!entry) { entry = { tickets: null, error: null, at: 0, loading: false, pages: 0, more: false, shown: SHOWN }; this.cache.set(key, entry); }
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
    const search = this.searchFor(p.permalink);
    const entry = this.entryFor(p.permalink);
    if (entry.loading) { if (force === true) entry.again = true; return; }
    if (!more && !force && Date.now() - entry.at < STALE) return;
    if (more && !entry.more) return;
    const first = more ? entry.pages + 1 : 1;
    const last = more ? entry.pages + BATCH : Math.max(entry.pages, BATCH);
    entry.loading = true;
    this.loadChoices(p.permalink, cx);
    this.ensureProjects(cx); // for the project's name
    cx.notify();
    cx.spawn(async (cx) => {
      let list = more ? [...(entry.tickets ?? [])] : [];
      const seen = new Set(list.map((k) => k.uid));
      const fresh = !entry.tickets;
      let page = first, hasMore = true;
      try {
        for (; page <= last && hasMore; page++) {
          const r = await ticketPage(this.creds, p.permalink, search, page, "priority");
          // A ticket updated while paging can come twice.
          const add = r.tickets.map((k) => tag(k, p.permalink)).filter((k) => !seen.has(k.uid));
          for (const k of add) seen.add(k.uid);
          list = list.concat(add);
          hasMore = r.more;
          if (fresh || more) { entry.tickets = list; cx.notify(); }
        }
        entry.tickets = list;
        entry.pages = page - 1;
        entry.more = hasMore;
        entry.error = null;
      } catch (e) {
        this.loadFailed(entry, e);
      }
      entry.at = Date.now();
      entry.loading = false;
      this.wantShownPictures(cx);
      // A change came while this loaded: what came may predate it.
      if (entry.again) { entry.again = false; this.load(cx, true); }
      cx.notify();
    });
  }

  /**
   * All projects: one page from every active project (PARALLEL at a time), merged and sorted
   * by last update; "Load more" asks the projects that had more for their next page.
   */
  loadAll(cx, force, more) {
    const entry = this.entryFor(ALL);
    if (entry.loading) { if (force === true) entry.again = true; return; }
    if (!more && !force && Date.now() - entry.at < STALE) return;
    if (force === "timer" && Date.now() - entry.at < REFRESH_ALL) return;
    if (more && !entry.more) return;
    const search = this.searchFor(ALL);
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
              const r = await ticketPage(this.creds, project, search, next.get(project), "priority");
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
        this.loadFailed(entry, e);
      }
      entry.at = Date.now();
      entry.loading = false;
      this.wantShownPictures(cx);
      // A change came while this loaded: what came may predate it.
      if (entry.again) { entry.again = false; this.load(cx, true); }
      cx.notify();
    });
  }

  /**
   * The space that works in a project: first one with a terminal in a checkout of one of the
   * project's repositories, else one whose folder is such a checkout. Terminals come first as
   * a space's folder is only where new terminals start, and can be somewhere else entirely.
   * Folders are looked up once.
   */
  async spaceFor(project) {
    const list = spaces(), all = panes();
    // The checkout's root when the folder is in the project, else null.
    const inProject = async (s, folder) => {
      const repo = await this.repoAt(folder, s.machine ?? undefined);
      return repo?.remote?.project === project ? repo.root : null;
    };
    for (const s of list) {
      const tabs = new Set(s.tabs.map((x) => x.id));
      const folders = new Set(all.filter((x) => tabs.has(x.tab) && x.cwd).map((x) => x.cwd));
      for (const folder of folders) { const root = await inProject(s, folder); if (root) return { space: s, root }; }
    }
    for (const s of list) {
      const root = s.folder ? await inProject(s, s.folder) : null;
      if (root) return { space: s, root };
    }
    return null;
  }

  /** repoOf(folder), asked once per folder (a manual reload asks again). */
  async repoAt(folder, machine) {
    const key = `${machine ?? ""}\n${folder}`;
    if (!this.folderRepos.has(key)) this.folderRepos.set(key, await repoOf(folder, machine).catch(() => null));
    return this.folderRepos.get(key);
  }

  /**
   * Going to a project from its name: the list there shows that project, so a project or All
   * projects picked for that checkout before is let go (it follows the git remote again).
   */
  followRemote(root) {
    if (!root || !(root in this.chosen)) return;
    delete this.chosen[root];
    this.saveChosen();
  }

  saveChosen() {
    // A space's own project goes when the space does.
    const live = new Set(spaces().map((s) => spaceKey(s.id)));
    for (const key of Object.keys(this.chosen)) if (key.startsWith("space:") && !live.has(key)) delete this.chosen[key];
    try { localStorage.setItem("projects", JSON.stringify(this.chosen)); } catch {}
  }

  /**
   * Goes to the space that works in the ticket's project (from a card in All projects). With
   * none, opens one in a local checkout of the project found next to the spaces' folders.
   */
  goToProject(k, cx) {
    cx.spawn(async (cx) => {
      const found = await this.spaceFor(k.project);
      if (found) {
        this.followRemote(found.root);
        run("space.select", { id: found.space.id });
        await this.showListIn((x) => x.id === found.space.id, cx);
        return;
      }
      const local = spaces().filter((x) => !x.machine);
      const tabs = new Set(local.flatMap((x) => x.tabs.map((tab) => tab.id)));
      const folders = [expandHome(this.projectsDir), ...local.map((x) => x.folder), ...panes().filter((x) => tabs.has(x.tab)).map((x) => x.cwd)];
      const folder = await findProjectCheckout(k.project, [...new Set(folders.filter(Boolean))]).catch(() => null);
      if (folder) { this.followRemote(folder); run("space.new", { folder }); await this.showListIn((x) => x.folder === folder, cx); }
      else this.openClone(k, cx);
    });
  }

  /** No checkout of the project anywhere: offers to clone one of its repositories. */
  openClone(k, cx) {
    const c = { project: k.project, projectName: k.projectName ?? k.project, repos: null, picked: null, busy: false, error: null };
    this.cloning = c;
    this.view = "clone";
    this.cloneDir.set_value(this.projectsDir);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        c.repos = await repositories(this.creds, c.project);
        if (c.repos.length === 1) c.picked = c.repos[0].permalink;
        if (!c.repos.length) c.error = "The project has no git repositories.";
      } catch (e) { c.error = errText(e); }
      cx.notify();
    });
  }

  /**
   * Opens a space for the project in the default project folder (Settings), named after the
   * project, without cloning anything. The list there shows that project: the space's own choice.
   */
  openWithoutClone(cx) {
    const c = this.cloning;
    if (!c || c.busy) return;
    const folder = expandHome(this.projectsDir);
    const before = new Set(spaces().map((s) => s.id));
    this.cloning = null;
    this.view = "list";
    run("space.new", { folder, name: c.projectName });
    cx.spawn(async (cx) => {
      await this.showListIn((x) => !before.has(x.id), cx, (space) => {
        this.chosen[spaceKey(space.id)] = c.project;
        this.saveChosen();
        this.load(cx, false);
        cx.notify();
      });
    });
    cx.notify();
  }

  /** Clones the picked repository, then opens a space there with the list showing. */
  cloneProject(cx) {
    const c = this.cloning;
    const repo = c?.repos?.find((r) => r.permalink === c.picked);
    if (!c || c.busy) return;
    if (!repo) { c.error = "Pick a repository first."; cx.notify(); return; }
    const parent = this.cloneDir.value().trim() || this.projectsDir;
    c.busy = true;
    c.error = null;
    c.progress = { step: "Connecting", percent: 0, overall: 0, detail: null };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const folder = await cloneRepository(repo.cloneUrl, parent, repo.permalink, {
          log: `${appHome()}/data/codebasehq-clone-${Date.now()}.log`,
          sleep: (ms) => cx.sleep(ms),
          onProgress: (p) => { c.progress = p; cx.notify(); },
        });
        if (this.cloning === c) { this.cloning = null; this.view = "list"; }
        notify({ title: `Cloned ${repo.name}`, body: folder, level: "success" });
        run("space.new", { folder });
        await this.showListIn((x) => x.folder === folder, cx);
      } catch (e) {
        c.busy = false;
        c.progress = null;
        c.error = errText(e);
      }
      cx.notify();
    });
  }

  /**
   * Shows the list once the space that `is` picks is the shown one. The tab bar puts back each
   * space's own side panel when it switches, so this waits for that before showing the list.
   */
  async showListIn(is, cx, found) {
    for (let waited = 0; waited < 3000; waited += 100) {
      const space = spaces().find((x) => x.active && is(x));
      if (space) {
        found?.(space);
        await cx.sleep(500);
        this.showList();
        return;
      }
      await cx.sleep(100);
    }
  }

  /** A list couldn't be loaded: it says why; a refused key opens the settings. */
  loadFailed(entry, e) {
    entry.error = errText(e);
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { this.setupError = entry.error; this.view = "setup"; }
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
    wantPictures(this, ids, cx);
  }

  /**
   * A ticket changed somewhere else (the board, the ticket pane): every list is out of date,
   * the shown one reloads now.
   */
  followChanges(cx) {
    const c = shared(CHANGED);
    if (!c?.at || c.at <= this.seenChange) return;
    this.seenChange = c.at;
    if (c.from === this.me) return;
    this.reloadAll(cx);
  }

  /** The Reload button: the folder's repo and git remote are looked up again too, then the list. */
  reloadHere(cx) {
    this.folderRepos.clear();
    if (this.cwd) {
      const cwd = this.cwd, machine = spaces().find((s) => s.id === focused()?.space)?.machine ?? undefined;
      cx.spawn(async (cx) => {
        const repo = await this.repoAt(cwd, machine);
        if (this.cwd === cwd) this.repo = repo;
        this.load(cx, true);
        cx.notify();
      });
    } else this.load(cx, true);
  }

  /** Every list is out of date: the shown one reloads now, the others when shown. */
  reloadAll(cx) {
    for (const entry of this.cache.values()) entry.at = 0;
    this.load(cx, true);
  }

  /**
   * Tickets changed where this mod doesn't hear of it (by Claude, in Codebase's web UI): asks for
   * a project's most recently updated tickets, whatever the filter, and when one is newer than
   * last time, tells the board and the ticket pane, reloads the list (the shown project's) and
   * says so for new notes by others on your tickets (noteNotices). In a project: that project.
   * In All projects: the projects your listed tickets are in, one per look (reloading them all
   * would be one request per project).
   */
  notice(cx) {
    const p = this.project();
    if (!p || !this.creds || this.noticing) return;
    let project = p.permalink;
    if (p.all) {
      const me = usernameOf(this.creds)?.toLowerCase();
      const mine = [...new Set((this.entryFor(ALL).tickets ?? []).filter((k) => this.isMine(k, me)).map((k) => k.project))];
      if (!mine.length) return;
      this.noticeTurn = ((this.noticeTurn ?? -1) + 1) % mine.length;
      project = mine[this.noticeTurn];
    }
    this.noticing = true;
    cx.spawn(async (cx) => {
      try {
        const { tickets } = await ticketPage(this.creds, project, "", 1);
        const newest = Math.max(0, ...tickets.map((k) => k.updated));
        const before = this.newest.get(project);
        this.newest.set(project, Math.max(newest, before ?? 0));
        if (before !== undefined && newest > before) {
          const changed = tickets.filter((k) => k.updated > before);
          announceChange(this.me, project, changed.map((k) => k.id));
          if (!p.all) this.reloadAll(cx);
          await this.noteNotices(project, changed, before);
        }
      } catch { /* the next look, or the refresh, catches it */ }
      this.noticing = false;
      cx.notify();
    });
  }

  /** Whether a ticket is assigned to you (me: your username, lower case). */
  isMine(k, me = usernameOf(this.creds)?.toLowerCase()) {
    return Boolean(me) && ((k.assignee ?? "").toLowerCase() === me || (k.assigneeId != null && k.assigneeId === this.myId()));
  }

  /** Your user id, from the account's people (once they are in). */
  myId() {
    const name = this.people?.byUsername?.get(usernameOf(this.creds)?.toLowerCase() ?? "");
    return name ? this.people.idByName.get(name.toLowerCase()) ?? null : null;
  }

  /**
   * A notification per ticket of yours (among the changed) with notes by someone else since
   * `since`: who, and the note's first line or its changes. Clicking it shows the ticket in the
   * ticket pane (the "codebasehq.open:<project>:<id>" command, see init). At most 3 tickets a look.
   */
  async noteNotices(project, changed, since) {
    const me = this.myId();
    const projectName = this.projectList?.find((x) => x.permalink === project)?.name ?? project;
    for (const k of changed.filter((x) => this.isMine(x)).slice(0, 3)) {
      const notes = (await ticketNotes(this.creds, project, k.id).catch(() => []))
        .filter((n) => n.created > since && (me == null || n.userId !== me));
      const n = notes[notes.length - 1];
      if (!n) continue;
      const who = this.people?.byId?.get(n.userId) ?? "Someone";
      const text = (n.content ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);
      const changes = Object.entries(n.updates ?? {}).filter(([, v]) => Array.isArray(v)).map(([, [, to]]) => to).filter(Boolean);
      const what = text ? (text.length > 140 ? `${text.slice(0, 139)}…` : text) : changes.length ? `Changed: ${changes.join(", ")}` : "A new note";
      notify({
        title: `#${k.id} ${k.summary}`.slice(0, 90), body: `${who}${notes.length > 1 ? ` (+${notes.length - 1})` : ""}: ${what}`,
        level: "info", timeout: 15000, icon: "mods/codebasehq/ticket.svg",
        action: { name: `codebasehq.open:${project}:${k.id}`, args: { projectName } },
      });
    }
  }

  /** Commands for this copy: "open:<project>:<id>" (a note notification clicked) shows that ticket. */
  async followCommands(cx) {
    for (;;) {
      let c;
      try { c = await nextCommand(); } catch { return; } // the copy is closing
      const m = /^open:([\w.-]+):(\d+)$/.exec(c ?? "");
      if (!m) continue;
      const [, project, id] = m;
      const projectName = this.projectList?.find((x) => x.permalink === project)?.name ?? project;
      showTicket({ project, id: Number(id), uid: `${project}-${id}`, projectName }, cx);
      cx.notify();
    }
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
      this.metaVersion++;
      this.wantShownPictures(cx);
      cx.notify();
    });
  }

  toggleMenu(k, kind, cx) {
    const open = this.menu?.id === k.uid && this.menu.kind === kind;
    this.menu = open ? null : { id: k.uid, kind };
    if (!open) this.loadChoices(k.project, cx);
    cx.notify();
  }

  /** Changes a field from a card; a ticket closed while the list shows open ones leaves it. */
  change(k, kind, option, cx) {
    this.menu = null;
    saveField(cx, {
      creds: this.creds, from: this.me, project: k.project, k, kind, option, busy: this.updating, key: k.uid,
      after: (ok) => {
        const shown = this.project().permalink;
        if (!ok || kind !== "status" || !option.closed || this.filterFor(shown).resolution !== "open") return;
        const entry = this.entryFor(shown);
        if (entry?.tickets) entry.tickets = entry.tickets.filter((x) => x !== k);
        notify({ title: `#${k.id} ${option.name}`, body: k.summary, level: "success", timeout: 4000 });
      },
    });
    cx.notify();
  }

  // --- new ticket ------------------------------------------------------------------

  /** Opens the New ticket form: for the shown project, or with a project to pick (All projects). */
  openNew(cx) {
    const p = this.project();
    this.draft = { project: p.all ? null : p.permalink, projectName: p.all ? null : p.name, menu: p.all ? "project" : null, saving: false, error: null };
    this.summary.set_value("");
    this.description.set_value("");
    this.draftFilter.set_value("");
    this.view = "new";
    if (this.draft.project) { this.loadChoices(this.draft.project, cx); this.summary.focus(); }
    else this.ensureProjects(cx);
    cx.notify();
  }

  ensureProjects(cx) {
    if (this.projectList || this.projectsLoading) return;
    this.projectsLoading = true;
    cx.spawn(async (cx) => {
      try { this.projectList = await projects(this.creds); this.projectError = null; }
      catch (e) { this.projectError = errText(e); }
      this.projectsLoading = false;
      cx.notify();
    });
  }

  /** The draft's value for a field: picked, else the project's default (first open status, default priority). */
  draftValue(kind) {
    const d = this.draft, meta = d?.project ? this.meta.get(d.project) : null;
    if (d && d[kind] !== undefined) return d[kind];
    if (!meta?.statuses) return null;
    if (kind === "status") return meta.statuses.find((x) => !x.closed) ?? null;
    if (kind === "priority") return meta.priorities.find((x) => x.isDefault) ?? meta.priorities[0] ?? null;
    if (kind === "type") return meta.types[0] ?? null;
    if (kind === "category") return meta.categories[0] ?? null;
    return null; // assignee and milestone: none unless picked
  }

  submitNew(cx) {
    const d = this.draft;
    const summary = this.summary.value().trim();
    if (!d.project) { d.error = "Pick the ticket's project."; cx.notify(); return; }
    if (!summary) { d.error = "Write a subject."; this.summary.focus(); cx.notify(); return; }
    if (d.saving) return;
    d.saving = true; d.error = null;
    cx.notify();
    const id = (kind) => this.draftValue(kind)?.id ?? undefined;
    cx.spawn(async (cx) => {
      try {
        const k = await createTicket(this.creds, d.project, {
          summary, description: this.description.value().trim() || undefined,
          status_id: id("status"), priority_id: id("priority"), ticket_type_id: id("type"),
          category_id: id("category"), assignee_id: id("assignee"), milestone_id: id("milestone"),
        });
        notify({ title: `#${k.id} created`, body: summary, level: "success", timeout: 5000 });
        announceChange(this.me, d.project, k.id);
        this.draft = null;
        this.view = "list";
        // The lists that may show it are out of date now.
        for (const [key, entry] of this.cache) if (key.startsWith(`${d.project}\n`) || key.startsWith(`${ALL}\n`)) entry.at = 0;
        this.load(cx, true);
        // Show it in the ticket pane (opening one if there is none; never closing it).
        showTicket({ project: d.project, id: k.id, uid: `${d.project}-${k.id}`, projectName: d.projectName ?? d.project }, cx);
      } catch (e) {
        d.saving = false;
        d.error = errText(e);
      }
      cx.notify();
    });
  }

  openPicker(cx) {
    this.view = "picker";
    this.filter.set_value("");
    this.filter.focus();
    this.ensureProjects(cx);
    cx.notify();
  }

  choose(permalink, cx) {
    const key = this.choiceKey();
    if (permalink && permalink !== this.defaultProject()) this.chosen[key] = permalink;
    else delete this.chosen[key];
    this.saveChosen();
    this.view = "list";
    this.load(cx, false);
    cx.notify();
  }

  openSetup(cx) {
    this.view = "setup";
    this.user.set_value(this.creds?.user ?? "");
    this.key.set_value("");
    this.base.set_value(this.baseUrl ?? "");
    this.projectsDirInput.set_value(this.projectsDir);
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
    const projectsDir = this.projectsDirInput.value().trim().replace(/(.)\/+$/, "$1") || PROJECTS_DIR;
    if (!/^(\/|~\/|~$)/.test(projectsDir)) { this.setupError = "Give the project folder as a full path, or one starting with ~/."; cx.notify(); return; }
    if (this.saving) return;
    this.saving = true;
    this.setupError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.baseUrl = base;
        try { if (base) localStorage.setItem("baseUrl", base); else localStorage.removeItem("baseUrl"); } catch {}
        setShared("codebasehq.base", base);
        this.projectsDir = projectsDir;
        try { if (projectsDir !== PROJECTS_DIR) localStorage.setItem("projectsDir", projectsDir); else localStorage.removeItem("projectsDir"); } catch {}
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

  /**
   * Puts the list away (opening the board): hides the side panel this block is in (the layout's
   * "panel"), else this block. The Tickets button in the tab bar shows it again.
   */
  hideList() {
    const found = listPath();
    // Without the blocks' content in layout(), the layout's side panel by its id.
    const panel = found ? found.find((n) => n.id === "panel") ?? found[found.length - 1] : layoutNode("panel");
    if (panel?.id && !panel.hidden) run("layout.hide", { id: panel.id });
  }

  /** Shows the list: picks this block in its stack (as the Tickets button does) and shows what hides it. */
  showList() {
    const found = listPath();
    if (!found) {
      run("layout.select", { stack: "panel-body", child: "codebasehq" });
      run("layout.show", { id: "panel" });
      return;
    }
    const block = found[found.length - 1], parent = found[found.length - 2];
    if (parent?.id && block.id) run("layout.select", { stack: parent.id, child: block.id });
    for (const n of found) if (n.id && n.hidden) run("layout.show", { id: n.id });
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
      : this.view === "new" ? this.renderNew(t)
      : this.view === "clone" && this.cloning ? this.renderClone(t)
      : this.renderList(t);
    return root.bg(t.surface).text_color(t.foreground).child(body);
  }

  note(t, text, color) {
    return div().p(14).text_size(12).text_color(color ?? t.dim).child(text);
  }

  button(t, id, label, onClick, strong) {
    return textButton(t, id, label, onClick, strong);
  }

  link(t, id, label, onClick) {
    return textLink(t, id, label, onClick);
  }

  /** A framed icon button (the header's). Every icon button says what it does in a tooltip. */
  icon(t, id, path, onClick, tip, active = false, spin = false) {
    return div().id(id).flex_none().size(24).rounded(6).flex().items_center().justify_center()
      .border(1).border_color(active ? t.accent : t.border).bg(active ? t.selected : t.surface)
      .text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => onClick(cx))
      .child(spin ? svg(path).size(13).spin(900) : svg(path).size(13));
  }

  /** A text field. */
  input(t, state) {
    return Input.new(state).h(32).px(10).rounded(7).border(1).border_color(t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
  }

  header(t, title, subtitle, buttons) {
    return h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(14).font_semibold().child(title))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).truncate().child(subtitle ?? ""))
      .children(buttons);
  }

  renderList(t) {
    const p = this.project();
    const entry = this.entryFor(p.permalink);
    const tickets = this.ordered(entry);
    const resolution = this.filterFor(p.permalink).resolution;
    // The project's name is on the line under the header.
    const subtitle = tickets ? `${tickets.length}${entry.more ? "+" : ""}${resolution === "all" ? "" : ` ${resolution}`}` : "";
    const boardOpen = !p.all && Boolean(viewerPane("kanban")) && shared(BOARD)?.project === p.permalink;
    const header = this.header(t, "Tickets", subtitle, [
      ...(p.all ? [] : [this.icon(t, "kanban", "mods/codebasehq/icons/kanban.svg", (cx) => { if (!boardOpen) this.hideList(); toggleKanban(p, cx); cx.notify(); },
        boardOpen ? "Close the Kanban board" : `Kanban board of ${p.name}`, boardOpen)]),
      this.icon(t, "project", "mods/codebasehq/icons/folder.svg", (cx) => this.openPicker(cx), `Project: ${p.name} (change)`),
      this.icon(t, "new-ticket", "mods/codebasehq/icons/plus.svg", (cx) => this.openNew(cx),
        p.all ? "New ticket (pick its project)" : `New ticket in ${p.name}`),
      this.icon(t, "refresh", "mods/codebasehq/icons/refresh.svg", (cx) => this.reloadHere(cx),
        entry.loading ? "Loading…" : "Reload the tickets", false, entry.loading),
      this.icon(t, "settings", "mods/codebasehq/settings.svg", (cx) => this.openSetup(cx), "Settings: Codebase API credentials and URL"),
    ]);

    let content;
    if (entry.error && !tickets) {
      content = this.note(t, entry.error, t.ansi1);
    } else if (!tickets) {
      content = this.note(t, "Loading tickets…");
    } else {
      const base = this.webBase();
      const now = Date.now();
      const label = (k, kind) => {
        if (kind === "assignee") {
          if (k.assigneeId == null && !k.assignee) return "Unassigned";
          return this.meta.get(k.project)?.users?.find((u) => u.id === k.assigneeId)?.name ?? k.assignee;
        }
        return k[FIELDS[kind].name] ?? "—";
      };
      const mark = (kind, o, size) => fieldMark(t, kind, o, size, this.person(t));
      const chip = (k, kind) => {
        const f = FIELDS[kind];
        const open = this.menu?.id === k.uid && this.menu.kind === kind;
        const value = { id: k[f.id] ?? null, name: label(k, kind), colour: f.colour ? k[f.colour] : null, icon: f.icon ? k[f.icon] : null };
        // Priority and type are icons only (hover for the value); the others show their name too.
        const text = kind === "status" || kind === "category" || kind === "assignee";
        return h_flex().id(`${kind}-${k.uid}`).flex_none().gap(5).h(22).rounded(5).items_center().justify_center()
          .when(text, (el) => el.px(5).min_w(0).flex_shrink_1()).when(!text, (el) => el.w(24))
          .text_size(11.5).text_color(open ? t.foreground : t.muted).when(open, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`${TITLES[kind]}: ${value.name ?? "Unassigned"}`)
          .on_click((_e, cx) => this.toggleMenu(k, kind, cx))
          .child(mark(kind, value, 13))
          .when(text, (el) => el.child(div().min_w(0).truncate().child(value.name ?? "Unassigned")));
      };
      const menu = (k) => {
        const kind = this.menu.kind;
        return div().pt(4).border_t(1).border_color(t.border).child(optionsMenu(t, {
          id: `opt-${k.uid}-${kind}`, kind, meta: this.meta.get(k.project), picked: k[FIELDS[kind].id] ?? null,
          person: this.person(t), pick: (o, cx) => this.change(k, kind, o, cx),
        }));
      };
      const viewing = shownTicket();
      const card = (k) => {
        const shown = viewing === k.uid;
        return v_flex().id(`ticket-${k.uid}`).flex_none().mx(10).mb(8).px(12).pt(10).pb(8).gap(6)
          .rounded(8).border(1).border_color(shown ? t.accent : this.menu?.id === k.uid ? t.input : t.border).bg(t.raised)
          .hover((s) => s.border_color(t.input))
          .when(p.all, (el) => el.child(h_flex().mb(-3).child(div().id(`project-${k.uid}`).min_w(0).truncate()
            .text_size(11).text_color(t.dim).hover((s) => s.text_color(t.accent))
            .tooltip("Go to the space that works in this project")
            .on_click((_e, cx) => this.goToProject(k, cx))
            .child(k.projectName ?? k.project))))
          .child(h_flex().gap(8).items_start()
            .child(div().flex_none().text_size(13).font_semibold().text_color(t.muted).child(`#${k.id}`))
            .child(div().id(`title-${k.uid}`).flex_1().min_w(0).text_size(13).rounded(4)
              .text_color(shown ? t.accent : t.foreground).hover((s) => s.text_color(t.accent))
              .tooltip(shown ? "Close the ticket view" : "Show the whole ticket")
              .on_click((_e, cx) => { toggleTicket(k, cx); cx.notify(); })
              .child(k.summary))
            .child(h_flex().flex_none().gap(2).mt(-2).mr(-6)
              .child(iconLink(t, `copy-${k.uid}`, this.copied === k.uid ? "mods/codebasehq/check.svg" : "mods/codebasehq/copy.svg", (cx) => {
                cx.write_to_clipboard(`#${k.id} ${k.summary}`);
                this.copied = k.uid;
                cx.timer.after(1500, (cx) => { if (this.copied === k.uid) { this.copied = null; cx.notify(); } });
                cx.notify();
              }, this.copied === k.uid ? t.ansi2 : null, this.copied === k.uid ? "Copied" : `Copy "#${k.id} ${k.summary}"`))
              .child(iconLink(t, `open-${k.uid}`, "mods/codebasehq/external.svg", (cx) => openLink(cx, ticketUrl(base, k.project, k.id)), null, "Open in Codebase"))))
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
      };
      content = v_flex()
        .when(Boolean(entry.error), (el) => el.child(this.note(t, entry.error, t.ansi1)))
        .when(tickets.length === 0, (el) => el.child(this.note(t, entry.loading ? "Loading…"
          : this.searchText.trim() ? "No tickets match the search and the filter." : "No tickets match the filter.")))
        .children(tickets.slice(0, entry.shown).map(card))
        .when(tickets.length > entry.shown, (el) => el.child(h_flex().px(10).pb(12).justify_center()
          .child(this.button(t, "show-more", `Show more (${tickets.length - entry.shown} not shown)`, (cx) => { entry.shown += SHOWN; cx.notify(); }))))
        .when(tickets.length <= entry.shown && (entry.more || (entry.loading && tickets.length > 0)), (el) => el.child(h_flex().px(10).pb(12).justify_center()
          .child(entry.loading
            ? div().text_size(12).text_color(t.dim).child("Loading…")
            : this.button(t, "load-more", "Load more", (cx) => { entry.shown = tickets.length + SHOWN; this.load(cx, false, true); }))));
    }

    return v_flex().size_full().min_h(0)
      .child(header)
      .child(v_flex().id("tickets-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.projectLine(t, p))
        .child(this.searchBar(t))
        .child(this.renderFilters(t, p.permalink))
        .child(content));
  }

  /** The search field above the filters, with a button that clears it. */
  searchBar(t) {
    const text = this.searchInput.value();
    return h_flex().px(10).pb(8).gap(4).items_center()
      .child(div().flex_1().min_w(0).child(Input.new(this.searchInput).h(28).px(8).rounded(6).border(1)
        .border_color(this.searchText ? t.accent : t.input).bg(t.background).text_size(12.5)))
      .when(Boolean(text), (el) => el.child(iconLink(t, "search-clear", "mods/codebasehq/icons/x.svg", (cx) => {
        this.searchInput.set_value("");
        this.searchChanged(cx, true);
      }, null, "Clear the search")));
  }

  /**
   * The line under the header: the project's name, an icon linking to its tickets in Codebase,
   * then where the project comes from. All projects has no page: no icon.
   */
  projectLine(t, p) {
    return h_flex().px(14).pt(10).pb(8).gap(4).items_center().text_size(12)
      .child(div().flex_shrink_1().min_w(0).truncate().font_semibold().child(p.name))
      .when(!p.all, (el) => el.child(div().flex_none().mr(-2).child(iconLink(t, "project-link", "mods/codebasehq/external.svg",
        (cx) => openLink(cx, ticketsUrl(this.webBase(), p.permalink)), null, `Open ${p.name}'s tickets in Codebase`))))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).truncate().child(`· ${p.source}`));
  }

  /**
   * For All projects: the filter values of the projects in the list, together (by name;
   * people by username).
   */
  mergedChoices() {
    // Worked out again only when the list or a project's values changed (render runs often).
    const tickets = this.entryFor(ALL).tickets;
    if (this.merged?.tickets === tickets && this.merged.version === this.metaVersion) return this.merged.value;
    const value = this.mergeChoices(tickets ?? []);
    this.merged = { tickets, version: this.metaVersion, value };
    return value;
  }

  mergeChoices(tickets) {
    const projects = new Set(tickets.map((k) => k.project));
    const metas = [...projects].map((x) => this.meta.get(x)).filter(Boolean);
    if (metas.some((m) => m.loading) && !metas.some((m) => m.statuses)) return { loading: true };
    const merged = { loading: false };
    for (const [list, key] of [["statuses", "name"], ["priorities", "name"], ["types", "name"], ["categories", "name"], ["users", "username"], ["allMilestones", "name"]]) {
      const seen = new Map();
      for (const m of metas) for (const o of m[list] ?? []) if (o[key] && !seen.has(o[key])) seen.set(o[key], o);
      merged[list] = [...seen.values()];
      if (list === "categories" || list === "users") merged[list].sort((a, b) => a.name.localeCompare(b.name, "sv"));
      if (list === "allMilestones") merged[list].sort((a, b) => a.done - b.done || a.name.localeCompare(b.name, "sv"));
    }
    return merged;
  }

  /** Draws someone (an option {id, name}): their picture, else initials. */
  person(t) {
    return (o, size) => personBadge(t, o.name, size, this.pictures.get(o.id));
  }

  /** The filter bar (filters.js), with this project's filter and values. */
  renderFilters(t, project) {
    return filterBar(t, {
      id: "filter",
      filter: this.filterFor(project),
      defaults: DEFAULT_FILTER,
      meta: project === ALL ? this.mergedChoices() : this.meta.get(project),
      me: usernameOf(this.creds),
      open: this.filterMenu,
      setOpen: (kind, cx) => { this.filterMenu = kind; cx.notify(); },
      set: (f, cx) => this.setFilter(project, f, cx),
      loadMeta: (cx) => { if (project !== ALL) this.loadChoices(project, cx); },
    });
  }

  renderNew(t) {
    const d = this.draft;
    const meta = d.project ? this.meta.get(d.project) : null;
    const label = (text) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const me = usernameOf(this.creds);
    const options = (kind) => {
      if (kind === "project") {
        const q = this.draftFilter.value().trim().toLowerCase();
        return (this.projectList ?? []).filter((x) => !q || x.name.toLowerCase().includes(q) || x.permalink.includes(q))
          .map((x) => ({ id: x.permalink, name: x.name, sub: x.permalink }));
      }
      if (!meta?.statuses) return null;
      if (kind === "status") return meta.statuses.filter((x) => !x.closed);
      if (kind === "priority") return meta.priorities;
      if (kind === "type") return meta.types;
      if (kind === "category") return meta.categories;
      if (kind === "milestone") return meta.milestones;
      // People on the project, you first.
      const users = (meta.users ?? []).filter((u) => u.id != null);
      return [{ id: null, name: "Unassigned" }, ...users.filter((u) => u.username === me), ...users.filter((u) => u.username !== me)];
    };
    const mark = (kind, o) => kind === "project"
      ? svg("mods/codebasehq/ticket.svg").size(13).flex_none().text_color(t.muted)
      : fieldMark(t, kind, o, 13, this.person(t));
    const select = (kind, title) => {
      const value = kind === "project" ? (d.project ? { name: d.projectName ?? d.project } : null) : this.draftValue(kind);
      const open = d.menu === kind;
      const list = open ? options(kind) : null;
      return v_flex()
        .child(label(title))
        .child(h_flex().id(`new-${kind}`).h(32).px(10).gap(8).rounded(7).items_center().border(1)
          .border_color(open ? t.accent : t.input).bg(t.background).text_size(12.5).cursor_pointer()
          .hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => { d.menu = open ? null : kind; if (kind === "project") this.ensureProjects(cx); cx.notify(); })
          .child(mark(kind, value))
          .child(div().flex_1().min_w(0).truncate().text_color(value ? t.foreground : t.dim)
            .child(value?.name ?? (kind === "assignee" ? "Unassigned" : kind === "milestone" ? "None" : kind === "project" ? "Pick a project" : "—")))
          .child(svg(`mods/codebasehq/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)))
        .when(open, (el) => el.child(v_flex().mt(4).p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.raised)
          .when(kind === "project", (el) => el.child(div().p(2).child(Input.new(this.draftFilter).h(28).px(8).rounded(6).border(1)
            .border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))))
          .when(!list, (el) => el.child(this.note(t, kind === "project" ? (this.projectError ?? "Loading projects…") : (meta?.error ?? "Loading…"))))
          .when(Boolean(list), (el) => el.child(v_flex().id(`new-${kind}-options`).max_h(240).overflow_y_scrollbar().children(list.map((o) =>
            h_flex().id(`new-${kind}-${o.id ?? "none"}`).h(28).px(6).gap(8).rounded(5).items_center().text_size(12)
              .when(kind === "project" ? o.id === d.project : (value?.id ?? null) === (o.id ?? null), (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (kind === "project") {
                  if (o.id !== d.project) Object.assign(d, { project: o.id, projectName: o.name, status: undefined, priority: undefined, type: undefined, category: undefined, assignee: undefined, milestone: undefined });
                  this.loadChoices(o.id, cx);
                  this.summary.focus();
                } else d[kind] = o.id == null && kind === "assignee" ? null : o;
                d.menu = null;
                cx.notify();
              })
              .child(h_flex().w(18).flex_none().justify_center().child(mark(kind, o)))
              .child(div().flex_1().min_w(0).truncate().text_color(o.id == null ? t.muted : t.foreground).child(o.name))
              .when(Boolean(o.sub), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(o.sub)))))))));
    };
    const cancel = (cx) => { this.draft = null; this.view = "list"; cx.notify(); };
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "New ticket", d.projectName ?? "", [this.button(t, "new-cancel", "Cancel", cancel)]))
      .child(v_flex().id("new-form").flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(4).pb(14)
        .child(select("project", "Project"))
        .when(Boolean(d.project), (el) => el
          .child(label("Subject")).child(this.input(t, this.summary))
          .child(label("Description"))
          .child(Textarea.new(this.description).px(10).py(6).rounded(7).border(1).border_color(t.input)
            .bg(t.background).text_size(12.5).text_color(t.foreground))
          .child(select("status", TITLES.status))
          .child(select("priority", TITLES.priority))
          .child(select("type", TITLES.type))
          .child(select("category", TITLES.category))
          .child(select("assignee", TITLES.assignee))
          .child(select("milestone", TITLES.milestone)))
        .when(Boolean(d.error), (el) => el.child(div().pt(12).text_size(12).text_color(t.ansi1).child(d.error)))
        .child(h_flex().pt(16).gap(8)
          .child(this.button(t, "new-create", d.saving ? "Creating…" : "Create ticket", (cx) => this.submitNew(cx), true))
          .child(this.button(t, "new-cancel-2", "Cancel", cancel))));
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
      .child(div().flex_none().p(10).child(this.input(t, this.filter)))
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

  /** The clone's progress: git's step and a bar for the whole clone. */
  cloneBar(t, p) {
    return v_flex().pt(14).gap(6)
      .child(h_flex().gap(8).text_size(11.5)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.percent ? `${p.step} ${p.percent}%` : `${p.step}…`))
        .child(div().flex_none().text_color(t.dim).child(p.detail ?? "")))
      .child(Progress.new("clone-progress").value(p.overall)
        .child(ProgressTrack.new().w_full().h(6).rounded(3).bg(t.raised).border(1).border_color(t.border).overflow_hidden()
          .child(ProgressIndicator.new().h_full().w(`${Math.max(2, p.overall)}%`).rounded(3).bg(t.accent))));
  }

  /** Which repository to clone, and where (see openClone). */
  renderClone(t) {
    const c = this.cloning;
    const back = (cx) => { if (!c.busy) { this.cloning = null; this.view = "list"; cx.notify(); } };
    const label = (text) => div().pt(14).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const picked = c.repos?.find((r) => r.permalink === c.picked);
    const row = (r) => {
      const on = r.permalink === c.picked;
      return h_flex().id(`clone-${r.permalink}`).flex_none().px(8).py(6).gap(8).rounded(6).items_center()
        .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (!c.busy) { c.picked = r.permalink; c.error = null; cx.notify(); } })
        .child(div().flex_none().size(12).rounded(6).border(1).border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12.5).truncate().child(r.name))
          .child(div().text_size(11).text_color(t.dim).truncate().child(r.cloneUrl ?? "No clone URL")));
    };
    const dir = (this.cloneDir.value().trim() || this.projectsDir).replace(/\/+$/, "");
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "Clone", c.projectName, [this.button(t, "clone-back", "Back", back)]))
      .child(v_flex().id("clone").flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(6).pb(14)
        .child(div().pt(8).text_size(12).text_color(t.muted)
          .child(`No space works in ${c.projectName}, and there is no checkout of it next to your spaces' folders. Clone one of its repositories and open a space there, or open a space in the default project folder without cloning.`))
        .child(label("Repository"))
        .when(!c.repos && !c.error, (el) => el.child(this.note(t, "Loading repositories…")))
        .child(v_flex().gap(2).children((c.repos ?? []).map(row)))
        .child(label("Clone into"))
        .child(this.input(t, this.cloneDir))
        .child(div().pt(5).text_size(11).text_color(t.dim).child(picked ? `The checkout goes in ${dir}/${picked.permalink}.` : "The checkout goes in a folder named after the repository."))
        .when(Boolean(c.busy && c.progress), (el) => el.child(this.cloneBar(t, c.progress)))
        .when(Boolean(c.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.ansi1).child(c.error)))
        .child(h_flex().pt(16).gap(8)
          .child(this.button(t, "clone-run", c.busy ? "Cloning…" : "Clone and open", (cx) => this.cloneProject(cx), true))
          .child(this.button(t, "clone-open", "Open without cloning", (cx) => this.openWithoutClone(cx)))
          .child(this.button(t, "clone-cancel", "Cancel", back))));
  }

  renderSetup(t) {
    const fallback = defaultBase(this.account());
    let base = fallback;
    try { base = normalizeBase(this.base.value()) ?? fallback; } catch {}
    const label = (text) => div().pt(14).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const hint = (text) => div().pt(5).text_size(11).text_color(t.dim).child(text);
    const input = (state) => this.input(t, state);
    return v_flex().size_full().min_h(0)
      .child(this.header(t, "Settings", "Codebase", this.creds
        ? [this.button(t, "setup-back", "Back", (cx) => { this.view = "list"; cx.notify(); })]
        : []))
      .child(v_flex().id("setup").flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(6).pb(14)
        .child(div().pt(8).text_size(12).text_color(t.muted)
          .child("Your API username and key are under My Profile → API Credentials in Codebase. They are kept in the macOS keychain, never in files."))
        .child(h_flex().pt(6).child(this.link(t, "open-profile", "Open my Codebase profile", (cx) => openLink(cx, `${base}/settings/profile`))))
        .child(label("API username"))
        .child(input(this.user))
        .child(label("API key"))
        .child(input(this.key))
        .when(Boolean(this.creds), (el) => el.child(hint("Leave empty to keep the saved key.")))
        .child(label("Codebase URL"))
        .child(input(this.base))
        .child(hint(`For ticket links. Empty: ${fallback}. Set your own domain if you have one.`))
        .child(label("Default project folder"))
        .child(input(this.projectsDirInput))
        .child(hint(`Where projects are cloned, and where checkouts are looked for. Empty: ${PROJECTS_DIR}.`))
        .when(Boolean(this.setupError), (el) => el.child(div().pt(10).text_size(12).text_color(t.ansi1).child(this.setupError)))
        .child(h_flex().pt(16).gap(8)
          .child(this.button(t, "save", this.saving ? "Saving…" : "Save", (cx) => this.save(cx), true))
          .when(Boolean(this.creds), (el) => el.child(this.button(t, "forget", "Forget credentials", (cx) => this.forget(cx))))));
  }
}
