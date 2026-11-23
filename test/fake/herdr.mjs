// A fake of Herdr's "herdr" module. `world` is what a test sets up and looks at: the spaces,
// panes and focus Herdr would report, shared values, and what the mod asked of Herdr.
import { execFile } from "node:child_process";
import fs from "node:fs";

export const world = {
  props: null,
  spaces: [{ id: "s1", name: "example-shop", active: true, folder: "/Users/demo/example-shop", machine: null, tabs: [{ id: "t1", active: true }] }],
  panes: [{ pane: "p1", tab: "t1", cwd: "/Users/demo/example-shop/web", branch: "master", mod: null }],
  focused: { cwd: "/Users/demo/example-shop", space: "s1", pane: "p1" },
  shared: {},
  notifications: [], runs: [], overlays: [], closed: [], execs: [],
  commands: [],          // resolvers waiting in nextCommand()
  // exec: a test's answer for a command ({ code, stdout, stderr }), or undefined for the default
  // (success, no output). With real: true, commands really run (the macOS and git tests).
  exec: null, real: false,
};

export const props = () => world.props;
export const shared = (k) => world.shared[k] ?? null;
export const setShared = (k, v) => { world.shared[k] = v; return null; };
export const spaces = () => world.spaces;
export const panes = () => world.panes;
export const focused = () => world.focused;
export const theme = () => new Proxy({}, { get: (_o, k) => `#${String(k).length.toString(16).padStart(6, "0")}` });
export const settings = () => ({});
export const layout = () => null;
export const checking = () => false;
export const appHome = () => world.appHome ?? "/tmp/herdr-app-test";
export const home = () => world.home ?? "/Users/demo";
export const notify = (n) => { world.notifications.push(n); return `n${world.notifications.length}`; };
export const run = (command, args) => {
  world.runs.push([command, args]);
  if (command === "space.new") {
    for (const s of world.spaces) s.active = false;
    const id = `s${world.spaces.length + 1}`;
    world.spaces.push({ id, name: args.name ?? args.folder, active: true, folder: args.folder, machine: null, tabs: [] });
    world.focused = { cwd: args.folder, space: id, pane: null };
  }
  return null;
};
export const openOverlay = (spec) => { world.overlays.push(spec); return `ov${world.overlays.length}`; };
export const closeOverlay = (id) => { world.closed.push(id); return null; };
export const nextCommand = () => new Promise((resolve) => world.commands.push(resolve));
/** Sends a command to the mod copy waiting in nextCommand() (as "<mod>.<command>" would). */
export const sendCommand = (c) => world.commands.shift()?.(c);

export function exec(cmd, args = [], options = {}) {
  world.execs.push({ cmd, args, options });
  if (world.real) {
    return new Promise((resolve) => execFile(cmd, args, { cwd: options.cwd, timeout: options.timeout ?? 30000, maxBuffer: 1 << 24 },
      (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
  }
  return Promise.resolve(world.exec?.(cmd, args, options) ?? { code: 0, stdout: "", stderr: "" });
}
export async function readTextFile(path) { try { return fs.readFileSync(path, "utf8"); } catch { return null; } }
