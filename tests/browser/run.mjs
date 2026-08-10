// Browser tests.
//
// These cover what the Python tests cannot: whether a person can actually use
// the screen. Every bug in this file was shipped at some point — a full-screen
// overlay that swallowed every tap, a toast covering the sign-in button, a
// blank page after a half-updated cache. All of them passed the API tests.
//
//   BASE=http://logbook-test:8080 PASSCODE=... node suite/run.mjs

import puppeteer from "puppeteer";
import {
  clickText, liveEvents, login, openApp, project, screenState, sync, topmost, wait,
} from "./harness.mjs";

const BASE = process.env.BASE || "http://localhost:8080";
const PASSCODE = process.env.PASSCODE || "";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const H = 3600_000;
const midnight = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
})();

// ---------------------------------------------------------------------------

test("nothing covers the screen", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-top", { types: [{ id: "t-top", name: "Feed", kind: "point" }] }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-top" });
  // An invisible overlay above the page once made the whole app untappable.
  ok(!(await topmost(page)).includes("sheet-backdrop"), "an overlay is intercepting taps");
  eq(errors, [], "javascript errors");
});

test("one tap logs a moment and offers undo", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-tap", { types: [{ id: "t-tap", name: "Feed", kind: "point" }] }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-tap" });
  const before = (await liveEvents(BASE, cookie)).length;

  await page.click(".tile[data-id='t-tap']");
  await wait(1500);

  const state = await screenState(page);
  ok(state.toast?.includes("Undo"), "no undo offered after logging");
  eq((await liveEvents(BASE, cookie)).length - before, 1, "events created");
  eq(errors, [], "javascript errors");
});

test("a span toggles on the second tap", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-span", { types: [{ id: "t-span", name: "Sleep", kind: "span" }] }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-span" });

  await page.click(".tile[data-id='t-span']");
  await wait(1200);
  eq((await screenState(page)).running, ["Sleep"], "span running after first tap");

  await page.click(".tile[data-id='t-span']");
  await wait(1500);
  eq((await screenState(page)).running, [], "span still running after second tap");

  const ev = (await liveEvents(BASE, cookie)).find((e) => e.type_id === "t-span");
  ok(ev && ev.ended_at !== null, "the span was not closed");
  eq(errors, [], "javascript errors");
});

test("a finished span is recorded in one sheet", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-back", { types: [{ id: "t-back", name: "Sleep", kind: "span" }] }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-back" });

  await page.click(".tile-wrap:has(.tile[data-id='t-back']) .tile-more");
  await wait(700);
  await clickText(page, "add a finished span");
  await page.click("[data-shift='started_at:-1440']"); // yesterday
  await page.click("[data-duration='480']"); // 8h
  await wait(400);
  await clickText(page, "add entry");
  await wait(1500);

  const ev = (await liveEvents(BASE, cookie)).find((e) => e.type_id === "t-back");
  ok(ev, "no entry was created");
  eq((ev.ended_at - ev.started_at) / H, 8, "duration in hours");
  ok(ev.started_at < midnight, "the entry was not moved to yesterday");
  eq(errors, [], "javascript errors");
});

test("history draws days, a rolling window and a list", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-hist", {
    types: [
      { id: "t-h-sleep", name: "Sleep", kind: "span", color: "#60a5fa" },
      { id: "t-h-feed", name: "Feed", kind: "point", color: "#f87171" },
    ],
    labels: [{ id: "l-h-left", name: "left" }],
    events: [
      // Crosses midnight: it must appear on both days.
      { id: "e-h1", type: "t-h-sleep", start: midnight - 2 * H, end: midnight + 6 * H },
      { id: "e-h2", type: "t-h-feed", start: midnight + 7 * H, labels: ["l-h-left"] },
      { id: "e-h3", type: "t-h-feed", start: midnight + 9 * H },
    ],
  }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-hist" });

  await page.click("#history-btn");
  await wait(1200);
  const days = await page.evaluate(() => ({
    hash: location.hash,
    rows: document.querySelectorAll(".tl-row").length,
    spans: document.querySelectorAll(".tl-span").length,
    labelled: document.querySelectorAll(".tl-span.labelled, .tl-tick.labelled").length,
  }));
  eq(days.hash, "#history", "history is not its own page");
  ok(days.rows >= 2, "the midnight-crossing span is not on both days");
  ok(days.spans >= 2, "the span was not split at midnight");
  ok(days.labelled >= 1, "labels are not shown on the timeline");

  await page.click("[data-view='rolling']");
  await wait(900);
  eq(await page.evaluate(() => document.querySelectorAll(".tl-row").length), 1, "rows in the rolling view");

  await page.click("[data-view='list']");
  await wait(900);
  ok((await page.evaluate(() => document.querySelectorAll(".entry").length)) >= 3, "entries in the list view");

  // The back gesture must leave the page, not the app.
  await page.goBack();
  await wait(1200);
  ok((await screenState(page)).tiles.length > 0, "going back did not return to the log");
  eq(errors, [], "javascript errors");
});

