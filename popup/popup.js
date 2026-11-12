const $ = (id) => document.getElementById(id);

function showUpdate(state, justUpdated) {
  const el = $("updateStatus");
  const running = chrome.runtime.getManifest().version;
  let text = `Version ${running}`;
  let tone = "";
  let needsSetup = false;
  state = state || {};
  const available = state.available && state.latest && state.running === running;
  if (available && state.downloaded) {
    text = `Downloaded ${state.latest}. Unzip it over the extension folder, then Reload.`;
    tone = "warn";
    needsSetup = state.helper === "missing";
  } else if (available && !$("autoUpdate").checked) {
    text = `Version ${state.latest} is out · switch this on to install it`;
    tone = "warn";
  } else if (available && state.helper === "missing") {
    text = `Version ${state.latest} is out · needs one-time setup`;
    tone = "warn";
    needsSetup = true;
  } else if (available && state.error) {
    text = `Version ${state.latest} is out · couldn’t install yet, will retry`;
    tone = "warn";
  } else if (available) {
    text = `Version ${state.latest} is out · installing soon`;
    tone = "warn";
  } else if (justUpdated && justUpdated.to === running && Date.now() - justUpdated.at < 36 * 3600 * 1000) {
    text = `Updated to ${running} ✓`;
    tone = "good";
  } else if (state.helper === "missing") {
    text = `Version ${running} · auto-update needs one-time setup`;
    needsSetup = true;
  } else if (state.error) {
    text = `Version ${running} · couldn’t check (${state.error})`;
  } else if (state.latest && state.helper === "on") {
    text = `Version ${running} · up to date, auto-update on ✓`;
    tone = "good";
  } else if (state.latest) {
    text = `Version ${running} · up to date`;
  }
  el.textContent = text;
  el.className = `hint ${tone}`;
  $("setupLink").hidden = !needsSetup;
}

async function load() {
  const { autoUpdate } = await chrome.storage.sync.get({ autoUpdate: true });
  $("autoUpdate").checked = autoUpdate;
  const { update, justUpdated } = await chrome.storage.local.get({ update: null, justUpdated: null });
  showUpdate(update, justUpdated);
  // Auto JPG converts the file you downloaded; without file access it has to fetch it again.
  chrome.extension.isAllowedFileSchemeAccess((ok) => { $("fileAccess").hidden = !!ok; });
}

$("checkNow").addEventListener("click", async () => {
  const btn = $("checkNow");
  btn.disabled = true;
  btn.textContent = "Checking…";
  const state = await chrome.runtime.sendMessage({ type: "check-update" }).catch(() => null);
  btn.disabled = false;
  btn.textContent = "Check for updates";
  showUpdate(state, null); // if an update installs, the extension restarts and this popup closes
});

$("autoUpdate").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoUpdate: e.target.checked });
  if (e.target.checked) $("checkNow").click(); // turning it on installs any waiting update
  else load();
});

load();
