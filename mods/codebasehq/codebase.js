// Codebase HQ: credentials in the macOS keychain, the API v3, and git remotes.
import { exec, home, readTextFile } from "herdr";

const API = "https://api3.codebasehq.com";
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
/** "example/jane-doe" -> "jane-doe" */
export const usernameOf = (creds) => creds?.user?.split("/")[1] ?? null;

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

const PAGE_SIZE = 20;

/**
 * One page (20) of tickets matching a Codebase search (e.g. "assignee:me resolution:open"):
 * most recently updated first, or (order "priority") the most urgent first, so that each page
 * carries on where the last ended. more: whether there may be another page.
 */
export async function ticketPage(creds, project, search, page, order = "updated") {
  const sort = order === "priority" ? "sort:priority order:desc" : "sort:updated_at order:desc";
  const query = encodeURIComponent(`${search} ${sort}`.trim());
  const data = await get(creds, `/${encodeURIComponent(project)}/tickets?query=${query}&page=${page}`);
  if (!Array.isArray(data) || data.length === 0) return { tickets: [], more: false };
  return { tickets: data.map(parseTicket), more: data.length >= PAGE_SIZE };
}

/**
 * What a ticket's fields can be set to in this project, each a list of {id, name, colour?}:
 * statuses (by order, with closed), priorities (by position), types, categories,
 * users (the people on the project, "Unassigned" first) and milestones (the open ones, "None"
 * first; none at all if they can't be read). allMilestones: every milestone, finished ones too
 * (with done), for the filters: closed tickets are often in them.
 */