test("filtering by a label narrows the timeline and the stats", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-filt", {
    types: [{ id: "t-f-feed", name: "Feed", kind: "point" }],
    labels: [{ id: "l-f-a", name: "left" }, { id: "l-f-b", name: "right" }],
    events: [
      { id: "e-f1", type: "t-f-feed", start: midnight + 7 * H, labels: ["l-f-a"] },
      { id: "e-f2", type: "t-f-feed", start: midnight + 9 * H, labels: ["l-f-b"] },
      { id: "e-f3", type: "t-f-feed", start: midnight + 11 * H, labels: ["l-f-a"] },
    ],
  }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-filt" });

  await page.click("#history-btn");
  await wait(1000);
  await page.click("[data-view='list']");
  await wait(800);
  const all = await page.evaluate(() => document.querySelectorAll(".entry").length);

  await page.click("[data-filter-label='l-f-a']");
  await wait(900);
  const filtered = await page.evaluate(() => document.querySelectorAll(".entry").length);
  eq(filtered, 2, "entries carrying the 'left' label");
  ok(filtered < all, "the filter did not narrow anything");

  // The same chips must drive the stats, which is what removes the need for a
  // query builder.
  await page.click("[data-view='stats']");
  await wait(1200);
  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll(".stat")].map((s) => s.textContent.trim().replace(/\s+/g, " "))
  );
  ok(tiles.some((t) => t.startsWith("2 ")), `stats ignored the filter: ${JSON.stringify(tiles)}`);

  await page.click("[data-clear-filters]");
  await wait(900);
  ok((await page.evaluate(() => document.querySelectorAll(".bars").length)) === 2, "stats charts");
  eq(errors, [], "javascript errors");
});

test("a Home Screen link logs once and survives a reload", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-link", { types: [{ id: "t-link", name: "Feed", kind: "point" }] }));
  const before = (await liveEvents(BASE, cookie)).length;

  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, path: "/?toggle=t-link", select: "p-link" });
  await wait(2500);
  eq(await page.evaluate(() => location.search), "", "the action was left in the URL");
  eq((await liveEvents(BASE, cookie)).length - before, 1, "events after following the link");

  // Reloading must not repeat the action.
  await page.reload({ waitUntil: "networkidle0" });
  await wait(2000);
  eq((await liveEvents(BASE, cookie)).length - before, 1, "events after reloading");
  eq(errors, [], "javascript errors");
});

test("sign-in holds a Home Screen link rather than dropping it", async (browser, cookie) => {
  if (!PASSCODE) return "skipped: no passcode set";
  await sync(BASE, cookie, project("p-auth", { types: [{ id: "t-auth", name: "Feed", kind: "point" }] }));
  const before = (await liveEvents(BASE, cookie)).length;

  // No passcode passed, so this context arrives signed out.
  const { page, errors } = await openApp(browser, BASE, { path: "/?toggle=t-auth" });
  ok(await page.$("[data-passcode]"), "a signed-out device was not asked for the passcode");
  eq((await liveEvents(BASE, cookie)).length - before, 0, "an event was logged before signing in");

  // A wrong passcode must not make a second attempt impossible: the error toast
  // used to sit on top of the sign-in button.
  await page.type("[data-passcode]", "definitely-wrong");
  await page.click("[data-action='sign-in']");
  await wait(1200);
  await page.evaluate(() => (document.querySelector("[data-passcode]").value = ""));
  await page.type("[data-passcode]", PASSCODE);
  await page.click("[data-action='sign-in']");
  await wait(3000);

  ok(!(await page.$("[data-passcode]")), "the second attempt with the right passcode did not sign in");
  eq((await liveEvents(BASE, cookie)).length - before, 1, "the held link did not run after signing in");
  eq(errors, [], "javascript errors");
});

