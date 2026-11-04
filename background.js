// Auto JPG — saves downloaded pictures that Windows Photos can't save edits to as JPG.
//
// The Windows 11 Photos app can only save edits back into JPG, PNG, BMP, TIFF and
// JPEG XR files. Pictures in other formats it opens (WebP, AVIF, HEIC/HEIF, GIF)
// can only be saved as a copy after editing. So Auto JPG turns those into JPGs.
//
// How it works: as soon as the browser knows where a download is going, Auto JPG
// checks whether it's one of those pictures. If so it makes a JPG copy, saves that
// copy in the same place under the same name, then removes the original from your
// disk and from the downloads list. So the downloads list — and "Open file" —
// point at the JPG. Everything else (JPG, PNG, BMP, TIFF, videos...) is left as it is,
// and so are animated GIFs/WebPs (a JPG can't move).
// If anything goes wrong, the original download is simply left alone.
//
// (It deliberately does NOT use chrome.downloads.onDeterminingFilename: in Chrome,
// using that makes other extensions lose the file names they choose.)

const handling = new Set(); // download ids being processed
let busy = 0;

const baseName = (p) => (p || "").split(/[\\/]/).pop() || "image";
const extOf = (name) => (/\.([^.]+)$/.exec(name)?.[1] || "").toLowerCase();
const toJpgName = (name) => (name.replace(/\.[^./]*$/, "") || "image") + ".jpg";

// "C:\Users\me\Downloads\Pics\cat.png" -> "Pics/cat.png"   (null if not inside Downloads)
function relativeToDownloads(fullPath) {
  const parts = fullPath.split(/[\\/]/);
  const i = parts.findIndex((p) => p.toLowerCase() === "downloads");
  return i >= 0 && i < parts.length - 1 ? parts.slice(i + 1).join("/") : null;
}

// The picture types Windows Photos can open but can't save edits to.
// Matched by what the site says the file is (even if it's named .jpg) or by its name.
const CONVERT_MIME = new Set([
  "image/webp", "image/avif", "image/gif",
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
]);
const CONVERT_EXT = new Set(["webp", "avif", "gif", "heic", "heif", "hif"]);

const SNIFFED_TYPES = new Set(["image/webp", "image/avif", "image/gif", "image/heic"]);

function needsJpg(item) {
  const ext = extOf(baseName(item.filename));
  const mime = (item.mime || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("video/") || mime.startsWith("text/")) return false;
  return CONVERT_MIME.has(mime) || CONVERT_EXT.has(ext);
}

// Says it's a JPG. Sites (and the browser, when a page names the file .jpg) sometimes
// label a WebP or AVIF that way, so these get a quick look at their first bytes.
function claimsJpeg(item) {
  const ext = extOf(baseName(item.filename));
  const mime = (item.mime || "").split(";")[0].trim().toLowerCase();
  return mime === "image/jpeg" || mime === "image/jpg" || ext === "jpg" || ext === "jpeg";
}

chrome.downloads.onCreated.addListener((item) => {
  if (item.filename) consider(item.id); // usually the name isn't known yet; see onChanged
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.filename?.current) consider(delta.id);
  const state = delta.state?.current;
  if (state === "complete" || state === "interrupted") closeConverterIfIdle();
});

async function consider(id) {
  if (handling.has(id)) return;
  const [item] = await chrome.downloads.search({ id });
  if (!item || !item.filename || item.byExtensionId === chrome.runtime.id) return;
  const convert = needsJpg(item);
  if (!convert && !claimsJpeg(item)) return;
  handling.add(id);
  busy++;
  try {
    if (!convert) {
      // a "JPG": only convert it if its first bytes show it's really a WebP/AVIF/HEIC/GIF
      const peek = await askConverter({ type: "peek", url: item.finalUrl || item.url }).catch(() => null);
      if (!SNIFFED_TYPES.has(peek?.type)) return;
    }
    await replaceWithJpg(item);
  } catch (err) {
    console.warn("Auto JPG: couldn't convert", baseName(item.filename), err);
  } finally {
    busy--;
    closeConverterIfIdle();
  }
}

