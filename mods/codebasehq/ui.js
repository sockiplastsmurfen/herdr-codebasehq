import { div, image, svg } from "gpui-kit";
import { notify } from "herdr";

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
export function wantPictures(owner, ids, cx, download, home) {
  if (!owner.people) return;
  owner.picturesAsked ??= new Set();
  const list = [...new Set(ids)].filter((id) => id != null && !owner.picturesAsked.has(id) && owner.people.avatars.has(id));
  if (!list.length) return;
  for (const id of list) owner.picturesAsked.add(id);
  cx.spawn(async (cx) => {
    try {
      const got = await download(home, list.map((id) => ({ id, url: owner.people.avatars.get(id) })));
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
export function announceChange(setShared, from, project, id) {
  const ids = [].concat(id);
  setShared(CHANGED, { from, project, id: ids[0], ids, at: Date.now() });
}

/** Whether a change announcement is about this ticket. */
export const changeIsAbout = (c, id) => (c.ids ?? [c.id]).some((x) => String(x) === String(id));

