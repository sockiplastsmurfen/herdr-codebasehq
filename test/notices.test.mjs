// Notifications about new notes by others on your tickets.
import { check, settle, makeCx } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

const { default: Tickets } = await import("../mods/codebasehq/main.js");
const cx = makeCx();
const list = new Tickets();
list.init(undefined, cx);
await settle(); list.watch(cx); await settle();

check("you are found among the account's people", list.myId() === 1);
check("a ticket assigned to you is yours", list.isMine({ assignee: "alex", assigneeId: 1 }) && !list.isMine({ assignee: null, assigneeId: null }));
const k = list.entryFor("example-shop").tickets.find((x) => x.id === 118);
await list.noteNotices("example-shop", [k], Date.now() - 1300 * 60000);
const n = world.notifications.at(-1);
check("a note by someone else makes a notification: who and what", n?.title.startsWith("#118") && /^Sam Lee: @alex the banner/.test(n.body), n);
check("… whose click opens the ticket", n?.action?.name === "codebasehq.open:example-shop:118");
const before = world.notifications.length;
await list.noteNotices("example-shop", [k], Date.now() - 30 * 60000);
check("your own notes make none", world.notifications.length === before);

// Before you are known (people not in yet, or another account), no notifications: else your own notes would make some.
list.forgetAccount();
const quiet = world.notifications.length;
await list.noteNotices("example-shop", [k], Date.now() - 1300 * 60000);
check("no notifications until you are known", list.myId() === null && world.notifications.length === quiet);

// The 20-second look: a change made elsewhere is news (announced, list reloaded); one this mod
// made or heard of within the minute isn't.
{
  const fresh = new Tickets(); const cx2 = makeCx();
  fresh.init(undefined, cx2); await settle();
  fresh.notice(cx2); await settle();                       // the first look: what is there
  const announcedBefore = world.shared["codebasehq.changed"]?.at ?? 0;
  world.touched[117] = Date.now();                          // changed elsewhere
  fresh.notice(cx2); await settle();
  const c = world.shared["codebasehq.changed"];
  check("a change made elsewhere is announced to the other copies", c?.at > announcedBefore && c.ids?.includes(117), c);
  world.shared["codebasehq.changed"] = { from: "another-copy", project: "example-shop", id: 112, ids: [112], at: Date.now() };
  fresh.followChanges(cx2); await settle();
  world.touched[112] = Date.now() + 1000;                   // the same change, seen by the look
  const at = world.shared["codebasehq.changed"].at;
  fresh.notice(cx2); await settle();
  check("a change this mod already heard of isn't news", world.shared["codebasehq.changed"].at === at);
}

// All projects asks for the projects' values a few at a time.
{
  const queued = new Tickets(); const cx3 = makeCx();
  queued.init(undefined, cx3); await settle();
  world.choices = { now: 0, most: 0, calls: 0 };
  for (let i = 1; i <= 6; i++) queued.loadChoices(`project-${i}`, cx3);
  await settle();
  check("six projects' values are asked for 3 at a time, all of them", world.choices.most === 3 && world.choices.calls === 6, world.choices);
}
