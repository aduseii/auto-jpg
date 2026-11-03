// Runs in a hidden page: downloads the picture, turns it into a JPG.

const JPG_QUALITY = 0.95;   // 0 to 1
const SKIP_ANIMATED = true; // leave animated GIF/WebP/PNG alone (a JPG can't move)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "auto-jpg-offscreen") return;
  if (msg.type === "convert") {
    convert(msg.url).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

async function convert(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return { ok: false, error: "server said " + res.status };
  const buf = await res.arrayBuffer();
  const type = sniff(new Uint8Array(buf, 0, Math.min(32, buf.byteLength)));

  if (!type) return { ok: false, error: "not a picture this browser can read" };
  if (type === "image/jpeg") {
    // was a JPEG all along, just badly named
    return { ok: true, blobUrl: URL.createObjectURL(new Blob([buf], { type })) };
  }
  if (SKIP_ANIMATED && (await isAnimated(buf, type))) return { ok: false, error: "animated" };

  const bitmap = await createImageBitmap(new Blob([buf], { type }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPG has no transparency: use a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const jpg = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPG encode failed"))), "image/jpeg", JPG_QUALITY)
  );
  return { ok: true, blobUrl: URL.createObjectURL(jpg) };
}

// Work out the real format from the file's first bytes (names and servers can lie).
function sniff(b) {
  const ascii = (start, len) => String.fromCharCode(...b.slice(start, start + len));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(4, 4) === "ftyp" && /avi[fs]/.test(ascii(8, 24))) return "image/avif";
  return null;
}

async function isAnimated(buf, type) {
  if (type === "image/bmp" || !("ImageDecoder" in self)) return false;
  try {
    const decoder = new ImageDecoder({ data: buf, type });
    await decoder.tracks.ready;
    await decoder.completed; // whole file read, so the frame count is final
    const frames = decoder.tracks.selectedTrack?.frameCount ?? 1;
    decoder.close();
    return frames > 1;
  } catch (_) {
    return false;
  }
}
