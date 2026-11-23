// Codebase HQ: credentials in the macOS keychain, the API v3, and git remotes.
import { exec } from "herdr";

export const API = "https://api3.codebasehq.com";
const SERVICE = "herdr-codebasehq";

// --- credentials -------------------------------------------------------------

/** { user: "account/username", key } from the keychain, or null when none is saved. */
export async function loadCredentials() {
  const attrs = await exec("security", ["find-generic-password", "-s", SERVICE], { timeout: 10000 });
  if (attrs.code !== 0) return null;
  const user = /"acct"<blob>="([^"]*)"/.exec(attrs.stdout)?.[1];
  const pw = await exec("security", ["find-generic-password", "-s", SERVICE, "-w"], { timeout: 10000 });
  const key = pw.code === 0 ? pw.stdout.trim() : "";
  return user && key ? { user, key } : null;
}

export async function saveCredentials(user, key) {
  // One entry for this service: drop any older one (another username) first.
  for (let i = 0; i < 5; i++) {
    const r = await exec("security", ["delete-generic-password", "-s", SERVICE], { timeout: 10000 });
    if (r.code !== 0) break;
  }
  const r = await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", user, "-l", "Codebase HQ API (Herdr)", "-w", key], { timeout: 10000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "Could not save to the keychain");
}

export async function forgetCredentials() {
  await exec("security", ["delete-generic-password", "-s", SERVICE], { timeout: 10000 });
}

/** "example/jane-doe" -> "example" */
export const accountOf = (creds) => creds?.user?.split("/")[0] ?? null;

// --- API ---------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3);
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function get(creds, path) {
  return request(creds, "GET", path);
}

async function request(creds, method, path, body) {
  const res = await fetch(API + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Basic " + base64(`${creds.user}:${creds.key}`),
    },
  });
  if (res.status === 401 || res.status === 403) throw new ApiError("Codebase did not accept the API username or key.", res.status);
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new ApiError(`Codebase answered ${res.status}${text ? `: ${text}` : "."}`, res.status);
  }
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

const field = (v) => (v && typeof v === "object" ? v.name ?? null : v ?? null);

/** One ticket from the API, as the panel uses it. */
function parseTicket(row) {
  const t = row.ticket ?? row;
  return {
    id: t.ticket_id,
    summary: t.summary ?? "",
    status: field(t.status),
    statusId: t.status_id ?? t.status?.id ?? null,
    statusColour: t.status?.colour ?? null,
    closed: Boolean(t.status?.treat_as_closed ?? t.status?.["treat-as-closed"]),
    priority: field(t.priority),
    priorityId: t.priority_id ?? t.priority?.id ?? null,
    priorityColour: t.priority?.colour ?? null,
    type: field(t.type) ?? t.ticket_type ?? null,
    typeId: t.type_id ?? t.type?.id ?? null,
    typeIcon: t.type?.icon ?? null,
    category: field(t.category),
    categoryId: t.category_id ?? t.category?.id ?? null,
    assignee: t.assignee ?? null,
    assigneeId: t.assignee_id ?? null,
    updated: Date.parse(t.updated_at ?? t.created_at ?? "") || 0,
  };
}

export const PAGE_SIZE = 20;

/**
 * One page (20) of tickets matching a Codebase search (e.g. "assignee:me resolution:open"),
 * most recently updated first. more: whether there may be another page.
 */
export async function ticketPage(creds, project, search, page) {
  const query = encodeURIComponent(`${search} sort:updated_at order:desc`.trim());
  const data = await get(creds, `/${encodeURIComponent(project)}/tickets?query=${query}&page=${page}`);
  if (!Array.isArray(data) || data.length === 0) return { tickets: [], more: false };
  return { tickets: data.map(parseTicket), more: data.length >= PAGE_SIZE };
}

/**
 * What a ticket's fields can be set to in this project, each a list of {id, name, colour?}:
 * statuses (by order, with closed), priorities (by position), types, categories, and
 * users (the people on the project, "Unassigned" first).
 */
