// Notifications about new notes by others on your tickets.
import { check, settle, makeCx } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

const { default: Tickets } = await import("../mods/codebasehq/main.js");
const cx = makeCx();
const list = new Tickets();
list.init(undefined, cx);
await settle(); list.watch(cx); await settle(6);

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