export async function choices(creds, project) {
  const base = `/${encodeURIComponent(project)}`;
  const [st, pr, ty, ca, us, ms] = await Promise.all([
    get(creds, `${base}/tickets/statuses`),
    get(creds, `${base}/tickets/priorities`),
    get(creds, `${base}/tickets/types`),
    get(creds, `${base}/tickets/categories`),
    get(creds, `${base}/assignments`),
    get(creds, `${base}/milestones`).catch(() => null),
  ]);
  const rows = (list, key) => (list ?? []).map((r) => r[key] ?? r);
  const byName = (a, b) => a.name.localeCompare(b.name, "sv");
  const allMilestones = rows(ms, "ticketing_milestone")
    .map((x) => ({ id: x.id, name: x.name ?? `Milestone ${x.id}`, done: /complete|cancel/i.test(x.status ?? "") }))
    .sort((a, b) => a.done - b.done || byName(a, b));
  return {
    statuses: rows(st, "ticketing_status").sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => ({ id: x.id, name: x.name, colour: x.colour, closed: Boolean(x.treat_as_closed ?? x["treat-as-closed"]) })),
    priorities: rows(pr, "ticketing_priority").sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((x) => ({ id: x.id, name: x.name, colour: x.colour, isDefault: Boolean(x.default), position: x.position ?? null })),
    types: rows(ty, "ticketing_type").map((x) => ({ id: x.id, name: x.name, icon: x.icon ?? null })),
    categories: rows(ca, "ticketing_category").map((x) => ({ id: x.id, name: x.name })).sort(byName),
    users: [{ id: null, name: "Unassigned" }, ...rows(us, "user")
      .map((x) => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.username, username: x.username }))
      .sort(byName)],
    milestones: [{ id: null, name: "None" }, ...allMilestones.filter((x) => !x.done)],
    allMilestones,
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
    milestoneId: t.milestone_id ?? t.milestone?.id ?? null,
    created: Date.parse(t.created_at ?? "") || 0,
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
 * Downloads people's pictures once into <appHome>/data/codebasehq-images/avatars/ (in one go).
 * people: [{ id, url }]. Returns Map id -> path for image() (relative to appHome), or null
 * for no picture (none set, Codebase's silhouette, or it couldn't be fetched; remembered with a
 * ".none" file so it isn't asked again).
 */
export async function downloadAvatars(appHome, people) {
  const out = new Map();
  const list = people.filter((p) => Number.isInteger(p.id) && /^https:\/\//.test(p.url ?? ""))
    .map((p) => ({ ...p, url: pictureUrl(p.url) }));
  if (!list.length) return out;
  const dir = `${appHome}/data/codebasehq-images/avatars`;
  const script = [
    'dir="$1"; none="$2"; shift 2',
    'mkdir -p "$dir"',
    'while [ "$#" -gt 1 ]; do',
    '  id="$1"; url="$2"; shift 2',
    '  if [ -e "$dir/$id.none" ]; then echo "$id"; continue; fi',
    '  found=$(ls "$dir/$id"-*.png "$dir/$id"-*.jpg "$dir/$id"-*.gif "$dir/$id"-*.webp 2>/dev/null | head -n 1)',
    '  if [ -n "$found" ]; then printf "%s\\t%s\\n" "$id" "${found##*/}"; continue; fi',
    // A part file of this run's own: another copy of the mod may fetch the same person at once.
    '  part="$dir/$id.part.$$"',
    '  res=$(curl -sL --max-time 10 -o "$part" -w "%{http_code} %{content_type}" "$url") || res="000"',
    '  code=${res%% *}; type=${res#* }',
    '  case "$type" in *png*) ext=png;; *jpeg*|*jpg*) ext=jpg;; *gif*) ext=gif;; *webp*) ext=webp;; *) ext="";; esac',
    '  sum=$(shasum -a 256 "$part" 2>/dev/null | cut -c1-64)',
    '  if [ "$code" = 200 ] && [ -n "$ext" ] && [ "$sum" != "$none" ]; then',
    // The content's hash in the name: a changed picture is a new path (the app keeps images by path).
    '    file="$id-$(printf %s "$sum" | cut -c1-10).$ext"; mv "$part" "$dir/$file" && printf "%s\\t%s\\n" "$id" "$file"',
    // No picture: a 404, the silhouette, or not a picture. Kept, so it isn't asked again.
    '  elif [ "$code" = 200 ] || [ "$code" = 404 ]; then rm -f "$part"; : > "$dir/$id.none"; echo "$id"',
    // Offline, a timeout, a server error: nothing kept, the next start asks again.
    '  else rm -f "$part"; fi',
    'done',
  ].join("\n");
  const r = await exec("/bin/sh", ["-c", script, "sh", dir, NO_PICTURE, ...list.flatMap((p) => [String(p.id), p.url])], { timeout: 120000 });
  for (const line of (r.stdout ?? "").split("\n")) {
    const [id, file] = line.split("\t");
    if (id) out.set(Number(id), file ? `data/codebasehq-images/avatars/${file}` : null);
  }
  return out;
}

// --- commits -----------------------------------------------------------------
// A commit with [touch:123] in its message becomes a note on ticket 123, but the API gives that
// note only the message: no commit, no repository. So the commits are looked up in the
// project's repositories (the ticket's branches first) and matched to notes by their message.

/** A message as a note shows it: without [touch:…]-style references, line by line, trimmed. */
function plainMessage(text) {
  return (text ?? "").replace(/\r\n?/g, "\n").replace(/\[[a-z]+:[^\]]*\]/gi, "")
    .split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n").replace(/\n{2,}/g, "\n\n").trim();
}

/** [{ permalink, name, defaultBranch }] */
// Answers kept for a while (key -> { at, value: a promise }): the commit lookup asks the same
// repositories, branches and commit pages for every ticket of a project. A failure isn't kept.
const remembered = new Map();
function remember(key, ms, ask) {
  const r = remembered.get(key);
  if (r && Date.now() - r.at < ms) return r.value;
  const value = ask().catch((e) => { remembered.delete(key); throw e; });
  remembered.set(key, { at: Date.now(), value });
  return value;
}
/** Drops the kept answers (another account, or a manual reload). */
export const forgetRemembered = () => remembered.clear();
const MINUTES = 60000;

export function repositories(creds, project) {
  return remember(`${creds.user}|repos|${project}`, 5 * MINUTES, () => repositoriesNow(creds, project));
}

async function repositoriesNow(creds, project) {
  const data = (await get(creds, `/${encodeURIComponent(project)}/repositories`)) ?? [];
  return data.map((r) => r.repository ?? r).filter((r) => (r.scm ?? "git") === "git")
    .map((r) => ({ permalink: r.permalink, name: r.name ?? r.permalink, defaultBranch: r.default_branch ?? "master", cloneUrl: r.clone_url ?? null }));
}

function branches(creds, project, repo) {
  return remember(`${creds.user}|branches|${project}/${repo}`, 5 * MINUTES, async () => {
    const data = (await get(creds, `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/branches`)) ?? [];
    return data.map((b) => (b.branch ?? b).name).filter(Boolean);
  });
}

/** One page (20) of a branch's commits, newest first: [{ ref, short, message, author, at }] */
function commitsPage(creds, project, repo, branch, page) {
  // The first page changes as commits come; the older ones hardly.
  return remember(`${creds.user}|commits|${project}/${repo}/${branch}/${page}`, (page === 1 ? 1 : 10) * MINUTES,
    () => commitsPageNow(creds, project, repo, branch, page));
}

async function commitsPageNow(creds, project, repo, branch, page) {
  const data = await get(creds, `/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}?page=${page}`);
  if (!Array.isArray(data)) return [];
  return data.map((c) => c.commit ?? c).map((c) => ({
    ref: c.ref, short: c.short_ref ?? (c.ref ?? "").slice(0, 10), message: c.message ?? "",
    author: c.author_name ?? null,
    at: Date.parse(c.committed_at ?? c.authored_at ?? "") || 0,
  }));
}

/**
 * Finds the commits behind a ticket's notes: Map noteId -> { ...commit, repo, repoName, branch,
 * title, body } (the message as plainMessage cleans it, its first line and the rest).
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
          const [title, ...rest] = msg.split("\n");
          if (note) found.set(note.id, { ...c, repo: repo.permalink, repoName: repo.name, cloneUrl: repo.cloneUrl, branch, title, body: rest.join("\n").trim() });
        }
        if (commits[commits.length - 1].at < oldest || commits.length < 20) break;
      }
    }
  }
  return found;
}

/** "git@codebasehq.com:example/x/y.git" and "https://example.codebasehq.com/x/y.git" -> "example/x/y" */
function remoteKey(url) {
  return remoteParts(url)?.join("/").toLowerCase() ?? null;
}

/**
 * A local clone of a Codebase repository: looks in the given folders (the spaces' folders) and
 * in the folders next to them for a git checkout whose origin is that repository.
 */
export async function findClone(cloneUrl, folders) {
  const key = remoteKey(cloneUrl);
  return key ? (await findCheckouts(folders, (url) => remoteKey(url) === key, true))[0] ?? null : null;
}

/** A local checkout of any of a project's repositories, looked for as findClone does. */
export async function findProjectCheckout(project, folders) {
  return (await findCheckouts(folders, (url) => parseRemote(url)?.project === project, true))[0] ?? null;
}


/**
 * Clones a repository into <parent>/<name> (a leading ~ is the home folder) and returns that
 * folder. Never asks: git can't prompt here, so ssh runs in batch mode and https doesn't ask
 * for a password; both fail with git's message instead. git writes its progress to `log`,
 * which is read every 250ms (`sleep` waits) and handed to `onProgress` (see cloneProgress).
 */
export async function cloneRepository(cloneUrl, parent, name, { log, sleep, onProgress } = {}) {
  // Both come from the API and end up on git's command line, after "--".
  if (!/^(git@|ssh:\/\/|https:\/\/)\S+$/.test(cloneUrl ?? "")) throw new Error("Codebase gave no clone URL for this repository.");
  if (!/^[\w][\w.-]*$/.test(name ?? "")) throw new Error(`Not a folder name: ${name}`);
  const dir = expandHome(parent);
  if (!dir.startsWith("/")) throw new Error("Give the folder as a full path, or one starting with ~/.");
  const dest = `${dir}/${name}`;
  let done = false;
  const running = exec("/bin/sh", ["-c",
    '[ -e "$2" ] && { printf "%s already exists.\n" "$2" >&2; exit 3; }\n'
    + 'mkdir -p "$(dirname "$3")"\n'
    + 'GIT_TERMINAL_PROMPT=0 git -c core.sshCommand="ssh -o BatchMode=yes" clone --progress -- "$1" "$2" 2>"$3"\n'
    + 'c=$?; cat "$3" >&2; rm -f "$3"; exit $c',
    "sh", cloneUrl, dest, log], { timeout: 600000 }).finally(() => { done = true; });
  while (log && sleep && onProgress && !done) {
    await sleep(250);
    const text = done ? null : await readTextFile(log).catch(() => null);
    if (text) onProgress(cloneProgress(text));
  }
  const r = await running;
  if (r.code !== 0) {
    // git's own lines say why (ssh's, then "fatal:"), not its progress or the boilerplate after.
    const why = (r.stderr ?? "").split(/[\r\n]+/).map((l) => l.trim())
      .filter((l) => l && !PROGRESS_LINE.test(l) && !/^Cloning into/.test(l)).slice(0, 2).join(" ");
    throw new Error(why ? `git clone failed: ${why}` : `git clone failed (exit ${r.code}).`);
  }
  return dest;
}

/** "~/<folder>" -> "<home>/<folder>", without a trailing slash; other paths as they are. */
export function expandHome(path) {
  const dir = (path ?? "").trim().replace(/(.)\/+$/, "$1");
  return dir === "~" || dir.startsWith("~/") ? home() + dir.slice(1) : dir;
}

const PROGRESS_LINE = /^(?:remote:\s*)?([A-Za-z ]+):\s+(\d+)%/;
// Where each of git's steps sits on the whole bar: [start, end] in percent.
const CLONE_STEPS = {
  "Enumerating objects": [0, 2], "Counting objects": [0, 2], "Compressing objects": [2, 8],
  "Receiving objects": [8, 80], "Resolving deltas": [80, 95], "Updating files": [95, 100], "Checking out files": [95, 100],
};

/**
 * git clone --progress output -> { step, percent (of the step), overall (0-100), detail }.
 * git redraws its line with \r, so the last progress line is where it is now.
 */
function cloneProgress(text) {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PROGRESS_LINE.exec(lines[i]);
    if (!m) continue;
    const step = m[1].trim(), percent = Number(m[2]);
    const [from, to] = CLONE_STEPS[step] ?? [0, 0];
    // "Receiving objects:  45% (123/456), 12.30 MiB | 4.50 MiB/s": the size and speed.
    const detail = (/\),\s*(.+)$/.exec(lines[i])?.[1] ?? "").replace(/,?\s*done\.?$/, "") || null;
    return { step, percent, overall: Math.round(from + (to - from) * percent / 100), detail };
  }
  return { step: "Connecting", percent: 0, overall: 0, detail: null };
}

