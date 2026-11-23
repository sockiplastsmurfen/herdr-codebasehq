// A fake of gpui-kit and gpui-base: every builder method returns its element, which keeps its
// id, its children and its handlers, so a test can render a view and find and click things.
function el(tag) {
  const e = { tag, kids: [], on: {}, id: null };
  const api = new Proxy(e, {
    get(_o, k) {
      if (k === "__el") return e;
      if (k === "child") return (c) => { if (c == null) throw new Error(`null child in ${tag}`); e.kids.push(c); return api; };
      if (k === "children") return (cs) => { for (const c of cs) { if (c == null) throw new Error(`null child in ${tag}`); e.kids.push(c); } return api; };
      if (k === "when") return (c, f) => (c ? f(api) : api);
      if (k === "hover") return (f) => { f(api); return api; };
      if (k === "id") return (x) => { e.id = x; return api; };
      if (typeof k === "string" && k.startsWith("on_")) {
        return (a, b) => {
          const fn = typeof a === "function" ? a : b;
          // As in Herdr: a handler's cx is good during the call only; using it later throws.
          e.on[k] = (ev, cx) => {
            if (!cx) return fn(ev, cx);
            const { proxy, revoke } = Proxy.revocable(cx, {});
            try { return fn(ev, proxy); } finally { revoke(); }
          };
          return api;
        };
      }
      return () => api;
    },
  });
  return api;
}

export const div = () => el("div"), svg = (p) => el(`svg:${p}`), image = (p) => el(`img:${p}`), list = () => el("list");
export const v_flex = () => el("v"), h_flex = () => el("h");

// Text state: the value and the selection (a cursor at the end after set_value), and its handlers.
class State {
  constructor() { this.v = ""; this.sel = { start: 0, end: 0 }; this.handlers = {}; }
  static new() { return new State(); }
  value() { return this.v; }
  set_value(v) { this.v = v; this.sel = { start: v.length, end: v.length }; }
  selected_range() { return { ...this.sel }; }
  set_selected_range(r) { this.sel = { ...r }; }
  /** Replaces the selection, as typing would. */
  replace(text) { this.v = this.v.slice(0, this.sel.start) + text + this.v.slice(this.sel.end); const at = this.sel.start + text.length; this.sel = { start: at, end: at }; }
  on(event, handler) { this.handlers[event] = handler; return true; }
  /** A test types: sets the value and runs the change handler (its cx good during the call, as in Herdr). */
  type(v, cx) {
    this.set_value(v);
    const { proxy, revoke } = Proxy.revocable(cx, {});
    try { this.handlers.change?.({}, proxy); } finally { revoke(); }
  }
  focus() {} set_masked() {} set_auto_grow() {}
}
export const InputState = State, TextareaState = State;
export const Input = { new: () => el("input") }, Textarea = { new: () => el("textarea") };
export const TextView = { markdown: (_id, md) => el("markdown").child(md), html: (_id, h) => el("html").child(h) };
export const Progress = { new: () => el("progress") }, ProgressTrack = { new: () => el("track") }, ProgressIndicator = { new: () => el("indicator") };
export const ScrollHandle = { new: () => ({ scroll_to_item() {} }) };
export class View {}
