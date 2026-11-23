// "Start work" on a ticket (the branch icon in the ticket pane, shown when the space has a
// checkout of the ticket's project): a branch named after it in that checkout (branchName: "583-drupal-11-…"), and the ticket set going, In
// Progress and assigned to you if nobody has it, as one note. A form under the header shows the
// branch (to edit), the checkouts to pick from and what will change, before anything happens.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { panes, spaces, notify } from "herdr";
import { repoOf, branchName, validBranch, startBranch, updateTicket, usernameOf, currentBranch, isTicketBranch } from "./codebase.js";
import { errText, setField, announceChange, textButton } from "./ui.js";

// A status that means work has started, by its name.
const IN_PROGRESS = /in progress|ongoing|started|doing|pågår|pågående|påbörja|under arbete/i;

/**
 * Keeps v.checkouts: the shown space's checkouts of the shown ticket's project, from its
 * terminals' folders (the shown tab's first) and its own folder. Start work shows only when
 * there is one. Called often (the ticket pane's 300ms check): asks git only when the space,
 * the project or a terminal's folder changed, and once per folder.
 */
export function watchCheckouts(v, cx) {
  const space = spaces().find((s) => s.active);
  const project = v.ref && v.ref.view !== "kanban" ? v.ref.project : null;
  const shown = space?.tabs?.find((x) => x.active)?.id, tabs = new Set((space?.tabs ?? []).map((x) => x.id));
  const cwds = panes().filter((p) => p.cwd && tabs.has(p.tab)).sort((a, b) => (b.tab === shown) - (a.tab === shown)).map((p) => p.cwd);
  const folders = [...new Set([...cwds, space?.folder].filter(Boolean))];
  // The terminals' branches too: switching branch shows or hides Start work.
  const branches = panes().filter((p) => tabs.has(p.tab)).map((p) => p.branch ?? "").join(",");
  const sig = `${space?.id}|${project}|${folders.join("|")}|${branches}`;
  if (sig === v.checkoutsSig) return;
  v.checkoutsSig = sig;
  // Only this computer's spaces: git runs here.
  if (!project || !space || space.machine) { v.checkouts = []; cx.notify(); return; }
  cx.spawn(async (cx) => {
    const roots = [];
    for (const folder of folders) {
      if (!v.repos.has(folder)) v.repos.set(folder, await repoOf(folder).catch(() => null));
      const repo = v.repos.get(folder);
      if (repo?.remote?.project === project && !roots.includes(repo.root)) roots.push(repo.root);
    }
    const on = new Map();
    for (const root of roots) on.set(root, await currentBranch(root));
    if (v.checkoutsSig !== sig) return;
    v.checkouts = roots;
    v.checkoutBranches = on;
    if (v.start && !roots.includes(v.start.folder)) v.start.folder = roots[0] ?? null;
    cx.notify();
  });
}

/** What starting will change on the ticket: { changes (for the API), lines (for the form), picked (kind -> option) }. */
function plan(v) {
  const k = v.ticket, meta = v.metas.get(v.ref.project);
  const progress = meta?.statuses?.find((s) => !s.closed && IN_PROGRESS.test(s.name));
  const me = meta?.users?.find((u) => u.username && u.username === usernameOf(v.creds));
  const out = { changes: {}, lines: [], picked: {} };
  if (progress && k.statusId !== progress.id) {
    out.changes.status_id = progress.id; out.picked.status = progress;
    out.lines.push(`Status: ${k.status ?? "—"} → ${progress.name}`);
  }
  if (k.assigneeId == null && me) {
    out.changes.assignee_id = me.id; out.picked.assignee = me;
    out.lines.push(`Assigned to: you`);
  }
  return out;
}

/** Opens (or closes) the form for the shown ticket, in the first of the space's checkouts. */
export function toggleStartWork(v, cx) {
  if (v.start?.key === v.key) { if (!v.start.busy) v.start = null; cx.notify(); return; }
  v.start = { key: v.key, folder: v.checkouts?.[0] ?? null, busy: false, error: null };
  v.branchInput.set_value(branchName(v.ref.id, v.ticket?.summary));
  v.loadMeta(v.ref.project, cx);
  cx.notify();
}