/** The checkouts in the folders, or next to them, whose origin url passes `wanted` (only the first, if first). */
async function findCheckouts(folders, wanted, first) {
  const parents = [...new Set(folders.filter(Boolean).flatMap((f) => [f, f.replace(/\/[^/]+\/?$/, "")]))];
  const found = [];
  for (const dir of parents) {
    // Every checkout in dir and dir itself: "<folder>\t<origin url>" per line.
    const r = await exec("/bin/sh", ["-c",
      'for d in "$1" "$1"/*/; do [ -e "$d/.git" ] && printf "%s\t%s\n" "${d%/}" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; true',
      "sh", dir], { timeout: 15000 }).catch(() => null);
    for (const line of (r?.stdout ?? "").split("\n")) {
      const [folder, url] = line.split("\t");
      if (folder && wanted(url) && !found.includes(folder)) { found.push(folder); if (first) return found; }
    }
  }
  return found;
}

// --- starting work ---------------------------------------------------------------

/**
 * A ticket's branch name, as the team names them: its number and its summary in a few words,
 * "583", "Drupal 11 i november/december" -> "583-drupal-11-i-november-december" (60 at most).
 */
export function branchName(id, summary) {
  const words = (summary ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let name = String(id);
  for (const w of words) { if (`${name}-${w}`.length > 60) break; name += `-${w}`; }
  return name;
}

/** The branch a checkout is on, or null (a detached HEAD, or not a checkout). */
export async function currentBranch(folder) {
  const r = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: folder, timeout: 10000 }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}

