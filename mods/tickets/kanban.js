// A project's open tickets as a board: one column per open status, in the project's own order.
//   Shown in the board pane (viewer.js, props.view "kanban"), for shared("tickets.board").
//   Click a card's status, priority, type, category or assignee to pick another value, as in the
//   list. Click a card's title to show the ticket in the ticket pane (again: close it), as in the
//   list. Drag a card to another column to change its status (saved as a Codebase note with changes);
//   clicking a card does nothing. GPUI-kit has no drag and drop for our own elements, so it is
//   mouse down / move / up: the card follows the pointer, the column under it lights up.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { notify, setShared } from "herdr";
import { ticketPage, choices, ago, updateTicket, usernameOf } from "./codebase.js";
import { colourOf, FIELDS, TITLES, announceChange, errText, setField, fieldMark } from "./ui.js";
import { filterBar, searchOf, NO_FILTER } from "./filters.js";
import { toggleTicket, shownTicket } from "./panes.js";

const PAGES = 25;        // at most 500 open tickets
const RECENT_CLOSED = 1; // pages (20) of the most recently updated closed tickets for the closed columns
const COLUMN = 264;      // px
const THRESHOLD = 5;     // px the pointer moves before a press becomes a drag

/** Changes one field of a card: on the board at once, then in Codebase; back if that fails. */
function change(v, k, kind, option, cx) {
  const ref = v.ref, f = FIELDS[kind];
  v.cardMenu = null;
  // On the viewer, not the board: a reload while saving replaces the board.
  const saving = (v.saving ??= new Set());
  if ((k[f.id] ?? null) === (option.id ?? null) || saving.has(k.id)) { cx.notify(); return; }
  const before = setField(k, kind, option);
  k.updated = Date.now();
  saving.add(k.id);
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await updateTicket(v.creds, ref.project, k.id, { [f.change]: option.id ?? "" });
      announceChange(setShared, v.me, ref.project, k.id);
    } catch (e) {
      Object.assign(k, before);
      notify({ title: `Could not change #${k.id}`, body: errText(e), level: "error", timeout: 10000 });
    }
    saving.delete(k.id);
    cx.notify();
  });
}

/** Moves a card to a column: its status. */
const move = (v, k, column, cx) => change(v, k, "status", column, cx);

/**
 * { statuses: [{id, name, colour, closed}] (open ones in order, then the closed ones), tickets,
 * open: how many are open }. Every open ticket; of the closed ones (there can be thousands)
 * only the most recently updated, so Completed and the like show what was just done and can
 * take a card.
 */
export async function fetchBoard(creds, project, filter = NO_FILTER) {
  const pages = async (search, max) => {
    const all = [];
    for (let page = 1; page <= max; page++) {
      const r = await ticketPage(creds, project, search, page);
      all.push(...r.tickets);
      if (!r.more) break;
    }
    return all;
  };
  // The board's filter (filters.js) without its resolution: that decides which columns show.
  const search = searchOf(filter, false);
  const wantOpen = filter.resolution !== "closed", wantClosed = filter.resolution !== "open";
  const [meta, open, closed] = await Promise.all([
    choices(creds, project),
    wantOpen ? pages(`${search} resolution:open`.trim(), PAGES) : [],
    wantClosed ? pages(`${search} resolution:closed`.trim(), RECENT_CLOSED) : [],
  ]);
  const shown = (s) => (s.closed ? wantClosed : wantOpen) && (!filter.status.length || filter.status.includes(s.name));
  const statuses = [...meta.statuses.filter((s) => !s.closed), ...meta.statuses.filter((s) => s.closed)].filter(shown);
  const openIds = new Set(open.map((k) => k.id));
  return { statuses, meta, tickets: [...open, ...closed.filter((k) => !openIds.has(k.id))], open: open.length };
}

/**
 * The board. v is the viewer (its board, ref, people's pictures); avatar(name, size, id) draws a
 * person.
 */