export async function choices(creds, project) {
  const base = `/${encodeURIComponent(project)}`;
  const [st, pr, ty, ca, us] = await Promise.all([
    get(creds, `${base}/tickets/statuses`),
    get(creds, `${base}/tickets/priorities`),
    get(creds, `${base}/tickets/types`),
    get(creds, `${base}/tickets/categories`),
    get(creds, `${base}/assignments`),
  ]);
  const rows = (list, key) => (list ?? []).map((r) => r[key] ?? r);
  const byName = (a, b) => a.name.localeCompare(b.name, "sv");
  return {
    statuses: rows(st, "ticketing_status").sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => ({ id: x.id, name: x.name, colour: x.colour, closed: Boolean(x.treat_as_closed ?? x["treat-as-closed"]) })),
    priorities: rows(pr, "ticketing_priority").sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((x) => ({ id: x.id, name: x.name, colour: x.colour })),
    types: rows(ty, "ticketing_type").map((x) => ({ id: x.id, name: x.name, icon: x.icon ?? null })),
    categories: rows(ca, "ticketing_category").map((x) => ({ id: x.id, name: x.name })).sort(byName),
    users: [{ id: null, name: "Unassigned" }, ...rows(us, "user")
      .map((x) => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username, username: x.username }))
      .sort(byName)],
  };
}

/** One ticket, with who reported it, its milestone and when it was made. */
export async function ticketDetail(creds, project, id) {
  const data = await get(creds, `/${encodeURIComponent(project)}/tickets/${id}`);
  if (!data) throw new ApiError(`Ticket #${id} was not found in ${project}.`, 404);
  const t = data.ticket ?? data;
  return {
    ...parseTicket(t),
    reporter: t.reporter ?? null,
    reporterId: t.reporter_id ?? null,
    milestone: t.milestone?.name ?? null,
    created: Date.parse(t.created_at ?? "") || 0,
    tags: t.tags ?? "",
  };
}

/**
 * A ticket's notes, oldest first: { id, content (Markdown), created, userId,
 * updates: { field: [from, to] }, attachments: [{ name, url }] }. The first is usually
 * the description.
 */
export async function ticketNotes(creds, project, id) {
  const data = (await get(creds, `/${encodeURIComponent(project)}/tickets/${id}/notes`)) ?? [];
  return data.map((row) => row.ticket_note ?? row).map((n) => {
    let updates = {};
    try { updates = typeof n.updates === "string" ? JSON.parse(n.updates || "{}") : n.updates ?? {}; } catch { updates = {}; }
    return {
      id: n.id,
      content: n.content ?? "",
      created: Date.parse(n.created_at ?? "") || 0,
      userId: n.user_id ?? null,
      updates: updates && typeof updates === "object" ? updates : {},
      attachments: (n.attachments ?? []).map((a) => ({
        name: a["file-name"] ?? a.file_name ?? "attachment", url: a.url ?? null,
        id: a.identifier ?? uploadId(a.url), type: a["content-type"] ?? a.content_type ?? "",
      })),
    };
  }).sort((a, b) => a.created - b.created);
}

/**
 * Everyone on the account: { byId: id -> "First Last", byUsername: username -> name,
 * idByName: lower-case name -> id, avatars: id -> picture URL }. (The answer also holds other
 * people's API keys: only these fields are kept.)
 */
export async function accountUsers(creds) {
  const data = (await get(creds, "/users")) ?? [];
  const byId = new Map(), byUsername = new Map(), idByName = new Map(), avatars = new Map();
  for (const row of data) {
    const u = row.user ?? row;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || `User ${u.id}`;
    byId.set(u.id, name);
    idByName.set(name.toLowerCase(), u.id);
    if (u.username) byUsername.set(u.username.toLowerCase(), name);
    if (u.gravatar_url) avatars.set(u.id, u.gravatar_url);
  }
  return { byId, byUsername, idByName, avatars };
}

// Codebase's picture for someone who hasn't set one: a grey silhouette. Initials say more.
// (Gravatar pictures are asked for with default=404, so someone without one gets none.)
const NO_PICTURE = "8236ec7cbf20638956735d247397b207bb929c6519be6d163fc60799acb867e1";

/**
 * A picture URL at 64 px: Gravatar's "?size=35&default=mm" becomes "size=64&default=404" (no
 * stand-in picture); Codebase's own ".../avatar/<id>/35" becomes ".../64".
 */
function pictureUrl(url) {
  if (/gravatar\.com\//.test(url)) {
    let u = /[?&]size=\d+/.test(url) ? url.replace(/([?&])size=\d+/, "$1size=64") : `${url}${url.includes("?") ? "&" : "?"}size=64`;
    u = /[?&]default=[^&]*/.test(u) ? u.replace(/([?&])default=[^&]*/, "$1default=404") : `${u}&default=404`;
    return u;
  }
  return url.replace(/\/\d+$/, "/64");
}

/**
 * Downloads people's pictures once into <appHome>/data/tickets-images/avatars/ (in one go).
 * people: [{ id, url }]. Returns Map id -> path for image() (relative to appHome), or null
 * for no picture (none set, Codebase's silhouette, or it couldn't be fetched; remembered with a
 * ".none" file so it isn't asked again).
 */
