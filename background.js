// Auto JPG — saves downloaded pictures that Windows Photos can't save edits to as JPG.
//
// The Windows 11 Photos app can only save edits back into JPG, PNG, BMP, TIFF and
// JPEG XR files. Pictures in other formats it opens (WebP, AVIF, HEIC/HEIF, GIF)
// can only be saved as a copy after editing. So Auto JPG turns those into JPGs.
//
// How it works: when a download finishes, Auto JPG checks whether it's one of those
// pictures. If so it makes a JPG copy, saves that copy in the same place under the
// same name, then removes the original from your disk and from the downloads list.
// So the downloads list — and "Open file" — point at the JPG. Everything else (JPG,
// PNG, BMP, TIFF, videos...) is left as it is, and so are animated GIFs/WebPs/AVIFs
// (a JPG can't move). If anything goes wrong, the original download is left alone.
//
// The picture is read from the file you downloaded (extensions loaded with "Load
// unpacked" may read local files). Only if that's switched off does Auto JPG fetch
// it from the site again, and some sites refuse that or send a different file.
//
// (It deliberately does NOT use chrome.downloads.onDeterminingFilename: in Chrome,
// using that makes other extensions lose the file names they choose.)

const handling = new Set(); // download ids being processed or already done
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

const mimeOf = (item) => (item.mime || "").split(";")[0].trim().toLowerCase();

function needsJpg(item) {
  const ext = extOf(baseName(item.filename));
  const mime = mimeOf(item);
  if (mime.startsWith("video/") || mime.startsWith("text/")) return false;
  return CONVERT_MIME.has(mime) || CONVERT_EXT.has(ext);
}

// Files that say they're a JPG or PNG, and files the site didn't name a type for.
// Sites (and the browser, when a page names the file .jpg) often label an AVIF or WebP
// that way, so these get a quick look at their first bytes. Real JPGs/PNGs are kept.
const CLAIMED_EXT = new Set(["jpg", "jpeg", "jpe", "jfif", "png"]);
const CLAIMED_MIME = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png"]);
const UNNAMED_MIME = new Set(["", "application/octet-stream", "binary/octet-stream",
                              "application/binary", "application/x-binary", "application/unknown"]);
const UNNAMED_EXT = new Set(["", "bin", "dat", "tmp", "php", "asp", "aspx", "ashx", "jsp", "cgi", "image", "img"]);

function worthALook(item) {
  const ext = extOf(baseName(item.filename));
  const mime = mimeOf(item);
  if (CLAIMED_MIME.has(mime) || CLAIMED_EXT.has(ext)) return true;
  return UNNAMED_MIME.has(mime) && UNNAMED_EXT.has(ext);
}

// Pictures are converted once the download has finished.
chrome.downloads.onCreated.addListener((item) => {
  if (item.filename && item.state === "complete") consider(item.id);
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (delta.filename?.current || state === "complete") consider(delta.id);
  if (state === "complete" || state === "interrupted") closeConverterIfIdle();
});

async function consider(id) {
  if (handling.has(id)) return;
  handling.add(id);
  busy++; // counted straight away so the converter isn't closed under us
  let done = false;
  let name = "";
  try {
    const [item] = await chrome.downloads.search({ id });
    if (!item || item.byExtensionId === chrome.runtime.id || item.state === "interrupted") { done = true; return; }
    if (!item.filename || item.state !== "complete") return; // not finished yet: comes back on "complete"
    done = true;
    name = baseName(item.filename);
    const convert = needsJpg(item);
    if (!convert && !worthALook(item)) return;
    await replaceWithJpg(item, convert ? "convert" : "check");
  } catch (err) {
    console.warn("Auto JPG: couldn't convert", name, err);
  } finally {
    if (!done) handling.delete(id);
    busy--;
    closeConverterIfIdle();
  }
}

// "C:\Users\me\Downloads\my pic.avif" -> "file:///C:/Users/me/Downloads/my%20pic.avif"
function fileUrl(fullPath) {
  const parts = fullPath.replace(/\\/g, "/").split("/");
  if (parts[0] === "") parts.shift(); // "/home/me/..." on Linux/Mac
  return "file:///" + parts.map((p, i) => (i === 0 && /^[a-z]:$/i.test(p) ? p : encodeURIComponent(p))).join("/");
}

const canReadFiles = () =>
  new Promise((resolve) => {
    try { chrome.extension.isAllowedFileSchemeAccess((ok) => resolve(!!ok)); } catch (_) { resolve(false); }
  });

// Read the downloaded file itself, so it's exactly the picture you got. Only if that
// isn't possible, fetch it from the site again.
async function convertDownload(item, mode) {
  const tries = [];
  if (item.exists !== false && (await canReadFiles())) tries.push({ url: fileUrl(item.filename), local: true });
  const web = item.finalUrl || item.url;
  if (web) tries.push({ url: web, local: false });

  let result = { ok: false, error: "nowhere to read it from" };
  for (const t of tries) {
    for (let attempt = 0; attempt < (t.local ? 3 : 1); attempt++) {
      if (mode === "check") {
        // look at the first bytes before reading the whole file
        const peek = await askConverter({ type: "peek", url: t.url }).catch(() => null);
        if (peek?.type && !peek.convertible) return { ok: false, skip: true };
        if (!peek?.type) {
          result = { ok: false, error: "couldn't look at it" };
          if (t.local && attempt < 2) { await new Promise((r) => setTimeout(r, 400)); continue; }
          break;
        }
      }
      result = await askConverter({ type: "convert", url: t.url, check: mode === "check" })
        .catch((e) => ({ ok: false, error: String(e) }));
      if (result.ok || result.skip || result.final) return result;
      if (t.local && attempt < 2) await new Promise((r) => setTimeout(r, 400)); // file may still be locked (virus scan)
    }
  }
  return result;
}

async function replaceWithJpg(item, mode) {
  const name = baseName(item.filename);
  const result = await convertDownload(item, mode);
  if (result.skip) return; // a real JPG/PNG, or not a picture
  if (!result?.ok) {
    console.log("Auto JPG: kept original", name, "-", result?.error);
    return;
  }

  const relative = relativeToDownloads(item.filename);
  const jpgName = toJpgName(relative ?? name);
  const sameName = toJpgName(name).toLowerCase() === name.toLowerCase(); // e.g. an AVIF called .jpg

  if (sameName) await removeOriginal(item.id); // free up the name first
  await chrome.downloads.download({
    url: result.blobUrl,
    filename: jpgName,
    conflictAction: "uniquify",
    // saved somewhere outside Downloads with "Save as": ask where the JPG should go
    saveAs: !relative,
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
  for (let attempt = 0; ; attempt++) {
    await ensureConverter();
    try {
      return await chrome.runtime.sendMessage({ target: "auto-jpg-offscreen", ...message });
    } catch (e) {
      // the hidden page was closing just as we asked: open it again once
      if (attempt > 0 || !/establish connection|receiving end/i.test(String(e))) throw e;
    }
  }
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