async function replaceWithJpg(item) {
  const name = baseName(item.filename);
  const result = await askConverter({ type: "convert", url: item.finalUrl || item.url });
  if (!result?.ok) {
    console.log("Auto JPG: kept original", name, "-", result?.error);
    return;
  }

  const relative = relativeToDownloads(item.filename);
  const jpgName = toJpgName(relative ?? name);
  const sameName = toJpgName(name).toLowerCase() === name.toLowerCase(); // e.g. a WebP called .jpg

  if (sameName) await removeOriginal(item.id); // free up the name first
  await chrome.downloads.download({
    url: result.blobUrl,
    filename: jpgName,
    conflictAction: "uniquify",
    // saved somewhere outside Downloads with "Save as": ask where the JPG should go
    ...(relative ? {} : { saveAs: true }),
  });
  if (!sameName) await removeOriginal(item.id);
}

async function removeOriginal(id) {
  await chrome.downloads.cancel(id).catch(() => {}); // if it's still downloading
  const [d] = await chrome.downloads.search({ id });
  if (d?.state === "complete") await chrome.downloads.removeFile(id).catch(() => {});
  await chrome.downloads.erase({ id }).catch(() => {});
}

// ---- the hidden page that does the converting -------------------------------
let creating = null;

async function ensureConverter() {
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (open.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Convert downloaded pictures to JPG",
    })
    .catch((e) => {
      if (!String(e).includes("single offscreen")) throw e;
    })
    .finally(() => (creating = null));
  await creating;
}

async function askConverter(message) {
  await ensureConverter();
  return chrome.runtime.sendMessage({ target: "auto-jpg-offscreen", ...message });
}

// Close the hidden page once no conversions or JPG downloads are running.
async function closeConverterIfIdle() {
  if (busy > 0) return;
  const running = await chrome.downloads.search({ state: "in_progress" });
  if (running.some((d) => d.byExtensionId === chrome.runtime.id)) return;
  const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (open.length && busy === 0) await chrome.offscreen.closeDocument().catch(() => {});
}

// ---- automatic updates -------------------------------------------------------
// New versions are published to GitHub (github.com/aduseii/auto-jpg). The extension
// checks there when the browser starts and every 3 hours. Extensions can't rewrite
// their own files, so a small helper (updater/, turned on once with
// "Turn on auto-update.bat") downloads and installs the new version; then the
// extension restarts itself.
const UPDATE = {
  manifestUrl: "https://raw.githubusercontent.com/aduseii/auto-jpg/main/manifest.json",
  commitsUrl: "https://api.github.com/repos/aduseii/auto-jpg/commits/main",
  releaseZip: "https://github.com/aduseii/auto-jpg/archive/refs/heads/main.zip",
  helper: "com.aduseii.auto_jpg",
  alarm: "ajpg-update-check",
  retryAlarm: "ajpg-update-retry",
  everyMinutes: 180,
};

function isNewer(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function askHelper(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(UPDATE.helper, msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          const missing = /not found|forbidden/i.test(err.message || "");
          resolve({ ok: false, missing, error: missing ? "" : err.message });
        } else {
          resolve(res || { ok: false, error: "The updater did not answer" });
        }
      });
    } catch (e) {
      resolve({ ok: false, missing: true, error: "" });
    }
  });
}

async function setUpdateBadge(state) {
  const show = state && state.available;
  await chrome.action.setBadgeText({ text: show ? "NEW" : "" }).catch(() => {});
  if (show) await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" }).catch(() => {});
}

function ensureUpdateAlarm(firstInMinutes) {
  chrome.alarms.get(UPDATE.alarm).then((a) => {
    if (!a) chrome.alarms.create(UPDATE.alarm, { delayInMinutes: firstInMinutes, periodInMinutes: UPDATE.everyMinutes });
  }).catch(() => {});
}

