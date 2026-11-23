// Mock data for the tests (and the screenshots): an invented shop, invented people, invented
// tickets. Answers every call that would reach Codebase, the keychain or git. Nothing here is real.
// What the mod saves (changes, notes, new tickets) is kept in world.saved for the tests to see.
import { world } from "./herdr.mjs";
world.saved = [];
// For the tests: tickets "changed elsewhere" (id -> updated), the projects pages were asked for,
// and how many projects' values were being asked for at once (the most at a time).
world.touched = {};
world.asked = [];
world.choices = { now: 0, most: 0, calls: 0 };
const now = Date.now();
const min = (m) => now - m * 60000;

const USERS = [
  { id: 1, first_name: "Alex", last_name: "Morgan", username: "alex" },
  { id: 2, first_name: "Sam", last_name: "Lee", username: "sam" },
  { id: 3, first_name: "Robin", last_name: "Park", username: "robin" },
  { id: 4, first_name: "Kim", last_name: "Novak", username: "kim" },
  { id: 5, first_name: "Jo", last_name: "Rivera", username: "jo" },
];
const fullName = (u) => `${u.first_name} ${u.last_name}`;
const byUser = Object.fromEntries(USERS.map((u) => [u.username, u]));

const STATUSES = [
  { id: 11, name: "New", colour: "blue", closed: false },
  { id: 12, name: "Accepted", colour: "yellow", closed: false },
  { id: 13, name: "In Progress", colour: "orange", closed: false },
  { id: 14, name: "Review", colour: "purple", closed: false },
  { id: 15, name: "Completed", colour: "green", closed: true },
  { id: 16, name: "Invalid", colour: "grey", closed: true },
];
const PRIORITIES = [
  { id: 21, name: "Critical", colour: "red", isDefault: false },
  { id: 22, name: "High", colour: "orange", isDefault: false },
  { id: 23, name: "Normal", colour: "blue", isDefault: true },
  { id: 24, name: "Low", colour: "grey", isDefault: false },
];
const TYPES = [
  { id: 31, name: "Bug", icon: "bug" },
  { id: 32, name: "Feature", icon: "hat" },
  { id: 33, name: "Task", icon: "task" },
  { id: 34, name: "Support", icon: "lifebuoy" },
  { id: 35, name: "Chore", icon: "broom" },
];
const CATEGORIES = ["Backend", "Checkout", "Content", "Design", "Infrastructure"].map((name, i) => ({ id: 41 + i, name }));
const MILESTONES = [
  { id: 51, name: "Release 2.4", done: false },
  { id: 52, name: "Release 2.5", done: false },
  { id: 53, name: "Release 2.3", done: true },
];
const find = (list, name) => list.find((x) => x.name === name) ?? null;

// [id, summary, status, priority, type, category, assignee, milestone, minutes ago, reporter]
const ROWS = [
  [118, "Checkout button hides behind the cookie banner on mobile", "In Progress", "High", "Bug", "Checkout", "alex", "Release 2.4", 25, "kim"],
  [122, "Show the stock level on the product page", "New", "Normal", "Feature", "Design", null, null, 40, "jo"],
  [120, "Search ignores product variants", "In Progress", "Critical", "Bug", "Backend", "sam", "Release 2.4", 70, "alex"],
  [121, "Add a gift card field to the cart", "New", "Normal", "Feature", "Checkout", "alex", "Release 2.5", 130, "jo"],
  [119, "Nightly backup takes over an hour", "New", "Normal", "Chore", "Infrastructure", "robin", null, 190, "robin"],
  [117, "Product images load slowly on the category page", "Review", "High", "Bug", "Backend", "alex", "Release 2.4", 300, "sam"],
  [116, "Customer asks how to change the delivery address", "Accepted", "Normal", "Support", "Content", "kim", null, 480, "kim"],
  [115, "Update the returns policy page", "Accepted", "Low", "Task", "Content", "alex", "Release 2.4", 1500, "kim"],
  [113, "Shipping cost rounds to the wrong cent", "Completed", "High", "Bug", "Checkout", "sam", "Release 2.3", 1600, "alex"],
  [114, "Redesign the size guide", "Review", "Normal", "Feature", "Design", "jo", "Release 2.5", 2900, "jo"],
  [112, "Newsletter sign-up confirms twice", "Accepted", "Normal", "Bug", "Backend", "alex", null, 4300, "robin"],
  [111, "Translate the FAQ", "Completed", "Low", "Task", "Content", "kim", "Release 2.3", 5800, "kim"],
  [110, "Duplicate order emails", "Invalid", "Normal", "Bug", "Backend", null, null, 7200, "sam"],
  [109, "Dark mode for the order history", "New", "Low", "Feature", "Design", "alex", "Release 2.5", 8700, "jo"],
  [108, "Upgrade the image CDN", "Completed", "Normal", "Chore", "Infrastructure", "robin", "Release 2.3", 13000, "robin"],
];

