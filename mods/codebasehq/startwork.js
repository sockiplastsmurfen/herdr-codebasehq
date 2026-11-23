// "Start work" on a ticket (the branch icon in the ticket pane): a branch named after it in a
// local checkout of its project (branchName: "583-drupal-11-…"), and the ticket set going, In
// Progress and assigned to you if nobody has it, as one note. A form under the header shows the
// branch (to edit), the checkouts to pick from and what will change, before anything happens.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { panes, spaces, shared, notify } from "herdr";
import { repoOf, findProjectCheckouts, expandHome, branchName, validBranch, startBranch, updateTicket, usernameOf } from "./codebase.js";
import { errText, setField, announceChange, textButton } from "./ui.js";

// A status that means work has started, by its name.
const IN_PROGRESS = /in progress|ongoing|started|doing|pågår|pågående|påbörja|under arbete/i;

/**
 * The project's local checkouts: those the terminals in the shown tab are in first, then the
 * other terminals', then those in the default project folder (Settings in the panel).
 */
async function checkouts(project) {
  const local = new Set(spaces().filter((s) => !s.machine).flatMap((s) => s.tabs.map((x) => x.id)));
  const shown = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
  const cwds = panes().filter((p) => p.cwd && local.has(p.tab)).sort((a, b) => (b.tab === shown) - (a.tab === shown)).map((p) => p.cwd);
  const found = [];
  for (const cwd of new Set(cwds)) {
    const repo = await repoOf(cwd).catch(() => null);
    if (repo?.remote?.project === project && !found.includes(repo.root)) found.push(repo.root);
  }
  for (const folder of await findProjectCheckouts(project, [expandHome(shared("codebasehq.projectsDir") ?? "~/Sites")]).catch(() => [])) {
    if (!found.includes(folder)) found.push(folder);
  }
  return found;
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

/** Opens (or closes) the form for the shown ticket and looks for its checkouts. */
export function toggleStartWork(v, cx) {
  if (v.start?.key === v.key) { if (!v.start.busy) v.start = null; cx.notify(); return; }
  const ref = v.ref, s = { key: v.key, folders: null, folder: null, busy: false, error: null };
  v.start = s;
  v.branchInput.set_value(branchName(ref.id, v.ticket?.summary));
  v.loadMeta(ref.project, cx);
  cx.notify();
  cx.spawn(async (cx) => {
    try { s.folders = await checkouts(ref.project); s.folder = s.folders[0] ?? null; }
    catch (e) { s.folders = []; s.error = errText(e); }
    cx.notify();
  });
}

async function start(v, cx) {
  const s = v.start, ref = v.ref, k = v.ticket;
  const name = v.branchInput.value().trim();
  if (!s || s.busy || !k) return;
  if (!s.folder) { s.error = "Pick a checkout first."; cx.notify(); return; }
  if (!validBranch(name)) { s.error = "Not a branch name git takes."; cx.notify(); return; }
  s.busy = true; s.error = null;
  cx.notify();
  try {
    const r = await startBranch(s.folder, name);
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
  }
  s.busy = false;
  cx.notify();
}

/** The form, under the ticket pane's header, while it is open for the shown ticket. */
export function startWorkView(v, t) {
  const s = v.start;
  if (!s || s.key !== v.key) return null;
  const label = (text) => div().w(84).flex_none().text_size(12).text_color(t.dim).child(text);
  const p = plan(v);
  const folders = s.folders === null
    ? div().text_size(12).text_color(t.dim).child("Looking for checkouts…")
    : !s.folders.length
    ? div().text_size(12).text_color(t.ansi1).child("No checkout of this project here or in the default project folder. Click the project's name in All projects to clone it.")
    : h_flex().flex_wrap().gap(6).children(s.folders.map((f) => {
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
