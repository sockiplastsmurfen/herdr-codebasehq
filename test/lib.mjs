// Small helpers for the tests: checks, waiting for the mod's tasks, a cx, and finding,
// reading and clicking things in a rendered view.
import { theme } from "./fake/herdr.mjs";

let failed = 0, passed = 0;

/** One check: prints ok or FAIL (with what was seen), and the file fails if any did. */
export function check(name, ok, seen) {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failed++;
  process.exitCode = 1;
  console.log(`  FAIL  ${name}${seen === undefined ? "" : `\n        seen: ${typeof seen === "string" ? seen : JSON.stringify(seen)}`}`);
}
process.on("exit", () => console.log(`  ${passed} passed${failed ? `, ${failed} failed` : ""}`));
process.on("unhandledRejection", (e) => check("no error in a task", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")));

/** Lets the mod's spawned tasks and timers run. */
export const settle = async (rounds = 3) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 15)); };

/** A cx as the mod gets one: spawn runs the task, timers run soon (once), notify counts. */
export function makeCx() {
  const cx = {
    notified: 0,
    spawn(fn) { Promise.resolve().then(() => fn(cx)); return {}; },
    timer: { every() {}, after(_ms, fn) { setTimeout(() => fn(cx), 5); } },
    notify() { this.notified++; },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    open_url(url) { cx.opened = url; },
    write_to_clipboard(text) { cx.clipboard = text; },
    stop_propagation() {},
  };
  return cx;
}

export const t = theme();

/** The element with this id in a rendered tree, or null. */
export function find(node, id) {
  const e = node?.__el ?? node;
  if (!e || typeof e !== "object") return null;
  if (e.id === id) return e;
  for (const c of e.kids ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

/** The first element with a handler for this event (on_drop, …). */
export function findHandler(node, event) {
  const e = node?.__el ?? node;
  if (!e || typeof e !== "object") return null;
  if (e.on?.[event]) return e;
  for (const c of e.kids ?? []) { const f = findHandler(c, event); if (f) return f; }
  return null;
}

/** All the text in a rendered tree, joined by spaces. */
export function text(node) {
  const e = node?.__el ?? node;
  if (typeof e === "string" || typeof e === "number") return String(e);
  return (e?.kids ?? []).map(text).join(" ");
}

/** Clicks the element with this id (as Herdr: the cx is good during the click only). */
export function click(tree, id, cx, event = "on_click") {
  const e = find(tree, id);
  if (!e?.on?.[event]) throw new Error(`nothing to click: ${id}`);
  return e.on[event]({}, cx);
}