const TICKETS = ROWS.map(([id, summary, st, pr, ty, ca, as, ms, ago, rep]) => {
  const s = find(STATUSES, st), p = find(PRIORITIES, pr), t = find(TYPES, ty), c = find(CATEGORIES, ca), m = find(MILESTONES, ms);
  return {
    id, summary,
    status: s.name, statusId: s.id, statusColour: s.colour, closed: s.closed,
    priority: p.name, priorityId: p.id, priorityColour: p.colour,
    type: t.name, typeId: t.id, typeIcon: t.icon,
    category: c.name, categoryId: c.id,
    assignee: as, assigneeId: as ? byUser[as].id : null,
    milestone: m?.name ?? null, milestoneId: m?.id ?? null,
    reporter: rep, reporterId: byUser[rep].id,
    updated: min(ago), created: min(ago + 2880), tags: "",
  };
});

// --- what codebase.js would ask Codebase ------------------------------------------

export async function loadCredentials() { return { user: "example/alex", key: "demo" }; }
export async function saveCredentials() {}
export async function forgetCredentials() {}

/** A folder in /Users/demo/example-shop is the shop's checkout; anything else is no repo. */
export async function repoOf(cwd) {
  if (!cwd?.startsWith("/Users/demo/example-shop")) return null;
  return { root: "/Users/demo/example-shop", remote: { account: "example", project: "example-shop" } };
}

export async function projects() {
  return [{ name: "Example Blog", permalink: "example-blog" }, { name: "Example Shop", permalink: "example-shop" }];
}

export async function choices() {
  world.choices.calls++;
  world.choices.most = Math.max(world.choices.most, ++world.choices.now);
  await new Promise((r) => setTimeout(r, 5));
  world.choices.now--;
  return {
    statuses: STATUSES.map((x) => ({ ...x })),
    priorities: PRIORITIES.map((x) => ({ ...x })),
    types: TYPES.map((x) => ({ ...x })),
    categories: CATEGORIES.map((x) => ({ ...x })),
    users: [{ id: null, name: "Unassigned" }, ...USERS.map((u) => ({ id: u.id, name: fullName(u), username: u.username }))
      .sort((a, b) => a.name.localeCompare(b.name))],
    milestones: [{ id: null, name: "None" }, ...MILESTONES.filter((m) => !m.done).map(({ id, name }) => ({ id, name }))],
    allMilestones: MILESTONES.map((x) => ({ ...x })),
  };
}

/**
 * The search the panel sends ("assignee:me status:New,"In Progress" resolution:open cookie"),
 * applied to the mock tickets as Codebase does: terms of the same key OR (assignee:none
 * assignee:me), different keys AND, id:N is that ticket, other words are free text.
 */
export async function ticketPage(_creds, project, search, page) {
  world.asked.push(project);
  if (project !== "example-shop") return { tickets: [], more: false };
  const terms = {};
  const TERM = /(\w+):((?:"[^"]*"|[^\s,]+)(?:,(?:"[^"]*"|[^\s,]+))*)/g;
  for (const m of search.matchAll(TERM)) {
    terms[m[1]] = (terms[m[1]] ?? []).concat([...m[2].matchAll(/"([^"]*)"|([^,]+)/g)].map((v) => v[1] ?? v[2]));
  }
  const words = search.replace(TERM, " ").toLowerCase().split(/\s+/).filter(Boolean);
  const has = (key, value) => !terms[key] || terms[key].includes(value);
  const list = TICKETS.filter((k) =>
    (!terms.assignee || terms.assignee.some((a) => (a === "none" ? null : a === "me" ? "alex" : a) === k.assignee))
    && has("status", k.status) && has("priority", k.priority) && has("type", k.type)
    && has("category", k.category) && has("milestone", k.milestone)
    && (!terms.id || terms.id.includes(String(k.id)))
    && (!terms.resolution || terms.resolution[0] === (k.closed ? "closed" : "open"))
    && words.every((w) => k.summary.toLowerCase().includes(w)))
    .sort((a, b) => b.updated - a.updated)
    .map(({ reporter, reporterId, created, tags, milestone, milestoneId, ...k }) => ({ ...k, updated: world.touched[k.id] ?? k.updated }));
  const slice = list.slice((page - 1) * 20, page * 20);
  return { tickets: slice, more: list.length > page * 20 };
}

