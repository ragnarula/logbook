# Decisions

## How to write an entry

Record a decision here when it shapes what the code can do later. Skip anything
you would happily reverse in an afternoon.

Give each entry four parts:

1. **Problem.** What was wrong before the decision.
2. **Decision.** What we chose.
3. **Alternatives.** What else we considered, and why we rejected it.
4. **Invalidated if.** What would have to become true for the decision to be
   wrong. Write this even when it feels unlikely.

Write in the active voice. Use simple, direct language. Do not use metaphors,
idioms, slang or dramatic wording. Keep the language simple enough for someone
reading English as a second language. Include only what a reader needs to
understand the choice.

Add new entries at the end, with the date.

---

## 2026-08-07 — The client owns the data model

**Problem.** Event names and labels are chosen by the user, so a server that
understood them would need changing every time a user invented a category.

**Decision.** The server stores rows, merges them and returns them. It holds no
rules about what an event means. The only meaning in the system is whether a
type is a moment or a span, and the user sets that.

**Alternatives.** Put validation and reporting on the server. Rejected because
every new kind of tracking would then need a code change and a deployment.

**Invalidated if.** We need reports the client cannot calculate, for example
across more data than a phone can hold.

---

## 2026-08-07 — Devices create rows, and the newest change to a row wins

**Problem.** Two phones must both record events with no network and agree
afterwards.

**Decision.** Each device creates rows with its own identifier and stamps them
with its own clock. The server keeps whichever version of a row has the newer
timestamp. A counter on the server orders all changes, so one number tells a
device how far it has caught up.

**Alternatives.** Merge field by field, or use vector clocks. Rejected because
both cost far more code than a household needs. Rejected central locking
because it does not work offline.

**Invalidated if.** Two people routinely edit the same entry at the same time,
or device clocks cannot be trusted.

---

## 2026-08-07 — An event stores its own labels

**Problem.** Merging happens one row at a time. Labels kept in a separate table
could arrive without the event they belong to.

**Decision.** An event stores its label identifiers inside the event row.

**Alternatives.** A join table, which is the normal database design. Rejected
because a row-by-row merge cannot keep two tables consistent.

**Invalidated if.** We move to a database that merges several tables in one
transaction.

---

## 2026-08-07 — Deleting sets a flag

**Problem.** A deletion made offline has to reach other devices. A missing row
carries no information.

**Decision.** Deleting sets a flag on the row. Rows are never removed.

**Alternatives.** Delete rows and send a separate list of deletions. Rejected
as a second mechanism to keep correct.

**Invalidated if.** Deleted rows grow large enough to slow down a device.

---

## 2026-08-07 — The client has no build step and no libraries

**Problem.** The app must work offline, so every file has to be stored on the
device.

**Decision.** Plain HTML, CSS and JavaScript modules, served as written. The
browser loads only files this service serves.

**Alternatives.** A framework and a bundler. Rejected because they add tools to
install and files to cache for a screen of tiles and a timeline.

**Invalidated if.** The client grows past what is comfortable to read as plain
modules.

---

## 2026-08-07 — One tap records an event

**Problem.** People stop tracking when recording takes longer than the thing
they are recording.

**Decision.** Tapping a tile records the event. No form, no question and no
confirmation. The user types only to name something new, and only the first
time. Every other value is set by tapping. Corrections are offered afterwards,
on the bar that appears.

**Alternatives.** Ask for details when recording. Rejected because it fails at
the moment the app is most needed.

**Invalidated if.** A required detail cannot be corrected afterwards.

---

## 2026-08-08 — Answer questions with filters, not a query builder

**Problem.** Users want counts and totals for combinations we cannot predict.

**Decision.** The history page offers filters built from the project's own event
types and labels. The same filters drive the statistics. Selecting a label
turns every total into that label's total.

**Alternatives.** A query builder with fields and operators. Rejected because it
adds a second language to learn for questions the filters already answer.

**Invalidated if.** Users need comparisons the filters cannot express, such as
one period against another.

