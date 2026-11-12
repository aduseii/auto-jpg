// Runs in a hidden page: reads the picture (the downloaded file, or from the site), turns it into a JPG.
// (HEIC is decoded with lib/heic-to.js, LGPL-3.0; everything else by the browser itself.)

const JPG_QUALITY = 0.95;   // 0 to 1
const SKIP_ANIMATED = true; // leave animated GIF/WebP/AVIF alone (a JPG can't move)
const HEAD_BYTES = 512;     // enough to read a picture's header (AVIF/HEIC list their brands there)

// What gets turned into a JPG when a file only *claims* to be a JPG/PNG.
const CONVERTIBLE = new Set(["image/webp", "image/avif", "image/gif", "image/heic", "image/heif"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "auto-jpg-offscreen") return;
  if (msg.type === "convert") {
    convert(msg.url, !!msg.check).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "peek") {
    peek(msg.url).then(
      (type) => sendResponse({ type, convertible: CONVERTIBLE.has(type) }),
      () => sendResponse({ type: null })
    );
    return true;
  }
});

const fetchFrom = (url, init = {}) =>
  fetch(url, url.startsWith("file:") ? {} : { credentials: "include", ...init });

// Read just the first bytes of a file to see what it really is.
async function peek(url) {
  const res = await fetchFrom(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const head = new Uint8Array(HEAD_BYTES);
  let got = 0;
  while (got < HEAD_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, HEAD_BYTES - got);
    head.set(value.subarray(0, take), got);
    got += take;
  }
  reader.cancel().catch(() => {});
  return sniff(head.subarray(0, got)) || "unknown";
}

// check: the file only claims to be a JPG/PNG — leave it alone unless it really is a WebP/AVIF/HEIC/GIF.
// Once the bytes are read, every answer is "final": fetching it again wouldn't change it.
async function convert(url, check) {
  let buf;
  try {
    const res = await fetchFrom(url);
    if (!res.ok) return { ok: false, error: "server said " + res.status };
    buf = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "couldn't read it (" + e + ")" };
  }
  const type = sniff(new Uint8Array(buf, 0, Math.min(HEAD_BYTES, buf.byteLength)));

  if (check && !CONVERTIBLE.has(type)) return { ok: false, skip: true };
  if (!type) return { ok: false, final: true, error: "not a picture this browser can read" };
  if (type === "image/jpeg") {
    // was a JPEG all along, just badly named
    return { ok: true, blobUrl: URL.createObjectURL(new Blob([buf], { type })) };
  }
  if (SKIP_ANIMATED && (await isAnimated(buf, type))) return { ok: false, final: true, error: "animated" };

  let bitmap;
  try {
    bitmap = await decode(buf, type);
  } catch (e) {
    return { ok: false, final: true, error: "couldn't decode " + type + " (" + e + ")" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPG has no transparency: use a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const jpg = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", JPG_QUALITY)
  );
  if (!jpg) return { ok: false, final: true, error: "JPG encode failed (picture too big?)" };
  return { ok: true, blobUrl: URL.createObjectURL(jpg) };
}

async function decode(buf, type) {
  const native = () => createImageBitmap(new Blob([buf], { type: type === "image/heif" ? "image/avif" : type }));
  const heic = async () => {
    // Browsers can't read HEIC themselves, so a decoder (lib/heic-to.js) is loaded when needed.
    const { heicTo } = await import("./lib/heic-to.js");
    return heicTo({ blob: new Blob([buf], { type: "image/heic" }), type: "bitmap" });
  };
  if (type === "image/heic") return heic().catch(native);
  if (type === "image/heif") return native().catch(heic); // could be either: AV1 or HEVC inside
  if (type === "image/avif") return native().catch(heic);
  return native();
}

// Work out the real format from the file's first bytes (names and servers can lie).
function sniff(b) {
  if (!b || b.length < 12) return null;
  const ascii = (start, len) => String.fromCharCode(...b.slice(start, start + len));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 4) === "ftyp") {
    // ISO media file: its "ftyp" box lists brands (main one, then compatible ones).
    const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const end = Math.min(size >= 16 ? size : 32, b.length);
    const brands = new Set([ascii(8, 4)]);
    for (let i = 16; i + 4 <= end; i += 4) brands.add(ascii(i, 4));
    if (brands.has("avif") || brands.has("avis")) return "image/avif";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"].some((x) => brands.has(x))) return "image/heic";
    if (brands.has("mif1") || brands.has("msf1")) return "image/heif"; // HEIF, codec not stated
  }
  return null;
}

async function isAnimated(buf, type) {
  if (type === "image/bmp" || type === "image/heic" || type === "image/heif" || !("ImageDecoder" in self)) return false;
  let decoder;
  try {
    decoder = new ImageDecoder({ data: buf, type });
    const frames = await Promise.race([
      (async () => {
        await decoder.tracks.ready;
        await decoder.completed; // whole file read, so the frame count is final
        return decoder.tracks.selectedTrack?.frameCount ?? 1;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(1), 5000)), // never hang on an odd file
    ]);
    return frames > 1;
  } catch (_) {
    return false;
  } finally {
    try { decoder?.close(); } catch (_) {}
  }
}
