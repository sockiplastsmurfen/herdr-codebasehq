// Small pieces the list and the ticket view share.

export const TITLES = { status: "Status", priority: "Priority", type: "Type", category: "Category", assignee: "Assigned to" };

// Codebase's type icon names -> ours.
const TYPE_ICONS = { bug: "bug", hat: "sparkles", construction: "hammer", task: "task", lifebuoy: "lifebuoy", broom: "broom", fire: "fire" };
export const typeIcon = (name) => `mods/tickets/icons/${TYPE_ICONS[name] ?? "type"}.svg`;

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