export function boardView(v, t, avatar) {
  const b = v.board, ref = v.ref;
  const note = (text, color) => div().p(16).text_size(12.5).text_color(color ?? t.dim).child(text);
  const head = h_flex().flex_none().h(44).px(18).gap(8).items_center().border_b(1).border_color(t.border)
    .child(svg("mods/tickets/icons/kanban.svg").size(15).flex_none().text_color(t.muted))
    .child(div().flex_none().text_size(14).font_semibold().child("Kanban"))
    .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).truncate()
      .child(`${ref.projectName ?? ref.project}${b?.tickets ? ` · ${b.tickets.filter((k) => !k.closed).length} open` : ""}${v.loading ? " · updating…" : ""}`));
  // The same filters as the list, nothing picked unless chosen here (kept per project).
  const bar = div().pt(8).border_b(1).border_color(t.border).child(filterBar(t, {
    id: "board-filter",
    filter: v.boardFilter(ref.project),
    defaults: NO_FILTER,
    meta: b?.meta ?? (b?.error ? { error: b.error } : { loading: true }),
    me: usernameOf(v.creds),
    open: v.boardFilterMenu,
    setOpen: (kind, cx) => { v.boardFilterMenu = kind; cx.notify(); },
    set: (f, cx) => v.setBoardFilter(ref.project, f, cx),
  }));
  const root = v_flex().size_full().min_h(0).child(head).child(bar);
  if (b?.error && !b.tickets) return root.child(note(b.error, t.ansi1));
  if (!b?.tickets) return root.child(note("Loading the board…"));

  // Columns: the open statuses in order, then any status a ticket has that isn't one of them.
  const columns = b.statuses.map((s) => ({ ...s, tickets: [] }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const k of [...b.tickets].sort((x, y) => y.updated - x.updated)) {
    let c = byId.get(k.statusId);
    if (!c) { c = { id: k.statusId, name: k.status ?? "Other", colour: k.statusColour, tickets: [] }; byId.set(k.statusId, c); columns.push(c); }
    c.tickets.push(k);
  }

  const now = Date.now();
  const drag = v.drag; // { k, from, start, offset, at, active, over }
  const meta = b.meta;
  const mark = (kind, o) => fieldMark(t, kind, o, 12, (p, size) => avatar(p.name, size, p.id));
  const valueOf = (k, kind) => {
    const f = FIELDS[kind];
    const name = kind === "assignee" ? (k.assigneeId != null ? v.userName(k.assigneeId, k.assignee) : null) : k[f.name];
    return { id: k[f.id] ?? null, name, colour: f.colour ? k[f.colour] : null, icon: f.icon ? k[f.icon] : null };
  };
  // A field on a card: click for its values (a press here doesn't start a drag).
  const chip = (k, id, kind, interactive, grow) => {
    const o = valueOf(k, kind), open = v.cardMenu?.id === k.id && v.cardMenu.kind === kind;
    const tip = `${TITLES[kind]}: ${o.name ?? (kind === "assignee" ? "Unassigned" : "—")}`;
    const el = h_flex().id(`${id}-${kind}`).gap(4).h(22).rounded(5).items_center()
      .when(grow, (el) => el.flex_1().min_w(0).px(4)).when(!grow, (el) => el.flex_none().justify_center().min_w(22))
      .text_size(11).text_color(open ? t.foreground : t.dim).when(open, (el) => el.bg(t.selected))
      .child(mark(kind, o))
      .when(grow, (el) => el.child(div().min_w(0).truncate().child(o.name ?? "—")));
    if (!interactive) return el;
    return el.cursor_pointer().tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); v.cardMenu = open ? null : { id: k.id, kind }; cx.notify(); });
  };
  const menu = (k, kind) => {
    const f = FIELDS[kind], current = k[f.id] ?? null;
    const options = meta?.[f.list] ?? [];
    return v_flex().gap(1).pt(4).border_t(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().px(4).pb(2).text_size(11).text_color(t.dim).child(TITLES[kind]))
      .children(options.map((o) => h_flex().id(`opt-${k.id}-${kind}-${o.id ?? "none"}`).h(26).px(4).gap(8).rounded(5)
        .items_center().text_size(12).cursor_pointer()
        .when((o.id ?? null) === current, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); change(v, k, kind, o, cx); })
        .child(h_flex().w(18).flex_none().justify_center().child(mark(kind, o)))
        .child(div().flex_1().min_w(0).truncate().text_color(o.id == null || o.closed ? t.muted : t.foreground).child(o.name))
        .when(Boolean(o.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closes")))));
  };
  const viewing = shownTicket();
  const cardBody = (k, id, interactive = false) => {
    const open = interactive && v.cardMenu?.id === k.id ? v.cardMenu.kind : null;
    const uid = `${ref.project}-${k.id}`, shown = interactive && viewing === uid;
    const title = div().id(`${id}-title`).flex_1().min_w(0).text_size(12.5).rounded(4)
      .text_color(shown ? t.accent : t.foreground).child(k.summary);
    return v_flex().id(id).flex_none().p(10).gap(8).rounded(8).border(1)
      .border_color(shown ? t.accent : open ? t.input : t.border).bg(t.raised)
      .child(h_flex().gap(6).items_start()
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.muted).child(`#${k.id}`))
        .child(!interactive ? title : title.cursor_pointer().hover((s) => s.text_color(t.accent))
          .tooltip(shown ? "Close the ticket view" : "Show the whole ticket")
          // A press on the title doesn't start a drag; a click opens or closes the ticket pane.
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            toggleTicket({ project: ref.project, id: k.id, uid, projectName: ref.projectName }, cx);
            cx.notify();
          })))
      .child(h_flex().gap(2).items_center().ml(-4)
        .child(chip(k, id, "status", interactive))
        .child(chip(k, id, "priority", interactive))
        .child(chip(k, id, "type", interactive))
        .child(chip(k, id, "category", interactive, true))
        .child(div().flex_none().px(2).text_size(11).text_color(t.dim).child(v.saving?.has(k.id) ? "Saving…" : ago(k.updated, now)))
        .child(chip(k, id, "assignee", interactive)))
      .when(Boolean(open), (el) => el.child(menu(k, open)));
  };
  const card = (k, c) => cardBody(k, `card-${k.id}`, true)
    .cursor_grab().hover((s) => s.border_color(t.input))
    .when(drag?.active && drag.k === k, (el) => el.opacity(0.35))
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      v.drag = { k, from: c.id, start: e.position, offset: e.local_position ?? { x: 20, y: 16 }, at: null, active: false, over: c.id };
    });
  const target = drag?.active && drag.over != null && drag.over !== drag.from ? drag.over : undefined;
  const column = (c) => v_flex().id(`col-${c.id}`).w(COLUMN).flex_none().h_full().min_h(0).rounded(10)
    .border(1).border_color(target === c.id ? t.accent : t.background).bg(target === c.id ? t.selected : t.background)
    .on_mouse_move(() => { if (v.drag && v.drag.over !== c.id) v.drag.over = c.id; })
    .on_mouse_up("left", (_e, cx) => {
      const d = v.drag;
      v.drag = null;
      if (d?.active && c.id !== d.from) move(v, d.k, c, cx);
      cx.notify();
    })
    .child(h_flex().flex_none().h(36).px(10).gap(7).items_center()
      .child(div().size(8).rounded(4).flex_none().bg(colourOf(t, c.colour)))
      .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().truncate().child(c.name))
      .child(div().id(`col-count-${c.id}`).flex_none().text_size(11.5).text_color(t.dim)
        .when(Boolean(c.closed), (el) => el.tooltip("Closed: only the most recently updated show here"))
        .child(c.closed ? `${c.tickets.length} recent` : String(c.tickets.length))))
    .child(v_flex().id(`col-list-${c.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(8)
      // Where the card lands when it is let go here.
      .when(target === c.id, (el) => el.child(div().flex_none().h(56).rounded(8).border(1).border_color(t.accent).bg(t.selected)
        .flex().items_center().justify_center().text_size(12).text_color(t.muted).child(`Move to ${c.name}`)))
      .children(c.tickets.map((k) => card(k, c))));

  // The pointer is tracked over the whole board; the dragged card follows it.
  return root.id("kanban")
    .on_mouse_move((e, cx) => {
      const d = v.drag;
      if (!d) return;
      if (!d.active && Math.hypot(e.position.x - d.start.x, e.position.y - d.start.y) < THRESHOLD) return;
      d.active = true;
      d.at = e.local_position;
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => { if (v.drag) { v.drag = null; cx.notify(); } })
    .on_hover((hovered, cx) => { if (!hovered && v.drag) { v.drag = null; cx.notify(); } })
    .when(Boolean(b.error), (el) => el.child(div().px(18).py(6).text_size(12).text_color(t.ansi1).child(b.error)))
    .child(h_flex().id("board").flex_1().min_h(0).p(12).gap(10).overflow_x_scrollbar()
      .children(columns.map(column)))
    .when(Boolean(drag?.active && drag.at), (el) => el.child(div().absolute()
      .left(drag.at.x - drag.offset.x).top(drag.at.y - drag.offset.y).w(COLUMN - 16).rounded(8).bg(t.popover).shadow_lg()
      .child(cardBody(drag.k, "card-dragged").bg(t.popover).border_color(t.accent).cursor_grabbing())));
}
