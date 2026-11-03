# Auto JPG

A Chrome / Edge extension that saves every **WebP** picture you download as a **JPG**. The JPG is what shows up in your browser's downloads list, so **Open file** opens the JPG. Keeps itself up to date.

## Install (Chrome, Edge, Brave)

1. Download the extension: on this page click **Code → Download ZIP** (or use the zip you were sent).
2. Unzip it somewhere you'll keep it, e.g. `Documents\auto-jpg`. Don't delete or move the folder afterwards: the browser runs the extension from there.
3. Open the extensions page: `chrome://extensions` (Chrome / Brave) or `edge://extensions` (Edge).
4. Turn on **Developer mode** (top-right in Chrome, left sidebar in Edge) and leave it on.
5. Click **Load unpacked** and pick the folder (the one with `manifest.json` directly inside).
6. Optional: click the puzzle-piece icon in the toolbar and pin **Auto JPG** to see its update status.
7. Turn on auto-update (below).

If you had an earlier Auto JPG loaded, remove it first.

## Turn on auto-update

Do this once. In the extension folder, double-click **`Turn on auto-update.bat`**. If Windows asks whether to run it, choose **Run** (or **More info → Run anyway**). A window says *Auto-update is ON*; close it.

From then on the extension updates itself:

- it checks GitHub when your browser starts and every 3 hours;
- when there's a new version, it downloads it, installs it into the folder and restarts itself (a second or two), with nothing to click. It waits if it's in the middle of converting a picture;
- the toolbar popup shows your version (e.g. *Updated to 1.2.1 ✓*), and **Check for updates** checks right away. If the one-time setup hasn't been done, that button downloads `Auto JPG <version>.zip` into your downloads folder instead: unzip it over the extension folder, then click **Reload** on the extensions page.

Why the one-time step: browsers don't let an extension rewrite its own files, so a tiny helper (`updater\`) does the installing. It needs no admin rights, doesn't run in the background, and only starts when the extension has found a new version. It only ever downloads from this repository, only accepts a download that really is Auto JPG at the expected version, and if anything goes wrong it leaves your folder exactly as it was. To turn it off, run `updater\Turn off auto-update.bat` (or switch off **Update automatically** in the popup).

If you move the extension folder, run `Turn on auto-update.bat` again from the new place.

## What it does

- **WebP → JPG.** Any download that is a WebP picture (named `.webp`, or a WebP that a site named `.jpg`) is saved as a real JPG with the same name, in the same folder. The WebP is removed from your disk and from the downloads list.
- **Everything else is untouched:** PNG, GIF, JPG, `.jfif`, videos, documents.
- **Transparent WebPs** get a white background (JPG can't be see-through).
- **Animated WebPs** are left as WebP, so they keep moving.
- **Works with other extensions,** such as Quick Image Saver: their pictures are converted too, and the file names and folders they choose are kept.
- **If a site refuses** to hand the picture over a second time, the WebP download is left as it is.
- **"Save image as" outside Downloads:** the extension asks where to put the JPG.

You may see the WebP in the downloads list for a moment before the JPG replaces it.

## Files

```
manifest.json      extension manifest (fixed key, so the ID never changes)
background.js      spots WebP downloads, swaps in the JPG, checks for updates
offscreen.*        hidden page that does the converting
popup/             toolbar popup (update status)
icons/             icons
updater/           auto-update helper (Windows PowerShell, started by the extension)
Turn on auto-update.bat   one-time setup for auto-update
```

## Publishing a new version

Auto-update follows the `main` branch. To ship an update: raise `"version"` in `manifest.json` (e.g. `1.2.0` → `1.2.1`) and push to `main`. Every installed copy picks it up within 3 hours, or right away with **Check for updates**. Only push finished, tested versions to `main`.