export async function downloadAvatars(appHome, people) {
  const out = new Map();
  const list = people.filter((p) => Number.isInteger(p.id) && /^https:\/\//.test(p.url ?? ""))
    .map((p) => ({ ...p, url: pictureUrl(p.url) }));
  if (!list.length) return out;
  const dir = `${appHome}/data/tickets-images/avatars`;
  const script = [
    'dir="$1"; none="$2"; shift 2',
    'mkdir -p "$dir"',
    'while [ "$#" -gt 1 ]; do',
    '  id="$1"; url="$2"; shift 2',
    '  if [ -e "$dir/$id.none" ]; then echo "$id"; continue; fi',
    '  found=$(ls "$dir/$id"-*.png "$dir/$id"-*.jpg "$dir/$id"-*.gif "$dir/$id"-*.webp 2>/dev/null | head -n 1)',
    '  if [ -n "$found" ]; then printf "%s\\t%s\\n" "$id" "${found##*/}"; continue; fi',
    '  type=$(curl -sfL --max-time 10 -o "$dir/$id.part" -w "%{content_type}" "$url") || type=""',
    '  case "$type" in *png*) ext=png;; *jpeg*|*jpg*) ext=jpg;; *gif*) ext=gif;; *webp*) ext=webp;; *) ext="";; esac',
    '  sum=$(shasum -a 256 "$dir/$id.part" 2>/dev/null | cut -c1-64)',
    '  if [ -n "$ext" ] && [ "$sum" != "$none" ]; then',
    // The content's hash in the name: a changed picture is a new path (the app keeps images by path).
    '    file="$id-$(printf %s "$sum" | cut -c1-10).$ext"; mv "$dir/$id.part" "$dir/$file"; printf "%s\\t%s\\n" "$id" "$file"',
    '  else rm -f "$dir/$id.part"; : > "$dir/$id.none"; echo "$id"; fi',
    'done',
  ].join("\n");
  const r = await exec("/bin/sh", ["-c", script, "sh", dir, NO_PICTURE, ...list.flatMap((p) => [String(p.id), p.url])], { timeout: 120000 });
  for (const line of (r.stdout ?? "").split("\n")) {
    const [id, file] = line.split("\t");
    if (id) out.set(Number(id), file ? `data/tickets-images/avatars/${file}` : null);
  }
  return out;
}

// --- commits -----------------------------------------------------------------
// A commit with [touch:123] in its message becomes a note on ticket 123, but the API gives that
// note only the message: no commit, no repository. So the commits are looked up in the
// project's repositories (the ticket's branches first) and matched to notes by their message.

/** A message as a note shows it: without [touch:…]-style references, line by line, trimmed. */
export function plainMessage(text) {
  return (text ?? "").replace(/\r\n?/g, "\n").replace(/\[[a-z]+:[^\]]*\]/gi, "")
    .split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n").replace(/\n{2,}/g, "\n\n").trim();
}

/** [{ permalink, name, defaultBranch }] */
export async function repositories(creds, project) {
  const data = (await get(creds, `/${encodeURIComponent(project)}/repositories`)) ?? [];
  return data.map((r) => r.repository ?? r).filter((r) => (r.scm ?? "git") === "git")
    .map((r) => ({ permalink: r.permalink, name: r.name ?? r.permalink, defaultBranch: r.default_branch ?? "master", cloneUrl: r.clone_url ?? null }));
}

export async function branches(creds, project, repo) {
  const data = (await get(creds, `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/branches`)) ?? [];
  return data.map((b) => (b.branch ?? b).name).filter(Boolean);
}

/** One page (20) of a branch's commits, newest first: [{ ref, short, message, author, authorEmail, at }] */
export async function commitsPage(creds, project, repo, branch, page) {
  const data = await get(creds, `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}?page=${page}`);
  if (!Array.isArray(data)) return [];
  return data.map((c) => c.commit ?? c).map((c) => ({
    ref: c.ref, short: c.short_ref ?? (c.ref ?? "").slice(0, 10), message: c.message ?? "",
    author: c.author_name ?? null, authorEmail: c.author_email ?? null,
    at: Date.parse(c.committed_at ?? c.authored_at ?? "") || 0,
  }));
}

/**
 * Finds the commits behind a ticket's notes: Map noteId -> { ...commit, repo, repoName, branch }.
 * Looks in each repository's branches named after the ticket (123, 123-…, ticket-123), else in
 * dev and the default branch, page by page until every note that could be a commit is matched
 * or the commits are older than the notes.
 */
