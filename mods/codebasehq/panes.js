// The ticket pane and the board pane.
//   Each is a copy of this mod in a pane of its own (viewer.js): the ticket pane shows
//   shared("codebasehq.open"), the board pane shared("codebasehq.board"), so both can be open. Both
//   the list (main.js) and the board (kanban.js) open and close them, through these.
//   panes() names only the mod, so shared("codebasehq.panes") remembers which pane is which:
//   { [pane id]: "ticket" | "kanban" }, noted when the pane is opened.
import { spaces, panes, run, shared, setShared } from "herdr";

export const OPEN = "codebasehq.open", BOARD = "codebasehq.board", PANES = "codebasehq.panes";

/** The ticket pane ("ticket") or board pane ("kanban") in the shown tab, if there is one. */
export function viewerPane(kind) {
  const tab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
  const known = shared(PANES) ?? {};
  // (A pane opened before panes were noted isn't either: the buttons open new ones.)
  return panes().find((x) => x.mod === "codebasehq" && x.tab === tab && known[x.pane] === kind) ?? null;
}

/**
 * Opens a pane of a kind beside the focused one and notes its id once it is there. The board
 * opens zoomed (the whole work area). A zoomed tab can't be split, so a zoomed pane is
 * unzoomed first.
 */
export function openViewer(kind, ref, cx) {
  const tab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
  const zoomed = panes().find((x) => x.tab === tab && x.zoomed);
  if (zoomed) run("pane.zoom", { pane: zoomed.pane });
  const before = new Set(panes().filter((x) => x.mod === "codebasehq").map((x) => x.pane));
  const { view: _v, ...rest } = ref;
  run("pane.split", { direction: "right", mod: "codebasehq", props: { ...rest, view: kind } });
  let tries = 0;
  const note = (cx) => {
    const added = panes().find((x) => x.mod === "codebasehq" && !before.has(x.pane));
    if (added) {
      const live = new Set(panes().map((x) => x.pane));
      const known = Object.fromEntries(Object.entries(shared(PANES) ?? {}).filter(([id]) => live.has(id)));
      setShared(PANES, { ...known, [added.pane]: kind });
      if (kind === "kanban" && !added.zoomed) run("pane.zoom", { pane: added.pane });
      cx.notify();
    } else if (++tries < 20) cx.timer.after(100, note);
  };
  cx.timer.after(50, note);
}

export function closeViewer(kind, pane) {
  setShared(kind === "kanban" ? BOARD : OPEN, null);
  const { [pane.pane]: _gone, ...rest } = shared(PANES) ?? {};
  setShared(PANES, rest);
  run("pane.close", { pane: pane.pane });
}

/** The ticket the ticket pane shows (its uid), or null when there is no ticket pane. */
export function shownTicket() {
  return viewerPane("ticket") ? shared(OPEN)?.uid ?? null : null;
}

/** Shows a ticket in the ticket pane (opening it beside), or closes the pane if it shows this one. */
export function toggleTicket(k, cx) {
  const pane = viewerPane("ticket");
  if (pane && shared(OPEN)?.uid === k.uid) return closeViewer("ticket", pane);
  const ref = { project: k.project, id: k.id, uid: k.uid, projectName: k.projectName };
  setShared(OPEN, ref);
  if (!pane) openViewer("ticket", ref, cx);
}

/** Shows a ticket in the ticket pane, opening one if needed; never closes it. */
export function showTicket(ref, cx) {
  setShared(OPEN, ref);
  if (!viewerPane("ticket")) openViewer("ticket", ref, cx);
}

/** Shows a project's board in the board pane (opening it beside), or closes it if it shows that board. */
export function toggleKanban(p, cx) {
  const pane = viewerPane("kanban");
  if (pane && shared(BOARD)?.project === p.permalink) return closeViewer("kanban", pane);
  const ref = { view: "kanban", project: p.permalink, projectName: p.name };
  setShared(BOARD, ref);
  if (!pane) openViewer("kanban", ref, cx);
}
