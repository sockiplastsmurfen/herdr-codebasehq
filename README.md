# Codebase tickets for Herdr

A Herdr mod that lists Codebase HQ tickets (by default: yours, open) for the project you are working in,
in the right-hand panel next to Files and Changes.

- **Project from the git remote.** The focused terminal's repo decides the project
  (`git@codebasehq.com:<account>/<project>/<repo>.git`). The **folder** icon picks another project,
  or **All projects**, for that repo; the choice is remembered per repo. Outside a Codebase
  repo the default is **All projects**: every active project is asked (8 at a time) and the
  answers are merged, newest first, with the project's name on each card. It refreshes by
  itself every 10 minutes instead of every 2.
- **One card per ticket**, most recently updated first: number, summary and one
  row of details: status (name and colour), icons for priority (a flag in its colour) and
  type (Codebase's own icon; hover for the name), category with a tag, and the assignee
  with initials. Age is on the right. The **copy icon** copies `#<id> <title>`, the **arrow icon** shows
  the ticket in the browser. The **reload** icon reloads (it also reloads every 2 minutes).
- **Filter** with the buttons above the list: resolution (Open, Closed, Open and closed),
  Assignee, Status, Priority, Category, Type and Milestone (finished milestones too, marked done). Pick several values in one filter; **Any**
  clears it, **Reset** goes back to the default `assignee:me resolution:open`. The filter is
  sent to Codebase as a search (e.g. `assignee:me status:"In Progress",New resolution:open`)
  and remembered per project. The list loads 60 tickets at a time; **Load more** at the
  bottom gets the next 60 (closed tickets can run into the thousands).
- **Click a ticket's title** to see the whole ticket in a pane beside it: every field and
  every note (who, when, what changed, the text as Markdown, attachments). The fields are
  folded under **Details**; click it to show them. Click status, priority, type, category,
  assignee or milestone there to change it, as on a card in the list. Notes made by commits (`[touch:123]`) show
  as commits: the author, the short commit id, the branch and the message. Click a commit to
  see its diff right there (from a local clone: a checkout of that repository in one of your
  spaces' folders or next to them; a commit the clone lacks is fetched first); the arrow icon
  opens the commit in Codebase. Images in notes show the same way: click to see the image in
  the pane, scaled to fit; the arrow icon opens it in the browser. An image in the text shows
  where it is in the text; attached images the text doesn't show come below it. They are downloaded through the API (`/uploads/<id>`) once and kept in
  `~/.config/herdr-app/data/tickets-images/`. The API doesn't say which commit made a note, so the panel looks
  the message up in the project's repositories: the ticket's own branches (`123`, `123-…`,
  `ticket-123`), else `dev` and the default branch. Clicking
  another title shows that ticket in the same pane; clicking the shown one again closes it.
- **Post a response** at the bottom of the ticket pane: write a note (Markdown) and post it
  with **Post** or ⌘↩. Unsent text stays with its ticket while you look at another one.
- **New ticket** (the **+** icon): a form with subject, description (Markdown), status,
  priority, type, category, assignee and milestone, filled in with the project's defaults (its first open
  status, its default priority). In a project it is for that project; in All projects you pick
  the project first. The new ticket opens in the ticket pane.
- **Kanban** (the board icon, in a project, not All projects) shows the project's open tickets as a board in
  a pane of its own (the list's side panel closes; the Tickets button opens it again), zoomed to the whole work area (opening the ticket pane unzooms it, so the
  two show side by side): a column per status, in the project's order (the closed ones, like Completed,
  last, with only the 20 most recently updated closed tickets), with priority, type,
  category, age and assignee on each card; click one of them to change it, as in the list.
  It has the list's filters, with nothing picked by default (kept per project): resolution picks
  the open or closed columns, status the columns shown.
  Click a card's title to open or close the ticket pane, as in the list.
  Drag a card to another column to change
  its status (saved like a change in Codebase; it moves back if Codebase refuses). Click the board icon again to close the pane. Every icon button names what it does in a tooltip.
- **Change status, priority, type, category or assignee** by clicking it on a card: the project's own values
  open below it (statuses that close the ticket say so). The change is saved as a
  Codebase note with changes, like in the web UI; a closed ticket leaves the list.
- **People** show with their Codebase picture (from Gravatar or Codebase) where they have
  one, else with their initials on a colour of their own. Pictures are downloaded once into
  `~/.config/herdr-app/data/tickets-images/avatars/`.
- **Stays in step**: a change made on the board or in the ticket pane reloads the list, and a
  change made in the list reloads the board (and the ticket, if it is the one shown).
- **Credentials** (API username `account/username` and API key, from My Profile →
  API Credentials in Codebase) are entered in the panel the first time and kept in the
  macOS keychain under the service `herdr-codebasehq`.

The mod calls `https://api3.codebasehq.com` and runs `git` and `security` (macOS).

## Install

```sh
cp -R mods/tickets ~/.config/herdr-app/mods/tickets
herdr-app check ~/.config/herdr-app/mods/tickets
```

Then add the panel to your layout's `panel-body` stack:

```json
{ "id": "tickets", "type": "block", "content": { "mod": "tickets" } }
```

and a button in your tab-bar mod (a clone of `tabs`), next to Files and Changes:

```js
.child(panelButton("tickets", "Tickets", "mods/tickets/ticket.svg"))
```

(plus `"tickets"` in its `enabled` list). Herdr's shipped layouts and mods are
read-only: clone them first (`herdr-app do layout.clone`, `mod.clone`).