---

## 2026-08-08 — Production runs on Fly.io, not the homelab

**Problem.** Anything other people depend on becomes production. The owner does
not want production on the homelab.

**Decision.** The service runs on Fly.io. One container, one SQLite file on a
persistent disk. An install script deploys it to any Fly account.

**Alternatives.** Keep it on the homelab behind the existing proxy. Rejected
because it makes home hardware something a household depends on. Rejected
serverless because it would mean rewriting the server and re-proving the merge
rules to save a very small amount of money.

**Invalidated if.** Running costs rise, or we need multiple households on one
deployment, which is the point at which a rewrite would be worth it.

---

## 2026-08-08 — One passcode per deployment, and no user accounts

**Problem.** The service is reachable from the internet, but two parents sharing
one baby should not have to manage accounts.

**Decision.** One passcode protects a deployment. Signing in leaves a long-lived
session on the device. One deployment serves one household. Another household
runs its own copy.

**Alternatives.** User accounts with per-user data. Rejected because it requires
email, password resets and a scoping rule that must be correct in every query,
and it makes us the custodian of other people's records.

**Invalidated if.** We host many households on one deployment.

---

## 2026-08-08 — The offline cache never decides which code runs

**Problem.** The service worker served files from the cache first. A device kept
running a broken release, and the code that would have fixed it was the code
being withheld.

**Decision.** Serve code from the network first and fall back to the cache. Stamp
every module address with the release, so a browser cannot pair a file from one
release with a file from another. The page repairs itself if it fails to start.

**Alternatives.** Cache first for speed. Rejected because a user cannot recover
from it. Rejected relying only on cache headers, because the failure had already
happened once.

**Invalidated if.** Loading from the network becomes too slow to be the default.

---

## 2026-08-08 — Tests drive a real browser

**Problem.** Bugs that made the app unusable passed every server test. An
invisible overlay covered the screen, and a message covered the sign-in button.

**Decision.** Keep server tests for the merge rules, and add browser tests that
drive the real interface. Everything runs in containers, so Docker is the only
requirement, and the app under test uses a database held in memory.

**Alternatives.** Server tests only. Rejected because they cannot tell whether a
person can reach a control.

**Invalidated if.** The browser tests become slow enough that people skip them.

---

## 2026-08-09 — Polling slows down when nothing is happening

**Problem.** The app asked the server for changes every thirty seconds, whether
or not the page was visible. This kept the server awake all day and used the
phone battery for nothing.

**Decision.** The interval doubles up to fifteen minutes while nothing changes.
A hidden page with nothing to send does not ask at all. Anything the user does
syncs at once and returns to the fast interval.

**Alternatives.** Keep a connection open, or send messages from the server.
Rejected because both keep the server running, which is what we were trying to
avoid.

**Invalidated if.** Two people need to see each other's entries within seconds.

---

## 2026-08-09 — A custom domain points at the existing app

**Problem.** The Fly application name was chosen carelessly and appears in the
address. Fly cannot rename an application.

**Decision.** Point a custom domain at the existing application with a CNAME
record. The application keeps its original name, which nobody sees.

**Alternatives.** Create a new application and move the data. Rejected because
it risks the data to change a name that a custom domain hides anyway.

**Invalidated if.** We stop using a custom domain.

---

## 2026-08-09 — The code is public under 0BSD, and takes no contributions

**Problem.** Other people may want to run this, but reviewing changes is a
commitment the owner is not making.

**Decision.** Publish the repository under 0BSD, which sets no conditions, not
even attribution. Turn issues off. Close pull requests automatically with an
explanation.

**Alternatives.** Keep it private. Rejected because it stops anyone else running
it. Rejected a licence requiring attribution, because it adds an obligation for
no benefit.

**Invalidated if.** The owner wants to accept contributions.

---

## 2026-08-10 — An amount is a property of an event, not a kind of event

**Problem.** A bottle feed has both a duration and an amount. A weight reading
has a time and an amount.

