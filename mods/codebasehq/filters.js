// The filter bar the list and the board share: resolution, assignee, status, priority, category,
// type and milestone, sent to Codebase as a search ("assignee:me status:New,Accepted resolution:open").
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { FIELDS, TITLES, colourOf } from "./ui.js";

export const FILTER_KINDS = ["assignee", "status", "priority", "category", "type", "milestone"];
/** Nothing picked: everyone's tickets, open and closed. */
export const NO_FILTER = { assignee: [], status: [], priority: [], category: [], type: [], milestone: [], resolution: "all" };

// Where a filter's values are in choices(), when not where a ticket's field takes them from:
// milestones that are done still find their (closed) tickets.
const VALUES = { milestone: "allMilestones" };

const quote = (v) => (/[\s,:"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

// The assignee value for tickets with nobody assigned. Codebase drops it from a list of values
// ("assignee:me,none" is only yours) but ORs it as a term of its own ("assignee:none assignee:me").
export const UNASSIGNED = "none";

/** { assignee: ["me"], resolution: "open" } -> 'assignee:me resolution:open' (resolution: false leaves it out) */
export function searchOf(f, resolution = true) {
  const parts = [];
  for (const k of FILTER_KINDS) {
    let values = f[k] ?? [];
    if (k === "assignee" && values.includes(UNASSIGNED)) {
      parts.push(`assignee:${UNASSIGNED}`);
      values = values.filter((v) => v !== UNASSIGNED);
    }
    if (values.length) parts.push(`${k}:${values.map(quote).join(",")}`);
  }
  if (resolution && f.resolution !== "all") parts.push(`resolution:${f.resolution}`);
  return parts.join(" ");
}

const label = (kind) => (kind === "assignee" ? "Assignee" : TITLES[kind]);

/**
 * The bar and, under it, the values of the open filter. o: {
 *   id: a prefix for element ids, filter, defaults (what Reset goes back to), meta (choices(),
 *   or { loading } / { error }), me (your username), open (the filter whose values show),
 *   setOpen(kind | null, cx), set(filter, cx), loadMeta(cx) (asked when a filter opens) }.
 */
export function filterBar(t, o) {
  const f = o.filter, meta = o.meta;
  const userName = (u) => (u === "me" ? "Me" : u === UNASSIGNED ? "Unassigned" : meta?.users?.find((x) => x.username === u)?.name ?? u);
  const link = (id, text, onClick) => div().id(`${o.id}-${id}`).flex_none().px(6).h(22).rounded(5).flex().items_center()
    .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(text);
  const summary = (kind) => {
    if (kind === "resolution") return { open: "Open", closed: "Closed", all: "Open and closed" }[f.resolution];
    const v = f[kind];
    if (!v.length) return null;
    const first = kind === "assignee" ? userName(v[0]) : v[0];
    return v.length > 1 ? `${first} +${v.length - 1}` : first;
  };
  const button = (kind) => {
    const value = summary(kind), open = o.open === kind;
    const active = kind === "resolution" ? f.resolution !== "all" : Boolean(value);
    return h_flex().id(`${o.id}-${kind}`).flex_none().h(22).px(7).gap(4).rounded(11).items_center().text_size(11.5)
      .border(1).border_color(active ? t.input : t.border).bg(open ? t.selected : active ? t.raised : t.surface)
      .text_color(active ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { o.setOpen(open ? null : kind, cx); if (!open) o.loadMeta?.(cx); })
      .child(kind === "resolution" ? value : value ? `${label(kind)}: ${value}` : label(kind));
  };

  let menu = null;
  const kind = o.open;
  if (kind) {
    let options;
    if (kind === "resolution") {
      options = [["open", "Open"], ["closed", "Closed"], ["all", "Open and closed"]].map(([value, name]) => ({ value, name, on: f.resolution === value }));
    } else if (!meta || meta.loading || meta.error) {
      options = null;
    } else {
      const list = kind === "assignee"
        ? [{ value: "me", name: "Me" }, { value: UNASSIGNED, name: "Unassigned" }, ...(meta.users ?? []).filter((u) => u.username && u.username !== o.me).map((u) => ({ value: u.username, name: u.name }))]
        : (meta[VALUES[kind] ?? FIELDS[kind].list] ?? []).map((x) => ({ value: x.name, name: x.name, colour: x.colour, closed: x.closed, done: x.done }));
      options = list.map((x) => ({ ...x, on: f[kind].includes(x.value) }));
    }
    const pick = (x, cx) => {
      if (kind === "resolution") { o.setOpen(null, cx); o.set({ ...f, resolution: x.value }, cx); return; }
      o.set({ ...f, [kind]: x.on ? f[kind].filter((v) => v !== x.value) : [...f[kind], x.value] }, cx);
    };
    menu = v_flex().mx(10).mb(8).p(4).gap(1).rounded(8).border(1).border_color(t.border).bg(t.raised)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().px(6).pt(2).pb(2).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(kind === "resolution" ? "Resolution" : TITLES[kind]))
        .when(kind !== "resolution" && f[kind]?.length > 0, (el) => el.child(link("clear", "Any", (cx) => o.set({ ...f, [kind]: [] }, cx))))
        .child(link("done", "Done", (cx) => o.setOpen(null, cx))))
      .when(!options, (el) => el.child(div().p(10).text_size(12).text_color(meta?.error ? t.ansi1 : t.dim).child(meta?.error ?? "Loading…")))
      .when(Boolean(options), (el) => el.child(v_flex().id(`${o.id}-options`).max_h(260).overflow_y_scrollbar().children(options.map((x) =>
        h_flex().id(`${o.id}-opt-${kind}-${x.value}`).h(26).px(6).gap(8).rounded(5).items_center().text_size(12)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick(x, cx))
          .child(div().size(14).flex_none().rounded(kind === "resolution" ? 7 : 3).border(1)
            .border_color(x.on ? t.accent : t.input).bg(x.on ? t.accent : t.background)
            .flex().items_center().justify_center()
            .when(x.on, (el) => el.child(svg("mods/codebasehq/check.svg").size(10).text_color(t.accent_foreground))))
          .when(Boolean(x.colour), (el) => el.child(div().size(7).rounded(4).flex_none().bg(colourOf(t, x.colour))))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name))
          .when(Boolean(x.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closed")))
          .when(Boolean(x.done), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("done")))))));
  }

  const isDefault = JSON.stringify(f) === JSON.stringify(o.defaults);
  return v_flex()
    .child(h_flex().flex_wrap().px(10).pb(8).gap(4).items_center()
      .children(["resolution", ...FILTER_KINDS].map(button))
      .when(!isDefault, (el) => el.child(link("reset", "Reset", (cx) => { o.setOpen(null, cx); o.set({ ...o.defaults }, cx); }))))
    .when(Boolean(menu), (el) => el.child(menu));
}