export async function noteCommits(creds, project, ticketId, notes) {
  const wanted = new Map(); // first line -> [note]
  for (const n of notes) {
    if (Object.keys(n.updates ?? {}).length || !n.content.trim()) continue;
    const key = plainMessage(n.content).split("\n")[0];
    if (!key) continue;
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(n);
  }
  const found = new Map();
  if (!wanted.size) return found;
  const oldest = Math.min(...[...wanted.values()].flat().map((n) => n.created)) - 30 * 86400000;
  const named = new RegExp(`^(ticket-)?${ticketId}(-|$)`);
  const left = () => [...wanted.values()].some((list) => list.some((n) => !found.has(n.id)));
  for (const repo of await repositories(creds, project)) {
    if (!left()) break;
    let refs = [];
    try { refs = (await branches(creds, project, repo.permalink)).filter((b) => named.test(b)); } catch { refs = []; }
    if (!refs.length) refs = [...new Set(["dev", repo.defaultBranch])];
    for (const branch of refs) {
      for (let page = 1; page <= 15 && left(); page++) {
        let commits;
        try { commits = await commitsPage(creds, project, repo.permalink, branch, page); } catch { break; }
        if (!commits.length) break;
        for (const c of commits) {
          const msg = plainMessage(c.message);
          const candidates = (wanted.get(msg.split("\n")[0]) ?? []).filter((n) => !found.has(n.id));
          // The same message twice: the note made closest after the commit.
          const note = candidates.sort((a, b) => Math.abs(a.created - c.at) - Math.abs(b.created - c.at))[0];
          if (note) found.set(note.id, { ...c, repo: repo.permalink, repoName: repo.name, cloneUrl: repo.cloneUrl, branch, body: msg.split("\n").slice(1).join("\n").trim() });
        }
        if (commits[commits.length - 1].at < oldest || commits.length < 20) break;
      }
    }
  }
  return found;
}

/** "git@codebasehq.com:example/x/y.git" and "https://example.codebasehq.com/x/y.git" -> "example/x/y" */
export function remoteKey(url) {
  const m = /^(?:\w+:\/\/)?(?:[^@/]+@)?([\w.-]*codebasehq\.com)[:/]+(.+?)(?:\.git)?\/?$/.exec((url ?? "").trim());
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean);
  if (m[1] === "codebasehq.com") return parts.length >= 3 ? parts.slice(0, 3).join("/").toLowerCase() : null;
  return parts.length >= 2 ? [m[1].split(".")[0], ...parts.slice(0, 2)].join("/").toLowerCase() : null;
}

/**
 * A local clone of a Codebase repository: looks in the given folders (the spaces' folders) and
 * in the folders next to them for a git checkout whose origin is that repository.
 */
export async function findClone(cloneUrl, folders) {
  const key = remoteKey(cloneUrl);
  if (!key) return null;
  const parents = [...new Set(folders.filter(Boolean).flatMap((f) => [f, f.replace(/\/[^/]+\/?$/, "")]))];
  for (const dir of parents) {
    // Every checkout in dir and dir itself: "<folder>\t<origin url>" per line.
    const r = await exec("/bin/sh", ["-c",
      'for d in "$1" "$1"/*/; do [ -e "$d/.git" ] && printf "%s\t%s\n" "${d%/}" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; true',
      "sh", dir], { timeout: 15000 }).catch(() => null);
    for (const line of (r?.stdout ?? "").split("\n")) {
      const [folder, url] = line.split("\t");
      if (folder && remoteKey(url) === key) return folder;
    }
  }
  return null;
}

/**
 * A commit's diff from a local clone; if the clone doesn't have the commit yet, fetches the
 * branch from Codebase first (only adds objects; nothing checked out changes).
 */
export async function commitDiff(folder, ref, branch) {
  const show = () => exec("git", ["show", "--format=", "--patch", "--find-renames", "--no-color", "--no-ext-diff", ref], { cwd: folder, timeout: 30000 });
  let r = await show();
  if (r.code !== 0) {
    await exec("git", ["fetch", "--quiet", "origin", branch], { cwd: folder, timeout: 120000 }).catch(() => null);
    r = await show();
  }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "git show failed");
  return r.stdout;
}

// --- uploaded files ------------------------------------------------------------
// Codebase serves a note's images (/upload/<id>/show/original) only to a logged-in browser, but
// the API gives the same file at /uploads/<id>. fetch() here reads text only, so curl downloads
// it, with the key passed on stdin (never on a command line).

/** ".../upload/<id>/show/original" -> "<id>" */
export function uploadId(url) {
  return /\/uploads?\/([0-9a-f-]{20,})/i.exec(url ?? "")?.[1] ?? null;
}