**Decision.** An event type may carry a unit, a step size and the amount a tap
records. An event carries an amount. An empty unit means the type has no
amount, so existing types are unaffected.

**Alternatives.** Add a third kind of event beside moment and span. Rejected
because an amount is independent of shape, so it would have forced
span-with-amount and moment-with-amount, and the same again for every property
added later.

**Invalidated if.** An event needs several amounts, for example a volume and a
temperature.

---

## 2026-08-10 — A tap records the amount set on the type

**Problem.** Asking for a number on every tap would end one tap recording.

**Decision.** The event type holds the amount a tap records. The tile shows that
amount. The bar that appears afterwards has plus and minus buttons that adjust
the entry without opening anything.

**Alternatives.** Record the last amount used. Rejected because the same action
would then record different values, and the tile could not say what a tap does.

**Invalidated if.** Amounts vary so much that the setting is wrong more often
than it is right.

---

## 2026-08-11 — The type decides an event's shape, not the row

**Problem.** An event kept its end time when its type changed to a moment. The
timeline then drew a bar as wide as that leftover value.

**Decision.** The timeline and the statistics ask the type whether an event is a
moment or a span. An event of a moment type is always drawn as a mark. Events
whose type has been deleted fall back to their own data.

**Alternatives.** Trust the row. Rejected because it shows durations that no
longer mean anything.

**Invalidated if.** A type is allowed to hold both shapes at once.

---

## 2026-08-11 — Amounts add up only within a unit

**Problem.** Amounts were totalled across every event type, and the unit shown
came from whichever type was read last. Millilitres and kilograms would have
been added together and labelled wrongly.

**Decision.** Each event type and label carries its own unit. When one unit is
in view, the totals and charts are shown. When more than one is in view, only
the breakdown is shown, and each row uses its own unit and its own scale.

**Alternatives.** Convert units, or show one total anyway. Rejected because the
app does not know what a unit means, and a wrong total is worse than no total.

**Invalidated if.** We teach the app about units and let it convert between
them.

---

## 2026-08-15 — A span can be paused, and its pauses live in the event row

**Problem.** A span recorded one unbroken stretch of time. A sleep interrupted
for a feed, or a walk that waits at a crossing, was counted as if it never
stopped, so every total included time that did not happen.

**Decision.** A span can be paused and continued. The stretches it was not
running are stored on the event itself as JSON, the same way an event stores its
label identifiers. A pause is drawn as a gap on the timeline and counted in no
total. Ending a paused span ends it where the pause began, because nothing has
happened since.

**Alternatives.** Two columns holding the total paused time and the current
pause. Rejected because they do not record when the pauses were, so the timeline
would draw one solid bar over time that did not happen, and the app already
refuses to show a number it cannot stand behind. Rejected a separate table of
pauses, because merging happens one row at a time. Rejected pausing by ending
the span and starting another, because it turns one interrupted sleep into two
entries and inflates every count.

**Invalidated if.** A pause has to belong to something other than one event, or
an event collects so many that the row becomes large.

---

## 2026-08-15 — A tile reports the last amount, not the next one

**Problem.** A tile showed how long ago the event last happened, and under it the
amount a tap would record. Read together, the second line looked like it
described the entry the first line referred to. A tile saying "1h 35m ago" and
"120ml" was reporting the last feed and the next one at once, and nothing said
which was which.

**Decision.** The tile shows the amount on the last entry. Both lines then
describe the same event. A type with no entry yet shows no amount, because there
is nothing to report.

This narrows the decision of 2026-08-10, which said the tile shows the amount a
tap records. What a tap records is unchanged and still comes from the type. Only
the tile stopped being where that is read; the tile menu and the edit sheet both
show the setting.

**Alternatives.** Label the two lines. Rejected because a tile is about
seventy pixels wide and two labels cost more room than the numbers. Rejected
dropping the amount from the tile, because seeing the last feed at a glance is
why it is there.

**Invalidated if.** Users need to check what a tap will record without opening
anything, for instance after changing the setting.
