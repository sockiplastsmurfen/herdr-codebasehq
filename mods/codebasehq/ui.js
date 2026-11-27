import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { notify, setShared, appHome } from "herdr";
import { updateTicket, downloadAvatars } from "./codebase.js";

// Small pieces the list, the board and the ticket view share.

export const errText = (e) => String(e?.message ?? e);

/**
 * Opens a link in the browser; a path ("/projects/…") is on the Codebase site at base.
 * cx.open_url takes http(s) only, so a link in a ticket can't start an app or another handler.
 */
export function openLink(cx, url, base) {
  if (!url) return;
  const full = url.startsWith("/") && base ? base + url : url;
  const refused = () => notify({ title: "Only web links open from tickets", body: full, level: "warning", timeout: 6000 });
  if (!/^https?:\/\/[^\s/?#]+/i.test(full)) return refused();
  try { cx.open_url(full); } catch { refused(); }
}

/** A bare icon button (Copy, Open), with its tooltip. A click on it goes no further. */
export function iconLink(t, id, path, onClick, color, tip) {
  return div().id(id).flex_none().size(22).rounded(5).flex().items_center().justify_center()
    .text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(svg(path).size(13));
}

// The fields a card shows and lets you change: where their choices are in choices(), what the
// API calls the change, and the ticket's own keys for the id, the name and a colour or icon.
export const FIELDS = {
  status:   { list: "statuses",   change: "status_id",   id: "statusId",   name: "status",   colour: "statusColour" },
  priority: { list: "priorities", change: "priority_id", id: "priorityId", name: "priority", colour: "priorityColour" },
  // Codebase calls a ticket's type ticket_type_id in a change (type_id is ignored).
  type:     { list: "types",      change: "ticket_type_id", id: "typeId",  name: "type",     icon: "typeIcon" },
  category: { list: "categories", change: "category_id", id: "categoryId", name: "category" },
  assignee: { list: "users",      change: "assignee_id", id: "assigneeId", name: "assignee" },
  milestone: { list: "milestones", change: "milestone_id", id: "milestoneId", name: "milestone" },
};

export const TITLES = { status: "Status", priority: "Priority", type: "Type", category: "Category", assignee: "Assigned to", milestone: "Milestone" };

/**
 * Shows a picked value on a ticket at once (k changes); returns the ticket as it was, to put
 * back if Codebase says no.
 */
export function setField(k, kind, option) {
  const f = FIELDS[kind], before = { ...k };
  k[f.id] = option.id ?? null;
  k[f.name] = option.id == null ? null : kind === "assignee" ? option.username ?? option.name : option.name;
  if (f.colour) k[f.colour] = option.colour ?? null;
  // The type shows as its icon only: without this the card would look unchanged.
  if (f.icon) k[f.icon] = option.icon ?? null;
  if (kind === "status") k.closed = Boolean(option.closed);
  return before;
}

/**
 * Changes one field of a ticket: shows it at once (setField), saves it in Codebase as a note
 * with the change and tells the other copies (from: this copy's copyId); puts it back with an
 * error toast if Codebase says no. busy (a Set) holds key while it saves. after(ok, cx) runs
 * when it is done, either way. Returns false when there is nothing to do (the same value, or
 * still saving).
 */
export function saveField(cx, { creds, from, project, k, kind, option, busy, key = k.id, after }) {
  const f = FIELDS[kind];
  if ((k[f.id] ?? null) === (option.id ?? null) || busy.has(key)) return false;
  const before = setField(k, kind, option);
  k.updated = Date.now();
  busy.add(key);
  cx.spawn(async (cx) => {
    let ok = true;
    try {
      await updateTicket(creds, project, k.id, { [f.change]: option.id ?? "" });
      announceChange(from, project, k.id);
    } catch (e) {
      ok = false;
      Object.assign(k, before);
      notify({ title: `Could not change #${k.id}`, body: errText(e), level: "error", timeout: 10000 });
    }
    busy.delete(key);
    after?.(ok, cx);
    cx.notify();
  });
  return true;
}

/**
 * The values a field can be set to (a project's choices(), or { loading } / { error }), to
 * pick from: picked is highlighted, now (the ticket's own, when another is picked) says so, and
 * statuses that close a ticket say "closes". pick(option, cx). The caller frames it.
 */
export function optionsMenu(t, { id, kind, meta, picked, now = picked, person, pick }) {
  const box = v_flex().gap(1).child(div().px(6).pt(2).pb(2).text_size(11).text_color(t.dim).child(TITLES[kind]));
  if (!meta || meta.loading || meta.error) {
    return box.child(div().p(8).text_size(12).text_color(meta?.error ? t.ansi1 : t.dim).child(meta?.error ?? "Loading…"));
  }
  const list = meta[FIELDS[kind].list] ?? [];
  // A scroll area needs a definite height (a max height alone doesn't scroll): the rows', at most 220.
  return box.child(v_flex().id(`${id}-options`).h(Math.min(220, list.length * 26)).overflow_y_scrollbar().children(list.map((o) =>
    h_flex().id(`${id}-${o.id ?? "none"}`).flex_none().h(26).px(6).gap(8).rounded(5).items_center().text_size(12).cursor_pointer()
      .when((o.id ?? null) === picked, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => pick(o, cx))
      .child(h_flex().w(18).flex_none().justify_center().child(fieldMark(t, kind, o, 12, person)))
      .child(div().flex_1().min_w(0).truncate().text_color(o.id == null || o.closed ? t.muted : t.foreground).child(o.name))
      .when((o.id ?? null) === now && now !== picked, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("now")))
      .when(Boolean(o.closed), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("closes"))))));
}