function restartInto(from, to) {
  return chrome.storage.local
    .set({
      justUpdated: { from, to, at: Date.now() },
      update: { running: to, latest: to, available: false, checkedAt: Date.now(), helper: "on" },
    })
    .then(() => chrome.runtime.reload());
}

// Don't restart in the middle of converting a picture.
async function isWorking() {
  if (busy > 0) return true;
  const running = await chrome.downloads.search({ state: "in_progress" });
  return running.some((d) => d.byExtensionId === chrome.runtime.id);
}

let updateCheck = null;
function checkForUpdate(manual) {
  if (!updateCheck) updateCheck = runUpdateCheck(!!manual).finally(() => (updateCheck = null));
  return updateCheck;
}

// The plain main URL can stay stale for a few minutes. The commit id never does.
async function fetchRemoteManifest() {
  try {
    const head = await fetch(UPDATE.commitsUrl, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } });
    if (head.ok) {
      const sha = (await head.json())?.sha;
      if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
        const res = await fetch(UPDATE.manifestUrl.replace("/main/", `/${sha}/`), { cache: "no-store" });
        if (res.ok) return res.json();
      }
    }
  } catch (_) { /* fall back to the branch URL */ }
  const res = await fetch(`${UPDATE.manifestUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function runUpdateCheck(manual) {
  const running = chrome.runtime.getManifest().version;
  const prev = (await chrome.storage.local.get({ update: {} })).update || {};
  const state = { running, latest: prev.latest || null, available: false, checkedAt: Date.now(),
                  helper: prev.helper || "unknown", error: "", downloaded: false };
  try {
    // New files already on disk (helper finished, or folder replaced by hand)? Restart into them.
    const disk = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (disk && isNewer(disk.version, running)) {
      if (await isWorking()) chrome.alarms.create(UPDATE.retryAlarm, { delayInMinutes: 2 });
      else { await restartInto(running, disk.version); return state; }
    }

    const remote = await fetchRemoteManifest();
    if (!remote || remote.name !== "Auto JPG" || !remote.version) throw new Error("Unexpected update file");
    state.latest = remote.version;
    state.available = isNewer(remote.version, running);

    const { autoUpdate } = await chrome.storage.sync.get({ autoUpdate: true });
    if (state.available && autoUpdate) {
      if (await isWorking()) {
        chrome.alarms.create(UPDATE.retryAlarm, { delayInMinutes: 2 });
      } else {
        const r = await askHelper({ type: "update", expect: remote.version });
        if (r.ok && r.version) { await restartInto(running, r.version); return state; }
        state.helper = r.missing ? "missing" : "error";
        state.error = r.missing ? "" : r.error || "Update failed";
      }
    } else if (manual) {
      const r = await askHelper({ type: "ping" });
      state.helper = r.ok ? "on" : r.missing ? "missing" : "error";
      if (!r.ok && !r.missing) state.error = r.error || "";
    }
    // No helper set up: "Check for updates" puts the new version in your downloads instead.
    if (state.available && manual && state.helper !== "on") {
      await chrome.downloads.download({ url: UPDATE.releaseZip, filename: `Auto JPG ${remote.version}.zip`,
                                        conflictAction: "uniquify", saveAs: false });
      state.downloaded = true;
    }
  } catch (e) {
    state.error = e?.message || "Could not check for updates";
  }
  await chrome.storage.local.set({ update: state });
  await setUpdateBadge(state);
  return state;
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === UPDATE.alarm || a.name === UPDATE.retryAlarm) checkForUpdate(false);
});
chrome.runtime.onStartup.addListener(() => ensureUpdateAlarm(1));
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.clear(UPDATE.alarm).finally(() => ensureUpdateAlarm(1));
  setUpdateBadge(null);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "check-update") {
    checkForUpdate(true).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  return false;
});
