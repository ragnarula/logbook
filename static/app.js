// Boot: hydrate from IndexedDB, draw, then let the sync loop run in the
// background. Nothing on the startup path touches the network, so the app is
// usable the moment the local database has loaded.

import { load, subscribe, state, STORES } from "./store.js";
import { startSync, onStatus, sessionState } from "./sync.js";
import {
  captureDeepLink,
  openSignInSheet,
  render,
  renderSyncStatus,
  runPendingAction,
  tick,
  wire,
} from "./ui.js";

const hasLocalData = () => STORES.some((name) => state[name].size > 0);

async function main() {
  await load();
  wire();
  render();

  subscribe(render);
  onStatus(renderSyncStatus);

  // Take any Home Screen action out of the URL now, before sign-in can send
  // the page down a different path and lose it.
  captureDeepLink();

  // Keeps running spans and "N ago" labels honest without a full re-render.
  setInterval(tick, 1000);

  startSync();

  const session = await sessionState();
  if (session.auth && !session.signedIn) {
    // A device with entries of its own keeps working and can dismiss this. A
    // device with nothing to show has no reason to.
    openSignInSheet({ blocking: !hasLocalData() });
  } else {
    runPendingAction();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No offline shell, but the app still works while the tab is open.
    });
  }
}

main().then(
  () => {
    // Tells the recovery code in index.html that the app started. Without this
    // it assumes a broken release and clears the caches.
    window.__trackerBooted = true;
  },
  (err) => {
    // Leave __trackerBooted unset so the page repairs itself and reloads.
    console.error("tracker failed to start", err);
  }
);