/**
 * Whether Start work can show: the shown space has a checkout of the ticket's project, and none
 * of them is on the ticket's branch already.
 */
export function canStartWork(v) {
  if (!v.checkouts?.length || v.checkouts.some((root) => isTicketBranch(v.checkoutBranches?.get(root), v.ref?.id))) return false;
  // Gone once Start is clicked: while it runs, and after, while that checkout stays on the branch.
  const started = v.started?.get(v.key);
  return !started || (!started.busy && v.checkoutBranches?.get(started.folder) !== started.branch);
}

/** Start: checks the form, then does the work in a task of its own (the click's cx is only good during the click). */
function start(v, cx) {
  const s = v.start, ref = v.ref, k = v.ticket;
  const name = v.branchInput.value().trim();
  if (!s || s.busy || !k) return;
  if (!s.folder) { s.error = "Pick a checkout first."; cx.notify(); return; }
  if (!validBranch(name)) { s.error = "Not a branch name git takes."; cx.notify(); return; }
  s.busy = true; s.error = null;
  const started = { folder: s.folder, branch: name, busy: true };
  (v.started ??= new Map()).set(v.key, started);
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const r = await startBranch(s.folder, name);
      started.busy = false;
      // On the branch now; watchCheckouts sees it too once the terminal's branch changes.
      v.checkoutBranches?.set(s.folder, name);
      const p = plan(v);
      if (Object.keys(p.changes).length) {
        await updateTicket(v.creds, ref.project, ref.id, p.changes);
        for (const [kind, option] of Object.entries(p.picked)) setField(k, kind, option);
        announceChange(v.me, ref.project, ref.id);
        v.reload(cx);
      }
      const where = s.folder.split("/").pop();
      notify({ title: `On ${name}`, body: r.how === "new" ? `A new branch from ${r.base}, in ${where}` : `In ${where}`, level: "success", timeout: 6000 });
      if (v.start === s) v.start = null;
    } catch (e) {
      s.error = errText(e);
      // Not on the branch after all (or only the ticket change failed): the icon is back if so.
      started.busy = false;
    }
    s.busy = false;
    cx.notify();
  });
}

/** The form, under the ticket pane's header, while it is open for the shown ticket. */
export function startWorkView(v, t) {
  const s = v.start;
  if (!s || s.key !== v.key) return null;
  const label = (text) => div().w(84).flex_none().text_size(12).text_color(t.dim).child(text);
  const p = plan(v);
  const list = v.checkouts ?? [];
  const folders = !list.length
    ? div().text_size(12).text_color(t.ansi1).child("This space has no checkout of the project.")
    : h_flex().flex_wrap().gap(6).children(list.map((f) => {
      const on = f === s.folder;
      return div().id(`start-in-${f}`).h(24).px(8).rounded(6).flex().items_center().text_size(12).cursor_pointer()
        .border(1).border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface).hover((st) => st.bg(t.hover))
        .tooltip(f).on_click((_e, cx) => { s.folder = f; cx.notify(); }).child(f.split("/").pop());
    }));
  return v_flex().flex_none().px(18).py(12).gap(8).border_b(1).border_color(t.border).bg(t.raised)
    .child(div().text_size(12.5).font_semibold().child("Start work"))
    .child(h_flex().gap(8).items_center().child(label("Branch"))
      .child(div().flex_1().min_w(0).child(Input.new(v.branchInput).h(28).px(8).rounded(6).border(1).border_color(t.input).bg(t.background).text_size(12.5))))
    .child(h_flex().gap(8).items_start().child(label("In")).child(div().flex_1().min_w(0).child(folders)))
    .child(h_flex().gap(8).items_start().child(label("Ticket"))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted)
        .child(p.lines.length ? p.lines.join(" · ") : v.metas.get(v.ref.project)?.statuses ? "Nothing to change" : "Loading…")))
    .when(Boolean(s.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(s.error)))
    .child(h_flex().gap(8).items_center()
      .child(textButton(t, "start-run", s.busy ? "Starting…" : "Start", (cx) => start(v, cx), true, 26))
      .child(textButton(t, "start-cancel", "Cancel", (cx) => { if (!s.busy) v.start = null; cx.notify(); }, false, 26))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate()
        .child("Switches the checkout to the branch; a new one starts from origin's default branch.")));
}
