// Shared helpers for the browser tests.
//
// Every test gets its own browser context, so IndexedDB, the session cookie and
// the service worker never leak between tests — a shared context made one test
// pass only because an earlier one had signed in.

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login(base, passcode) {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  return res.headers.get("set-cookie").split(";")[0];
}

export async function sync(base, cookie, changes = {}) {
  const res = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ since: 0, changes }),
  });
  if (!res.ok) throw new Error(`sync failed: HTTP ${res.status}`);
  return res.json();
}

export const liveEvents = async (base, cookie) =>
  (await sync(base, cookie)).changes.events.filter((e) => !e.deleted);

/** Build a project with its own ids, so tests never collide. */
export function project(key, { types = [], labels = [], events = [] } = {}) {
  return {
    projects: [{ id: key, name: key, color: "#60a5fa", archived: 0, deleted: 0, updated_at: 1 }],
    event_types: types.map((t, i) => ({
      id: t.id, project_id: key, name: t.name, kind: t.kind,
      icon: t.icon || "•", color: t.color || "#f87171", position: i,
      archived: 0, deleted: 0, updated_at: 1,
    })),
    labels: labels.map((l) => ({
      id: l.id, project_id: key, name: l.name, color: l.color || "#a78bfa",
      archived: 0, deleted: 0, updated_at: 1,
    })),
    events: events.map((e) => ({
      id: e.id, project_id: key, type_id: e.type, started_at: e.start,
      ended_at: e.end === undefined ? e.start : e.end,
      label_ids: e.labels || [], note: "", deleted: 0, updated_at: 1,
    })),
  };
}

/**
 * Pick a project through the switcher.
 *
 * Tests share one server, and the app opens whichever project sorts first by
 * name. Without choosing explicitly, a test reads whatever screen the other
 * tests happened to leave sorting first — which is how two of these passed for
 * the wrong reason.
 */
export async function selectProject(page, id) {
  // Fail with the real reason. When an overlay covers the page every click
  // silently misses, and the error would otherwise blame a missing element.
  const blocker = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const cls = String(el?.className || "");
    return cls.includes("sheet-backdrop") ? cls : null;
  });
  if (blocker) throw new Error(`an overlay (${blocker}) is covering the page — taps cannot reach the app`);

  await page.click("#project-btn");
  await wait(600);
  await page.click(`[data-pick="${id}"]`);
  await wait(1200);
}

export async function openApp(browser, base, { passcode = null, path = "/", select = null } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource")
    && errors.push(m.text().slice(0, 140)));

  await page.goto(base + path, { waitUntil: "networkidle0" });
  await wait(1500);

  if (passcode) {
    await page.type("[data-passcode]", passcode);
    await page.click("[data-action='sign-in']");
    await wait(2500);
  }
  if (select) await selectProject(page, select);
  return { context, page, errors };
}

/**
 * Click a button by its text.
 *
 * Scoped to the open sheet when there is one: a whole-document search matched a
 * button sitting behind the overlay and made a test pass against a screen the
 * user could not reach.
 */
export async function clickText(page, text) {
  const handle = await page.evaluateHandle((t) => {
    const root =
      document.querySelector("#sheet-backdrop:not([hidden]) .sheet-panel") ||
      document.getElementById("screen");
    return [...root.querySelectorAll("button, a")].find((b) =>
      b.textContent.trim().toLowerCase().includes(t.toLowerCase())
    );
  }, text);
  const el = handle.asElement();
  if (!el) throw new Error(`no clickable element containing "${text}"`);
  await el.click();
  await wait(500);
}

/** What is actually on top at the middle of the screen. */
export const topmost = (page) =>
  page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return `${el?.tagName}.${el?.className}`;
  });

export const screenState = (page) =>
  page.evaluate(() => ({
    booted: !!window.__trackerBooted,
    project: document.getElementById("project-name").textContent,
    tiles: [...document.querySelectorAll(".tile[data-id] .tile-name")].map((e) => e.textContent),
    running: [...document.querySelectorAll(".active-card .active-name")].map((e) => e.textContent),
    entries: document.querySelectorAll(".entry").length,
    toast: (() => {
      const t = document.getElementById("toast");
      return t && !t.hidden ? t.textContent.trim() : null;
    })(),
  }));