test("a tap records the amount set up on the type, and the bar corrects it", async (browser, cookie) => {
  await sync(BASE, cookie, {
    ...project("p-qty"),
    event_types: [{
      id: "t-qty", project_id: "p-qty", name: "Bottle", kind: "point", icon: "B",
      color: "#f87171", position: 0, unit: "ml", step: 10, default_quantity: 120,
      archived: 0, deleted: 0, updated_at: 1,
    }],
  });
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-qty" });

  // The tile says what a tap will record, so it is not a surprise.
  const tile = await page.$eval(".tile[data-id='t-qty']", (el) => el.textContent);
  ok(tile.includes("120ml"), `the tile does not show the amount: ${tile}`);

  await page.click(".tile[data-id='t-qty']");
  await wait(1500);
  const logged = (await liveEvents(BASE, cookie)).find((e) => e.type_id === "t-qty");
  eq(logged.quantity, 120, "amount recorded by one tap");

  // Two taps on plus, one on minus: 120 + 10 + 10 - 10 = 130.
  const plus = await page.evaluateHandle(() =>
    [...document.querySelectorAll("#toast [data-toast]")].find((b) => b.textContent.trim() === "+"));
  const minus = await page.evaluateHandle(() =>
    [...document.querySelectorAll("#toast [data-toast]")].find((b) => b.textContent.trim() === "\u2212"));
  ok(plus.asElement() && minus.asElement(), "the undo bar has no stepper");
  await plus.asElement().click(); await wait(300);
  await plus.asElement().click(); await wait(300);
  await minus.asElement().click(); await wait(1500);

  eq((await liveEvents(BASE, cookie)).find((e) => e.id === logged.id).quantity, 130, "amount after stepping");
  // Stepping must not dismiss the bar, or a second correction is impossible.
  ok(await page.evaluate(() => !document.getElementById("toast").hidden), "the bar closed while stepping");

  // Stats gain an Amount metric, driven by the same filters.
  await page.click("#history-btn");
  await wait(1000);
  await page.click("[data-view='stats']");
  await wait(1200);
  const metrics = await page.$$eval("[data-metric]", (els) => els.map((e) => e.textContent.trim()));
  ok(metrics.includes("Amount"), `no Amount metric offered: ${JSON.stringify(metrics)}`);
  await page.click("[data-metric='amount']");
  await wait(1000);
  const tiles = await page.$$eval(".stat", (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, " ")));
  ok(tiles.some((t) => t.includes("130ml")), `stats do not total the amount: ${JSON.stringify(tiles)}`);

  eq(errors, [], "javascript errors");
});

test("turning a span type into a moment does not strand a running span", async (browser, cookie) => {
  await sync(BASE, cookie, project("p-kind", {
    types: [{ id: "t-kind", name: "Nap", kind: "span" }],
    events: [{ id: "e-kind-open", type: "t-kind", start: Date.now() - 3600_000, end: null }],
  }));
  const { page, errors } = await openApp(browser, BASE, { passcode: PASSCODE, select: "p-kind" });
  eq((await screenState(page)).running, ["Nap"], "a span should be running to begin with");

  await page.click(".tile-wrap:has(.tile[data-id='t-kind']) .tile-more");
  await wait(700);
  await clickText(page, "edit event");
  await page.click("[data-kind-value='point']");
  await wait(300);
  await clickText(page, "save");
  await wait(2000);

  const stored = (await sync(BASE, cookie)).changes.event_types.find((t) => t.id === "t-kind");
  eq(stored.kind, "point", "the new kind was not saved");

  // A moment tile cannot end a span, so leaving one open would strand it: it
  // would run for ever while taps recorded new entries beside it.
  eq((await screenState(page)).running, [], "a span is still running after the type became a moment");
  const open = (await liveEvents(BASE, cookie)).filter((e) => e.type_id === "t-kind" && e.ended_at === null);
  eq(open.length, 0, "open spans left behind");

  await page.click(".tile[data-id='t-kind']");
  await wait(1500);
  eq((await screenState(page)).running, [], "tapping the tile started a span on a moment type");
  eq(errors, [], "javascript errors");
});

// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const cookie = PASSCODE ? await login(BASE, PASSCODE) : "";

let failed = 0;
for (const { name, fn } of tests) {
  const started = Date.now();
  try {
    const note = await fn(browser, cookie);
    const ms = Date.now() - started;
    console.log(note ? `  - ${name} (${note})` : `  ✓ ${name} (${ms}ms)`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
await browser.close();

console.log(`\n${tests.length - failed}/${tests.length} browser tests passed`);
process.exit(failed ? 1 : 0);