/**
 * Downloads an upload once into <appHome>/data/tickets-images/ and reads its size.
 * Returns { path (relative to appHome, for image()), width, height }.
 */
export async function downloadUpload(creds, appHome, id, name) {
  if (!/^[0-9a-f-]{20,}$/i.test(id ?? "")) throw new Error("Not a Codebase upload.");
  const ext = (/\.(png|jpe?g|gif|webp|svg)$/i.exec(name ?? "")?.[1] ?? "png").toLowerCase();
  const rel = `data/tickets-images/${id}.${ext}`;
  const file = `${appHome}/${rel}`;
  const r = await exec("/bin/sh", ["-c", [
    'set -e',
    'mkdir -p "$(dirname "$2")"',
    'if [ ! -s "$2" ]; then',
    '  key=$(security find-generic-password -s herdr-codebasehq -w)',
    '  printf \'user = "%s:%s"\\n\' "$1" "$key" | curl -sfL -K - -o "$2.part" "$3"',
    '  mv "$2.part" "$2"',
    'fi',
    'sips -g pixelWidth -g pixelHeight "$2" 2>/dev/null | awk \'/pixel(Width|Height)/ { print $2 }\'',
  ].join("\n"), "sh", creds.user, file, `${API}/uploads/${id}`], { timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The image could not be downloaded.");
  const [width, height] = r.stdout.trim().split("\n").map(Number);
  return { path: rel, width: width || 0, height: height || 0 };
}

export const commitUrl = (base, project, repo, ref) => `${base}/projects/${project}/repositories/${repo}/commit/${ref}`;

/** Changes a ticket the way Codebase does it: a note with changes ({status_id} or {priority_id}). */
export async function updateTicket(creds, project, id, changes) {
  await request(creds, "POST", `/${encodeURIComponent(project)}/tickets/${id}/notes`, { ticket_note: { content: "", changes } });
}

/** Active projects: [{ name, permalink }], by name. */
export async function projects(creds) {
  const data = (await get(creds, "/projects")) ?? [];
  return data.map((row) => row.project ?? row)
    .filter((p) => p.permalink && (p.status ?? "active").toLowerCase() === "active")
    .map((p) => ({ name: p.name ?? p.permalink, permalink: p.permalink }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

// Web links (not the API, which stays api3.codebasehq.com): base is "https://example.codebasehq.com"
// or the account's own domain.
export const defaultBase = (account) => `https://${account ?? "<account>"}.codebasehq.com`;

/** "code.example.se/" -> "https://code.example.se"; "" -> null (use the default). */
export function normalizeBase(text) {
  let s = (text ?? "").trim().replace(/\/+$/, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(s)) throw new Error("The Codebase URL looks like https://example.codebasehq.com.");
  return s;
}

export const ticketUrl = (base, project, id) => `${base}/projects/${project}/tickets/${id}`;
export const ticketsUrl = (base, project) => `${base}/projects/${project}/tickets`;

// --- git ---------------------------------------------------------------------

/**
 * The Codebase project a remote points at:
 *   git@codebasehq.com:example/website/website.git
 *   ssh://git@codebasehq.com/example/website/website.git
 *   https://example.codebasehq.com/website/website.git
 */
export function parseRemote(url) {
  const m = /^(?:\w+:\/\/)?(?:[^@/]+@)?([\w.-]*codebasehq\.com)[:/]+(.+)$/.exec((url ?? "").trim());
  if (!m) return null;
  const parts = m[2].replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (m[1] === "codebasehq.com") return parts.length >= 3 ? { account: parts[0], project: parts[1] } : null;
  return parts.length >= 2 ? { account: m[1].split(".")[0], project: parts[0] } : null;
}

/** { root, remote: {account, project} | null } for a folder, or null outside git. */
export async function repoOf(cwd, machine) {
  if (!cwd) return null;
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: machine, timeout: 10000 });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const r = await exec("git", ["remote", "-v"], { cwd: root, on: machine, timeout: 10000 });
  const lines = r.code === 0 ? r.stdout.split("\n") : [];
  // origin first, then any other remote on Codebase.
  lines.sort((a, b) => (b.startsWith("origin\t") ? 1 : 0) - (a.startsWith("origin\t") ? 1 : 0));
  for (const line of lines) {
    const remote = parseRemote(line.split(/\s+/)[1] ?? "");
    if (remote) return { root, remote };
  }
  return { root, remote: null };
}

// --- display -----------------------------------------------------------------

export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo} mo`;
  return `${Math.round(d / 365)} y`;
}