export async function ticketDetail(_creds, _project, id) {
  const k = TICKETS.find((x) => x.id === Number(id));
  if (!k) throw new Error(`Ticket #${id} was not found.`);
  return { ...k };
}

const NOTES = {
  118: [
    { id: 4001, userId: 4, created: min(2900), updates: {}, attachments: [], content:
      "On phones the cookie banner covers the **Pay now** button, so customers can't finish checkout until they close it.\n\n"
      + "1. Open the shop on a phone\n2. Add something to the cart\n3. Go to checkout\n\nThe button is under the banner." },
    { id: 4002, userId: 1, created: min(1500), content: "", attachments: [],
      updates: { status_id: ["New", "Accepted"], assignee_id: ["", "Alex Morgan"] } },
    { id: 4003, userId: 2, created: min(1200), updates: {}, attachments: [], content:
      "@alex the banner and the checkout bar are both fixed to the bottom. We could lift the banner while checkout is open." },
    { id: 4004, userId: 1, created: min(180), updates: {}, attachments: [], content:
      "Lift the cookie banner above the checkout bar [touch:118]\n\nThe banner sits above the sticky checkout bar on small screens." },
    { id: 4005, userId: 1, created: min(25), attachments: [], content: "Fixed on the branch. Moving it to review once the tests pass.",
      updates: { status_id: ["Accepted", "In Progress"] } },
  ],
};

export async function ticketNotes(_creds, _project, id) {
  const k = TICKETS.find((x) => x.id === Number(id));
  return (NOTES[id] ?? [{ id: id * 10, userId: k?.reporterId ?? 1, created: k?.created ?? min(60), updates: {}, attachments: [],
    content: `${k?.summary ?? "A ticket"}.\n\nMock ticket for screenshots.` }]).map((n) => ({ ...n }));
}

export async function noteCommits(_creds, _project, ticketId) {
  const found = new Map();
  if (Number(ticketId) === 118) {
    found.set(4004, {
      ref: "3f9c2a1e7b5d4c8a9e0f1b2c3d4e5f6a7b8c9d0e", short: "3f9c2a1e7b",
      message: "Lift the cookie banner above the checkout bar [touch:118]\n\nThe banner sits above the sticky checkout bar on small screens.",
      author: "Alex Morgan", authorEmail: "alex@example.com", at: min(185),
      repo: "shop", repoName: "shop", cloneUrl: null, branch: "118-cookie-banner",
      title: "Lift the cookie banner above the checkout bar",
      body: "The banner sits above the sticky checkout bar on small screens.",
    });
  }
  return found;
}

export async function accountUsers() {
  const byId = new Map(), byUsername = new Map(), idByName = new Map();
  for (const u of USERS) {
    byId.set(u.id, fullName(u));
    byUsername.set(u.username, fullName(u));
    idByName.set(fullName(u).toLowerCase(), u.id);
  }
  // Mock pictures for some (drawn for the screenshots, no real people); the rest get initials.
  return { byId, byUsername, idByName, avatars: new Map(PICTURED.map((id) => [id, `mock:${id}`])) };
}

const PICTURED = [1, 2, 4, 5];
export async function downloadAvatars(_home, list) {
  return new Map(list.map(({ id }) => [id, `data/codebasehq-demo/avatars/${id}.png`]));
}
export async function updateTicket(_creds, project, id, changes) { world.saved.push({ kind: "update", project, id, changes }); }
export async function postNote(_creds, project, id, content, changes = {}, uploadTokens = []) {
  world.saved.push({ kind: "note", project, id, content, changes, uploadTokens });
}
export async function createTicket(_creds, project, fields) {
  world.saved.push({ kind: "create", project, fields });
  return { ...TICKETS[0], id: 123, summary: fields.summary };
}
export async function findClone() { return null; }
export async function commitDiff() { throw new Error("Mock data: no diff."); }
export async function downloadUpload() { throw new Error("Mock data: no images."); }