/** Whether a status's name says work on the ticket has started ("In Progress", "Pågående"…). */
export const isStartedStatus = (name) => /in progress|ongoing|started|doing|pågår|pågående|påbörja|under arbete/i.test(name ?? "");

/** Whether a branch is a ticket's: "583", "583-…" or "ticket-583", as noteCommits looks for them. */
export const isTicketBranch = (branch, id) => new RegExp(`^(ticket-)?${Number(id)}(-|$)`).test(branch ?? "");

/** Whether a branch name is one git takes, and can't be read as an option. */
export const validBranch = (name) => /^[A-Za-z0-9][\w./-]*$/.test(name ?? "") && !/\.\.|\/\/|\/$|\.lock$|\.$/.test(name);

/**
 * Switches a checkout to a branch: the local one if it is there, else origin's, else a new one
 * from origin's default branch (fetched first; the checked-out branch when origin names none).
 * Changes in the working tree come along, as with git switch. Never asks: ssh in batch mode.
 * Returns { how: "existing" | "remote" | "new", base }.
 */
export async function startBranch(folder, name) {
  if (!validBranch(name)) throw new Error(`Not a branch name: ${name}`);
  const r = await exec("/bin/sh", ["-c", [
    'set -e',
    'cd "$1"',
    'export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes"',
    'git check-ref-format --branch "$2" >/dev/null',
    'git fetch --quiet origin 2>/dev/null || true',
    'if git show-ref --verify --quiet "refs/heads/$2"; then git switch --quiet "$2"; echo existing',
    'elif git show-ref --verify --quiet "refs/remotes/origin/$2"; then git switch --quiet --track "origin/$2"; echo remote',
    'else base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD)',
    '  git switch --quiet --no-track -c "$2" "$base"; echo "new $base"',
    'fi',
  ].join("\n"), "sh", folder, name], { timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim().split("\n").filter(Boolean).pop() || "git could not switch to the branch.");
  const [how, base] = r.stdout.trim().split(" ");
  return { how, base: base ?? null };
}

/**
 * A commit's diff from a local clone; if the clone doesn't have the commit yet, fetches the
 * branch from Codebase first (only adds objects; nothing checked out changes).
 */
export async function commitDiff(folder, ref, branch) {
  // Both come from the API and end up on git's command line: a commit id, and a branch git takes
  // as a plain name (not an option, and not a refspec like "+a:b", which would move a local ref).
  if (!/^[0-9a-f]{7,64}$/i.test(ref ?? "")) throw new Error("Not a commit id.");
  const show = () => exec("git", ["show", "--format=", "--patch", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", ref], { cwd: folder, timeout: 30000 });
  let r = await show();
  if (r.code !== 0 && validBranch(branch)) {
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
 * Downloads an upload (by its id) through the API into file, once; then runs `then` (more shell,
 * with the file as "$2"). The key goes to curl on stdin, in its config: never on a command line.
 */
async function fetchUpload(creds, id, file, then = "", timeout = 60000) {
  if (!/^[0-9a-f-]{20,}$/i.test(id ?? "")) throw new Error("Not a Codebase upload.");
  return exec("/bin/sh", ["-c", [
    'set -e',
    'mkdir -p "$(dirname "$2")"',
    'if [ ! -s "$2" ]; then',
    // A part file of this run's own (two downloads of one file can run at once), gone if it fails.
    '  part="$2.part.$$"; trap \'rm -f "$part"\' EXIT',
    '  key=$(security find-generic-password -s "$4" -w)',
    // A quoted value in curl's config: backslashes and quotes escaped.
    '  printf \'user = "%s"\\n\' "$(printf %s "$1:$key" | sed \'s/[\\\\"]/\\\\&/g\')" | curl -sfL -K - -o "$part" "$3"',
    '  mv "$part" "$2"',
    'fi',
    then,
  ].join("\n"), "sh", creds.user, file, `${API}/uploads/${id}`, SERVICE], { timeout });
}

/** An image's name with an extension (".png" when it has none): the dialog and Download go by it. */
export const imageName = (name) => (/\.\w+$/.test(name ?? "") ? name : `${name || "image"}.png`);

/**
 * Downloads an image upload once and reads its size. It goes where the attachment would
 * (attachmentPath), so the note, the dialog and Download share one copy.
 * Returns { path (relative to appHome, for image()), width, height }.
 */
export async function downloadUpload(creds, appHome, id, name) {
  const at = attachmentPath(appHome, id, imageName(name));
  const rel = `${at.rel}/${at.file.split("/").pop()}`;
  const r = await fetchUpload(creds, id, at.file,
    'sips -g pixelWidth -g pixelHeight "$2" 2>/dev/null | awk \'/pixel(Width|Height)/ { print $2 }\'');
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The image could not be downloaded.");
  const [width, height] = r.stdout.trim().split("\n").map(Number);
  return { path: rel, width: width || 0, height: height || 0 };
}

// --- attachments -----------------------------------------------------------------
// Herdr draws pictures and text, not PDFs or Word files. So an attachment is turned into page
// pictures with macOS's own tools: PDFKit draws a PDF's pages; the text system lays a Word, RTF,
// ODT or HTML document out on A4 pages (as a PDF, then drawn the same way); Quick Look makes a
// picture of the first page of anything else (Excel, PowerPoint, Pages, Numbers…).

const PAGE_WIDTH = 1400;  // px a page is drawn at
const MAX_PAGES = 60;     // pages drawn at most; Quick Look shows the rest

// JavaScript for Automation (osascript -l JavaScript): a PDF's pages -> <out>/<n>.png.
// Prints the page count, then "<width> <height>" per page drawn.
const PDF_PAGES = `ObjC.import("PDFKit"); ObjC.import("AppKit");
function run(argv) {
  const [file, out, max, width] = argv;
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(file));
  if (!doc || doc.isNil()) throw new Error("This PDF can't be read.");
  const lines = [String(doc.pageCount)];
  for (let i = 0; i < Math.min(doc.pageCount, Number(max)); i++) {
    const page = doc.pageAtIndex(i), box = page.boundsForBox($.kPDFDisplayBoxMediaBox), k = Number(width) / box.size.width;
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * k, box.size.height * k), $.kPDFDisplayBoxMediaBox);
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out + "/" + (i + 1) + ".png", true);
    lines.push(rep.pixelsWide + " " + rep.pixelsHigh);
  }
  return lines.join("\\n");
}`;

// A document the text system reads (doc, docx, rtf, odt, html) -> a PDF on A4 pages.
const TEXT_TO_PDF = `ObjC.import("AppKit");
function run(argv) {
  const [file, out] = argv;
  const text = $.NSAttributedString.alloc.initWithURLOptionsDocumentAttributesError($.NSURL.fileURLWithPath(file), $({}), null, null);
  if (!text || text.isNil()) throw new Error("This document can't be read.");
  const info = $.NSPrintInfo.sharedPrintInfo.copy, margin = 56, width = 595 - 2 * margin;
  info.paperSize = $.NSMakeSize(595, 842);
  info.topMargin = margin; info.bottomMargin = margin; info.leftMargin = margin; info.rightMargin = margin;
  info.horizontalPagination = $.NSPrintingPaginationModeFit; info.verticalPagination = $.NSPrintingPaginationModeAutomatic;
  info.verticallyCentered = false; info.horizontallyCentered = false;
  const view = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, width, 842));
  view.textStorage.setAttributedString(text);
  view.layoutManager.ensureLayoutForTextContainer(view.textContainer);
  view.setFrame($.NSMakeRect(0, 0, width, Math.max(view.layoutManager.usedRectForTextContainer(view.textContainer).size.height + 20, 100)));
  info.dictionary.setObjectForKey($.NSPrintSaveJob, $.NSPrintJobDisposition);
  info.dictionary.setObjectForKey($.NSURL.fileURLWithPath(out), $.NSPrintJobSavingURL);
  const op = $.NSPrintOperation.printOperationWithViewPrintInfo(view, info);
  op.showsPrintPanel = false; op.showsProgressPanel = false;
  if (!op.runOperation) throw new Error("This document could not be laid out.");
  return out;
}`;

const IMAGE_TYPES = /^(png|jpe?g|gif|webp|bmp|tiff?|heic)$/;
const DOCUMENT_TYPES = /^(docx?|rtf|odt|html?|wordml|webarchive)$/;
const TEXT_TYPES = /^(txt|md|markdown|csv|tsv|log|json|xml|ya?ml|ini|conf|sql|sh|js|ts|php|css|py|rb)$/;
// Files Quick Look makes a picture of (their first page): office files and the like.
const FIRST_PAGE_TYPES = /^(xlsx?|xlsm|pptx?|ppsx?|numbers|key|pages|ods|odp|odg|eps|ai|psd|svg|heic|mov|mp4|m4v)$/;

/** Whether an attachment can be shown in the attachment dialog (by its name); others are downloaded. */
export function canShow(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name ?? "")?.[1] ?? "").toLowerCase();
  return ext === "pdf" || [IMAGE_TYPES, DOCUMENT_TYPES, TEXT_TYPES, FIRST_PAGE_TYPES].some((re) => re.test(ext));
}

/** Where an attachment goes: data/codebasehq-files/<id>/<its name, made safe for a path>. */
function attachmentPath(appHome, id, name) {
  if (!/^[0-9a-f-]{20,}$/i.test(id ?? "")) throw new Error("Not a Codebase upload.");
  // Letters and digits of any script, and a few marks: no slash, so it stays in its folder.
  const safe = (name ?? "").replace(/[^\p{L}\p{N} ._()+,-]/gu, "_").replace(/^[\s.-]+/, "").slice(-120) || "attachment";
  const rel = `data/codebasehq-files/${id}`;
  return { dir: `${appHome}/${rel}`, rel, file: `${appHome}/${rel}/${safe}`, ext: (/\.([a-z0-9]+)$/i.exec(safe)?.[1] ?? "").toLowerCase() };
}

/** Downloads an attachment through the API, once. Returns its path. */
export async function downloadAttachment(creds, appHome, id, name) {
  const { file } = attachmentPath(appHome, id, name);
  const r = await fetchUpload(creds, id, file, "", 300000);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The file could not be downloaded.");
  return file;
}

/**
 * An attachment, ready to show (downloaded first): { kind, pages, count, text }.
 *   "pages": pages [{ path (for image()), width, height }] and count, the document's page count.
 *   "image": one page, the picture itself.
 *   "first": one page, Quick Look's picture of the first page or sheet.
 *   "text": text, the file as text.
 */
export async function attachmentView(creds, appHome, id, name) {
  const at = attachmentPath(appHome, id, name);
  await downloadAttachment(creds, appHome, id, name);
  const size = async (rel) => {
    const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", `${appHome}/${rel}`], { timeout: 15000 });
    const [width, height] = [...(r.stdout ?? "").matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
    return { path: rel, width: width || 0, height: height || 0 };
  };
  if (IMAGE_TYPES.test(at.ext)) return { kind: "image", pages: [await size(`${at.rel}/${at.file.split("/").pop()}`)], count: 1 };
  if (TEXT_TYPES.test(at.ext)) return { kind: "text", text: (await readTextFile(at.file)) ?? "", count: 1 };
  if (at.ext === "pdf" || DOCUMENT_TYPES.test(at.ext)) {
    let pdf = at.file;
    // Laid out and drawn once: an upload never changes. "sizes" is written last, when all is there.
    if (at.ext !== "pdf") {
      pdf = `${at.dir}/layout.pdf`;
      const r = await exec("/bin/sh", ["-c", '[ -s "$3" ] || exec osascript -l JavaScript -e "$1" "$2" "$3"', "sh", TEXT_TO_PDF, at.file, pdf], { timeout: 120000 });
      if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The document could not be laid out.");
    }
    const r = await exec("/bin/sh", ["-c", [
      'set -e',
      'if [ -s "$2/sizes" ]; then cat "$2/sizes"; exit 0; fi',
      'rm -rf "$2" && mkdir -p "$2"',
      'osascript -l JavaScript -e "$1" "$3" "$2" "$4" "$5" > "$2/sizes.part"',
      'mv "$2/sizes.part" "$2/sizes" && cat "$2/sizes"',
    ].join("\n"), "sh", PDF_PAGES, `${at.dir}/pages`, pdf, String(MAX_PAGES), String(PAGE_WIDTH)], { timeout: 300000 });
    if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The pages could not be drawn.");
    const [count, ...sizes] = r.stdout.trim().split("\n");
    return { kind: "pages", count: Number(count) || sizes.length, pages: sizes.map((s, i) => {
      const [width, height] = s.split(" ").map(Number);
      return { path: `${at.rel}/pages/${i + 1}.png`, width, height };
    }) };
  }
  // Anything else: Quick Look's picture of its first page (it names it <file name>.png).
  const r = await exec("/bin/sh", ["-c", 'mkdir -p "$1"; [ -s "$1/$(basename "$2").png" ] || qlmanage -t -s "$3" -o "$1" "$2" >/dev/null 2>&1; test -s "$1/$(basename "$2").png"',
    "sh", `${at.dir}/first`, at.file, String(PAGE_WIDTH)], { timeout: 60000 });
  if (r.code !== 0) return { kind: "none", count: 0 };
  return { kind: "first", count: 1, pages: [await size(`${at.rel}/first/${at.file.split("/").pop()}.png`)] };
}

/**
 * The macOS file chooser, for files to attach (several at once). Resolves with their paths,
 * or [] when cancelled. It waits for the person, so it may take a while.
 */
export async function chooseFiles() {
  const r = await exec("osascript", ["-l", "JavaScript", "-e", `
    const app = Application.currentApplication(); app.includeStandardAdditions = true;
    [].concat(app.chooseFile({ withPrompt: "Attach to the response", multipleSelectionsAllowed: true })).map((f) => f.toString()).join("\\n");`],
    { timeout: 600000 });
  return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

/**
 * Uploads a file to Codebase (POST /uploads, multipart files[]) and returns its token, for
 * postNote's uploadTokens. The file goes up under its own name, made safe for curl's form
 * syntax (a copy in a temporary folder); the key goes to curl on stdin, never on its command line.
 */
export async function uploadFile(creds, path) {
  const name = (path.split("/").pop() ?? "").replace(/[^\p{L}\p{N} ._()+-]/gu, "_").replace(/^[\s.-]+/, "") || "attachment";
  const r = await exec("/bin/sh", ["-c", [
    'set -e',
    'test -f "$2" || { printf "Not a file: %s\\n" "$2" >&2; exit 2; }',
    'dir=$(mktemp -d); trap \'rm -rf "$dir"\' EXIT',
    'cp "$2" "$dir/$3"',
    'key=$(security find-generic-password -s "$5" -w)',
    // A quoted value in curl's config: backslashes and quotes escaped.
    'printf \'user = "%s"\\n\' "$(printf %s "$1:$key" | sed \'s/[\\\\"]/\\\\&/g\')" | curl -sS --fail-with-body -K - -H "Accept: application/json" -F "files[]=@$dir/$3" "$4"',
  ].join("\n"), "sh", creds.user, path, name, `${API}/uploads`, SERVICE], { timeout: 300000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n").pop() || `${name} could not be uploaded.`);
  // JSON, or XML from an older API: the identifier either way.
  const token = /"identifier"\s*:\s*"([^"]+)"/.exec(r.stdout)?.[1] ?? /<identifier>([^<]+)<\/identifier>/.exec(r.stdout)?.[1];
  if (!token) throw new Error(`Codebase did not say where ${name} went.`);
  return token;
}

/** Shows an attachment in macOS Quick Look, outside Herdr: every page and sheet as macOS draws it. */
export async function quickLook(creds, appHome, id, name) {
  const file = await downloadAttachment(creds, appHome, id, name);
  // In the background: the window stays when this returns.
  await exec("/bin/sh", ["-c", 'qlmanage -p "$1" >/dev/null 2>&1 &', "sh", file], { timeout: 10000 });
}

/** Saves an attachment in ~/Downloads, under its name (" (2)" and so on when taken). Returns the path. */
export async function saveToDownloads(creds, appHome, id, name) {
  const file = await downloadAttachment(creds, appHome, id, name);
  const r = await exec("/bin/sh", ["-c", [
    'd="$HOME/Downloads"; n=$(basename "$1")',
    // A picture named without an extension ("image"): the one its format says.
    'case "$n" in *.*) ;; *) f=$(sips -g format "$1" 2>/dev/null | awk \'/format:/ { print $2 }\'); [ -n "$f" ] && n="$n.$f" ;; esac',
    'stem="${n%.*}"; ext="${n##*.}"; [ "$stem" = "$n" ] && ext="" || ext=".$ext"',
    'i=2; while [ -e "$d/$n" ]; do n="$stem ($i)$ext"; i=$((i + 1)); done',
    'mkdir -p "$d" && cp "$1" "$d/$n" && printf %s "$d/$n"',
  ].join("\n"), "sh", file], { timeout: 30000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "The file could not be saved.");
  return r.stdout.trim();
}

export const commitUrl = (base, project, repo, ref) => `${base}/projects/${project}/repositories/${repo}/commit/${ref}`;

/**
 * Creates a ticket: fields { summary, description?, status_id?, priority_id?, ticket_type_id?,
 * category_id?, assignee_id?, milestone_id? }. Returns the new ticket (as the list uses them).
 */
export async function createTicket(creds, project, fields) {
  const ticket = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const data = await request(creds, "POST", `/${encodeURIComponent(project)}/tickets`, { ticket });
  const t = data?.ticket ?? data;
  if (!t?.ticket_id) throw new ApiError("Codebase did not return the new ticket.", 0);
  return parseTicket(t);
}

/** Changes a ticket the way Codebase does it: a note with changes ({status_id} or {priority_id}). */
export async function updateTicket(creds, project, id, changes) {
  await postNote(creds, project, id, "", changes);
}

/** Posts a response on a ticket: a note with text (Markdown) and any changes ({ status_id: 3, … }). */
export async function postNote(creds, project, id, content, changes = {}, uploadTokens = []) {
  const note = Object.keys(changes).length ? { content, changes } : { content };
  // Files uploaded first (uploadFile), attached to the note by their tokens.
  if (uploadTokens.length) note.upload_tokens = uploadTokens;
  await request(creds, "POST", `/${encodeURIComponent(project)}/tickets/${id}/notes`, { ticket_note: note });
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
function parseRemote(url) {
  const parts = remoteParts(url);
  return parts ? { account: parts[0], project: parts[1] } : null;
}

/** [account, project, repo] of a Codebase remote (the account is in the host for https), or null. */
function remoteParts(url) {
  const m = /^(?:\w+:\/\/)?(?:[^@/]+@)?([\w.-]*codebasehq\.com)[:/]+(.+)$/.exec((url ?? "").trim());
  if (!m) return null;
  const parts = m[2].replace(/\.git\/?$/, "").split("/").filter(Boolean);
  const all = m[1] === "codebasehq.com" ? parts : [m[1].split(".")[0], ...parts];
  return all.length >= 3 ? all.slice(0, 3) : null;
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