/** A note in a pane (Loading…, an error, nothing to show). */
export const paneNote = (t, text, color) => div().p(16).text_size(12.5).text_color(color ?? t.dim).child(text);

/** A framed text button; strong is the accent one. */
export function textButton(t, id, label, onClick, strong = false, height = 24) {
  return div().id(id).flex_none().px(10).h(height).rounded(6).flex().items_center().text_size(12)
    .border(1).border_color(strong ? t.accent : t.border).bg(t.surface)
    .text_color(strong ? t.accent : t.foreground)
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
}

/** A small text link (Settings…, Any, Reset); a click on it goes no further. */
export function textLink(t, id, label, onClick) {
  return div().id(id).flex_none().px(6).h(22).rounded(5).flex().items_center().text_size(12).text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
}

/**
 * What a field's value looks like, on a card and in its menu: a status dot, a priority flag,
 * the type's icon, a category tag, a milestone, or the person (person(o, size) draws someone).
 */
export function fieldMark(t, kind, o, size, person) {
  if (kind === "status") return div().size(7).rounded(4).flex_none().bg(colourOf(t, o?.colour));
  if (kind === "priority") return svg("mods/codebasehq/icons/flag.svg").size(size).flex_none().text_color(colourOf(t, o?.colour));
  if (kind === "type") return svg(typeIcon(o?.icon)).size(size).flex_none().text_color(t.muted);
  if (kind === "category") return svg("mods/codebasehq/icons/tag.svg").size(size - 1).flex_none().text_color(t.dim);
  if (kind === "milestone") return svg("mods/codebasehq/icons/milestone.svg").size(size).flex_none().text_color(o?.id == null ? t.dim : t.muted);
  if (o?.id == null) return svg("mods/codebasehq/user.svg").size(size).flex_none().text_color(t.dim);
  return person(o, size + 5);
}

// Codebase's type icon names -> ours.
const TYPE_ICONS = { bug: "bug", hat: "sparkles", construction: "hammer", task: "task", lifebuoy: "lifebuoy", broom: "broom", fire: "fire" };
export const typeIcon = (name) => `mods/codebasehq/icons/${TYPE_ICONS[name] ?? "type"}.svg`;

/** "Jane Ann Doe" -> "JD"; "janedoe" -> "JA" */
export function initials(name) {
  const words = (name ?? "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Codebase's colour names -> theme colours, so they work light and dark. */
export function colourOf(t, c) {
  return ({ grey: t.dim, gray: t.dim, black: t.muted, blue: t.ansi4, red: t.ansi1, green: t.ansi2,
    orange: t.ansi3, yellow: t.ansi3, pink: t.ansi5, purple: t.ansi5, cyan: t.ansi6 })[c] ?? t.dim;
}

/**
 * A person's colour, the same every time for the same name: one of the theme's six colours
 * (red, green, yellow, blue, magenta, cyan) and their bright variants, so it follows light and
 * dark themes. bg is the colour, fg the initials on it.
 */
export function personColour(t, name) {
  const palette = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.ansi9, t.ansi10, t.ansi11, t.ansi12, t.ansi13, t.ansi14]
    .filter((c) => typeof c === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c));
  if (!palette.length) return { bg: t.selected, fg: t.foreground };
  let h = 0;
  for (const ch of (name ?? "").toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  // The colour solid, the initials in the theme's background: dark on light colours in a
  // dark theme, light on the darker colours a light theme has.
  return { bg: palette[h % palette.length].slice(0, 7), fg: t.background };
}

/**
 * A person's round badge: their Codebase picture when they have one (path from
 * downloadAvatars), else their initials on their colour.
 */
export function personBadge(t, name, size, picture) {
  if (picture) return image(picture).size(size).flex_none().rounded(size / 2);
  const c = personColour(t, name);
  return div().size(size).flex_none().rounded(size / 2).bg(c.bg).flex().items_center().justify_center()
    .text_size(size * 0.45).font_semibold().text_color(c.fg).child(initials(name));
}

/**
 * Keeps people's pictures for a view: owner.people (from accountUsers) says who has one,
 * owner.pictures (Map id -> path | null) what has been downloaded. Asks only for the new ones.
 */
export function wantPictures(owner, ids, cx) {
  if (!owner.people) return;
  owner.picturesAsked ??= new Set();
  const list = [...new Set(ids)].filter((id) => id != null && !owner.picturesAsked.has(id) && owner.people.avatars.has(id));
  if (!list.length) return;
  for (const id of list) owner.picturesAsked.add(id);
  cx.spawn(async (cx) => {
    try {
      const got = await downloadAvatars(appHome(), list.map((id) => ({ id, url: owner.people.avatars.get(id) })));
      for (const [id, path] of got) owner.pictures.set(id, path);
    } catch { /* initials stay */ }
    cx.notify();
  });
}

// Every copy of the mod (the panel, the ticket pane) keeps its own tickets. After a change,
// the one that made it says so in shared("codebasehq.changed"); the others reload.
export const CHANGED = "codebasehq.changed";
let copies = 0;
/** A token for this copy, so it can skip its own announcements. */
export const copyId = () => `copy-${Date.now()}-${++copies}`;
/** Tells the other copies that a ticket (or several: an array of ids) in a project changed. */
export function announceChange(from, project, id) {
  const ids = [].concat(id);
  setShared(CHANGED, { from, project, id: ids[0], ids, at: Date.now() });
}

/** Whether a change announcement is about this ticket. */
export const changeIsAbout = (c, id) => (c.ids ?? [c.id]).some((x) => String(x) === String(id));

