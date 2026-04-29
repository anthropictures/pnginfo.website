// pnginfo.website
//
// Reads generation parameters embedded in AI-generated media.
//   PNG  -- tEXt / iTXt chunks
//   JPEG -- EXIF UserComment (A1111 piexif unicode)
//   WebP -- EXIF IFD0 ASCII tags (ComfyUI key:JSON convention) + UserComment fallback
//   WebM -- Matroska SimpleTag elements (ComfyUI/VHS)
//   MP4  -- iTunes-style metadata atoms (moov/udta/meta keys + ilst)
//
// Parser logic mirrors e6ai's gen_info.js, adapted to read from File objects
// (no HTTP Range requests) and rendered with vanilla DOM APIs.

// --- Constants --------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const EXIF_IFD_TAG = 0x8769;
const USER_COMMENT_TAG = 0x9286;

// EBML/Matroska element IDs
const EBML_HEADER = 0x1A45DFA3;
const EBML_SEGMENT = 0x18538067;
const EBML_TAGS = 0x1254C367;
const EBML_TAG = 0x7373;
const EBML_SIMPLE_TAG = 0x67C8;
const EBML_TAG_NAME = 0x45A3;
const EBML_TAG_STRING = 0x4487;

const ACCEPTED_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp",
  "video/webm", "video/mp4",
]);
const ACCEPTED_EXTS = new Set(["png", "jpg", "jpeg", "webp", "webm", "mp4"]);

// --- PNG --------------------------------------------------------------

function parsePngChunks(buffer) {
  const view = new DataView(buffer);

  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (view.getUint8(i) !== PNG_SIGNATURE[i]) {
      throw new Error("Not a valid PNG file");
    }
  }

  const chunks = [];
  let offset = 8;

  while (offset < buffer.byteLength - 12) {
    const length = view.getUint32(offset);
    const type = readFourCC(view, offset + 4);

    if (type === "IDAT") break;

    const dataStart = offset + 8;
    const dataLen = Math.min(length, buffer.byteLength - dataStart);

    if (type === "tEXt") {
      const data = new Uint8Array(buffer, dataStart, dataLen);
      const nullIndex = data.indexOf(0);
      if (nullIndex !== -1) {
        chunks.push({
          keyword: decodeText(data.slice(0, nullIndex)),
          text: decodeText(data.slice(nullIndex + 1)),
        });
      }
    } else if (type === "iTXt") {
      // iTXt: keyword \0 compression_flag(1) compression_method(1) lang \0 translated \0 text
      const data = new Uint8Array(buffer, dataStart, dataLen);
      const k = data.indexOf(0);
      if (k !== -1 && k + 2 < data.length) {
        const compressed = data[k + 1] === 1;
        if (compressed) {
          // Skip compressed iTXt -- would need DecompressionStream; rare for SD images.
          offset += 12 + length;
          continue;
        }
        const langEnd = data.indexOf(0, k + 3);
        if (langEnd === -1) { offset += 12 + length; continue; }
        const transEnd = data.indexOf(0, langEnd + 1);
        if (transEnd === -1) { offset += 12 + length; continue; }
        chunks.push({
          keyword: decodeText(data.slice(0, k)),
          text: decodeText(data.slice(transEnd + 1)),
        });
      }
    }

    offset += 12 + length;
  }

  return chunks;
}

// --- JPEG -------------------------------------------------------------

function parseJpegUserComment(buffer) {
  const view = new DataView(buffer);

  if (view.getUint16(0) !== 0xFFD8) {
    throw new Error("Not a valid JPEG file");
  }

  let offset = 2;
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xFFE1) {
      const segmentLength = view.getUint16(offset + 2);
      const segmentStart = offset + 4;

      if (
        view.getUint32(segmentStart) === 0x45786966
        && view.getUint16(segmentStart + 4) === 0x0000
      ) {
        const result = parseExifUserComment(buffer, segmentStart + 6);
        if (result.length) return result;
      }
      offset += 2 + segmentLength;
      continue;
    }

    if ((marker & 0xFF00) !== 0xFF00) break;
    const len = view.getUint16(offset + 2);
    offset += 2 + len;
  }

  return [];
}

function parseExifUserComment(buffer, tiffStart) {
  const view = new DataView(buffer);
  const le = view.getUint16(tiffStart) === 0x4949;

  const getU16 = (off) => view.getUint16(tiffStart + off, le);
  const getU32 = (off) => view.getUint32(tiffStart + off, le);

  const ifd0Offset = getU32(4);
  const ifd0Entries = getU16(ifd0Offset);
  let exifIfdOffset = null;
  for (let i = 0; i < ifd0Entries; i++) {
    const entryOff = ifd0Offset + 2 + (i * 12);
    if (getU16(entryOff) === EXIF_IFD_TAG) {
      exifIfdOffset = getU32(entryOff + 8);
      break;
    }
  }

  if (exifIfdOffset === null) return [];

  const exifEntries = getU16(exifIfdOffset);
  for (let i = 0; i < exifEntries; i++) {
    const entryOff = exifIfdOffset + 2 + (i * 12);
    if (getU16(entryOff) === USER_COMMENT_TAG) {
      const count = getU32(entryOff + 4);
      const valueOffset = count > 4 ? getU32(entryOff + 8) : entryOff + 8;
      const absStart = tiffStart + valueOffset;
      const len = Math.min(count, buffer.byteLength - absStart);
      if (len <= 8) return [];

      const commentBytes = new Uint8Array(buffer, absStart, len);
      const charset = String.fromCharCode(...commentBytes.slice(0, 8)).replace(/\0/g, "");
      const payload = commentBytes.slice(8);

      let text;
      if (charset === "UNICODE") {
        // EXIF spec says Unicode UserComments are big-endian UTF-16.
        text = new TextDecoder("utf-16be").decode(payload);
      } else {
        text = decodeText(payload);
      }

      if (text) return [{ keyword: "parameters", text }];
    }
  }

  return [];
}

// --- WebP -------------------------------------------------------------

function parseWebpChunks(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) return [];
  if (view.getUint32(0) !== 0x52494646) return []; // "RIFF"
  if (view.getUint32(8) !== 0x57454250) return []; // "WEBP"

  let offset = 12;
  while (offset < buffer.byteLength - 8) {
    const fourcc = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);

    if (fourcc === "EXIF") {
      const chunks = parseWebpExifTags(buffer, offset + 8);
      if (chunks.length === 0) {
        return parseWebpExifUserComment(buffer, offset + 8);
      }
      return chunks;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return [];
}

function parseWebpExifTags(buffer, exifStart) {
  const view = new DataView(buffer);
  const chunks = [];

  let tiffStart = exifStart;
  if (
    exifStart + 6 <= buffer.byteLength
    && view.getUint32(exifStart) === 0x45786966
    && view.getUint16(exifStart + 4) === 0x0000
  ) {
    tiffStart = exifStart + 6;
  }

  if (tiffStart + 8 > buffer.byteLength) return [];

  const le = view.getUint16(tiffStart) === 0x4949;
  const getU16 = (off) => view.getUint16(tiffStart + off, le);
  const getU32 = (off) => view.getUint32(tiffStart + off, le);

  const ifd0Offset = getU32(4);
  if (tiffStart + ifd0Offset + 2 > buffer.byteLength) return [];

  const ifd0Entries = getU16(ifd0Offset);

  for (let i = 0; i < ifd0Entries; i++) {
    const entryOff = ifd0Offset + 2 + (i * 12);
    if (tiffStart + entryOff + 12 > buffer.byteLength) break;

    const type = getU16(entryOff + 2);
    if (type !== 2) continue; // ASCII only

    const count = getU32(entryOff + 4);
    if (count < 3) continue;

    const valueOffset = count <= 4 ? entryOff + 8 : getU32(entryOff + 8);
    const absOffset = tiffStart + valueOffset;
    if (absOffset + count > buffer.byteLength) continue;

    const strBytes = new Uint8Array(buffer, absOffset, count);
    const str = decodeText(strBytes).replace(/\0+$/, "");

    const colonIndex = str.indexOf(":");
    if (colonIndex > 0) {
      chunks.push({
        keyword: str.substring(0, colonIndex),
        text: str.substring(colonIndex + 1),
      });
    }
  }

  return chunks;
}

function parseWebpExifUserComment(buffer, exifStart) {
  let tiffStart = exifStart;
  const view = new DataView(buffer);
  if (
    exifStart + 6 <= buffer.byteLength
    && view.getUint32(exifStart) === 0x45786966
    && view.getUint16(exifStart + 4) === 0x0000
  ) {
    tiffStart = exifStart + 6;
  }
  if (tiffStart + 8 > buffer.byteLength) return [];
  return parseExifUserComment(buffer, tiffStart);
}

// --- WebM (Matroska/EBML) ---------------------------------------------

// EBML variable-length integer.
// For element IDs the marker bit is part of the value;
// for sizes the marker bit is stripped.
function readEbmlVint(view, offset, isSize) {
  if (offset >= view.byteLength) return null;
  const first = view.getUint8(offset);
  if (first === 0) return null;

  let width = 1;
  let mask = 0x80;
  while (width <= 8 && !(first & mask)) {
    width++;
    mask >>= 1;
  }
  if (width > 4) return null; // we cap at 32-bit values for sanity

  let value = isSize ? (first & ~mask) : first;
  for (let i = 1; i < width; i++) {
    if (offset + i >= view.byteLength) return null;
    value = value * 256 + view.getUint8(offset + i);
  }

  return { value, width };
}

function parseWebmTags(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) return [];

  const headerId = readEbmlVint(view, 0, false);
  if (!headerId || headerId.value !== EBML_HEADER) return [];
  const headerSize = readEbmlVint(view, headerId.width, true);
  if (!headerSize) return [];

  let offset = headerId.width + headerSize.width + headerSize.value;
  if (offset >= buffer.byteLength) return [];

  const segId = readEbmlVint(view, offset, false);
  if (!segId || segId.value !== EBML_SEGMENT) return [];
  const segSize = readEbmlVint(view, offset + segId.width, true);
  if (!segSize) return [];

  const segStart = offset + segId.width + segSize.width;
  const segEnd = Math.min(segStart + segSize.value, buffer.byteLength);

  offset = segStart;
  while (offset < segEnd - 4) {
    const id = readEbmlVint(view, offset, false);
    if (!id) break;
    const size = readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_TAGS) {
      return parseEbmlTagsElement(view, buffer, dataStart, dataEnd);
    }

    offset = dataEnd;
  }

  return [];
}

function parseEbmlTagsElement(view, buffer, start, end) {
  const chunks = [];
  let offset = start;

  while (offset < end - 4) {
    const id = readEbmlVint(view, offset, false);
    if (!id) break;
    const size = readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_TAG) {
      parseEbmlTagElement(view, buffer, dataStart, dataEnd, chunks);
    }

    offset = dataEnd;
  }

  return chunks;
}

function parseEbmlTagElement(view, buffer, start, end, chunks) {
  let offset = start;
  while (offset < end - 4) {
    const id = readEbmlVint(view, offset, false);
    if (!id) break;
    const size = readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataEnd = Math.min(dataStart + size.value, buffer.byteLength);

    if (id.value === EBML_SIMPLE_TAG) {
      const result = parseEbmlSimpleTag(view, buffer, dataStart, dataEnd);
      if (result) chunks.push(result);
    }

    offset = dataEnd;
  }
}

function parseEbmlSimpleTag(view, buffer, start, end) {
  let tagName = null;
  let tagString = null;
  let offset = start;

  while (offset < end - 2) {
    const id = readEbmlVint(view, offset, false);
    if (!id) break;
    const size = readEbmlVint(view, offset + id.width, true);
    if (!size) break;

    const dataStart = offset + id.width + size.width;
    const dataLen = Math.min(size.value, buffer.byteLength - dataStart);

    if (id.value === EBML_TAG_NAME) {
      tagName = decodeText(new Uint8Array(buffer, dataStart, dataLen));
    } else if (id.value === EBML_TAG_STRING) {
      tagString = decodeText(new Uint8Array(buffer, dataStart, dataLen));
    }

    offset = dataStart + size.value;
  }

  if (tagName && tagString) {
    return { keyword: tagName, text: unwrapJson(tagString) };
  }
  return null;
}

// --- MP4 --------------------------------------------------------------

// With ffmpeg -movflags use_metadata_tags, custom tags live in
// moov > udta > meta > keys + ilst.
function parseMp4Tags(buffer) {
  const view = new DataView(buffer);

  const moov = findMp4Box(view, 0, buffer.byteLength, "moov");
  if (!moov) return [];

  const udta = findMp4Box(view, moov.start, moov.end, "udta");
  if (!udta) return [];

  const meta = findMp4Box(view, udta.start, udta.end, "meta");
  if (!meta) return [];

  // meta is a full box: 4 bytes of version/flags after the header
  const metaStart = meta.start + 4;

  const keys = findMp4Box(view, metaStart, meta.end, "keys");
  const ilst = findMp4Box(view, metaStart, meta.end, "ilst");
  if (!keys || !ilst) return [];

  const keyList = parseMp4Keys(view, buffer, keys.start, keys.end);
  return parseMp4Ilst(view, buffer, ilst.start, ilst.end, keyList);
}

// Find a box by FourCC type within [start, end).
// Returns { start, end } of the box body (after the 8-byte header).
function findMp4Box(view, start, end, type) {
  let offset = start;
  while (offset < end - 8) {
    let size = view.getUint32(offset);
    const boxType = readFourCC(view, offset + 4);

    if (size === 0) size = end - offset; // box extends to end of parent
    if (size === 1) {
      // 64-bit largesize at offset+8 -- we don't fully support these,
      // bail rather than silently mis-parse.
      return null;
    }
    if (size < 8 || offset + size > end) break;

    if (boxType === type) {
      return { start: offset + 8, end: offset + size };
    }

    offset += size;
  }
  return null;
}

// `keys` box: version/flags(4) + entry_count(4) + entries.
// Each entry: key_size(4) + key_namespace(4) + key_name(key_size - 8).
function parseMp4Keys(view, buffer, start, end) {
  if (start + 8 > end) return [];

  const entryCount = view.getUint32(start + 4);
  const keyList = [];
  let offset = start + 8;

  for (let i = 0; i < entryCount && offset < end; i++) {
    if (offset + 8 > end) break;
    const keySize = view.getUint32(offset);
    if (keySize < 8 || offset + keySize > end) break;

    const name = decodeText(new Uint8Array(buffer, offset + 8, keySize - 8));
    keyList.push(name);
    offset += keySize;
  }

  return keyList;
}

// `ilst` box: items keyed by 1-based index into the keys list.
// Each item: size(4) + index(4) + "data" sub-box.
// Data sub-box: size(4) + "data"(4) + type_indicator(4) + locale(4) + value.
function parseMp4Ilst(view, buffer, start, end, keyList) {
  const chunks = [];
  let offset = start;

  while (offset < end - 8) {
    const size = view.getUint32(offset);
    const index = view.getUint32(offset + 4);

    if (size < 8 || offset + size > end) break;

    let sub = offset + 8;
    while (sub < offset + size - 8) {
      const subSize = view.getUint32(sub);
      const subType = readFourCC(view, sub + 4);

      if (subType === "data" && subSize > 16) {
        const valueStart = sub + 16;
        const valueLen = Math.min(subSize - 16, buffer.byteLength - valueStart);
        if (valueLen > 0) {
          const value = decodeText(new Uint8Array(buffer, valueStart, valueLen));
          if (index > 0 && index <= keyList.length) {
            chunks.push({
              keyword: keyList[index - 1],
              text: unwrapJson(value),
            });
          }
        }
      }

      if (subSize < 8) break;
      sub += subSize;
    }

    offset += size;
  }

  return chunks;
}

// --- Shared helpers ---------------------------------------------------

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
}

function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

// VHS double-encodes the Comfy "prompt" tag value as json.dumps(json.dumps(prompt)),
// so the on-disk string is `"{\"...\":...}"`. Unwrap one quoting layer if present.
function unwrapJson(str) {
  if (str.startsWith('"') || str.startsWith("'")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "string") return parsed;
    } catch { /* not double-encoded */ }
  }
  return str;
}

// --- Format dispatch --------------------------------------------------

function detectFormat(file) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/jpeg") return "jpeg";
  if (file.type === "image/webp") return "webp";
  if (file.type === "video/webm") return "webm";
  if (file.type === "video/mp4") return "mp4";

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "png";
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  if (ext === "webp") return "webp";
  if (ext === "webm") return "webm";
  if (ext === "mp4" || ext === "m4v" || ext === "mov") return "mp4";
  return null;
}

function extractChunks(buffer, format) {
  if (format === "png") return parsePngChunks(buffer);
  if (format === "jpeg") return parseJpegUserComment(buffer);
  if (format === "webp") return parseWebpChunks(buffer);
  if (format === "webm") return parseWebmTags(buffer);
  if (format === "mp4") return parseMp4Tags(buffer);
  return [];
}

const VIDEO_FORMATS = new Set(["webm", "mp4"]);

// --- A1111 "parameters" string parser --------------------------------
//
// Stable Diffusion WebUI writes a single "parameters" tEXt chunk with this shape:
//
//   <positive prompt>
//   Negative prompt: <negative prompt>
//   Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 512x512, ...
//
// We split it into positive / negative / a key-value settings map. The settings
// line uses comma separation but values may contain commas inside balanced
// brackets/braces/parens or quoted strings, so we tokenise manually.

function parseParametersString(text) {
  const result = { positive: "", negative: "", settings: [] };

  // Find the settings line -- last line that starts with a "Key: value" pair
  // and has multiple comma-separated entries. A1111 always emits a single
  // settings line at the end.
  const lines = text.split("\n");
  let settingsLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[A-Z][A-Za-z0-9 _-]*:\s/.test(lines[i]) && lines[i].includes(",")) {
      settingsLineIdx = i;
      break;
    }
  }

  let promptBlock;
  if (settingsLineIdx !== -1) {
    promptBlock = lines.slice(0, settingsLineIdx).join("\n");
    result.settings = parseSettingsLine(lines[settingsLineIdx]);
  } else {
    promptBlock = text;
  }

  // Split on first occurrence of "Negative prompt:" at start of line
  const negMatch = promptBlock.match(/(^|\n)Negative prompt:\s*/);
  if (negMatch) {
    const negStart = negMatch.index + negMatch[0].length;
    result.positive = promptBlock.slice(0, negMatch.index).trim();
    result.negative = promptBlock.slice(negStart).trim();
  } else {
    result.positive = promptBlock.trim();
  }

  return result;
}

function parseSettingsLine(line) {
  const settings = [];
  let depth = 0;
  let inQuote = null;
  let token = "";

  const flush = () => {
    const t = token.trim();
    token = "";
    if (!t) return;
    const colon = t.indexOf(":");
    if (colon === -1) return;
    const key = t.slice(0, colon).trim();
    const value = t.slice(colon + 1).trim();
    if (key) settings.push({ key, value });
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (inQuote) {
      token += c;
      if (c === inQuote && line[i - 1] !== "\\") inQuote = null;
      continue;
    }

    if (c === '"' || c === "'") {
      inQuote = c;
      token += c;
      continue;
    }

    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);

    if (c === "," && depth === 0) {
      flush();
      continue;
    }

    token += c;
  }
  flush();

  return settings;
}

// --- DOM rendering ----------------------------------------------------

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  placeholder: document.querySelector("[data-placeholder]"),
  previewImage: document.getElementById("preview-image"),
  previewVideo: document.getElementById("preview-video"),
  filename: document.getElementById("filename"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
};

let currentPreviewUrl = null;

function setStatus(message, kind) {
  els.status.textContent = message;
  els.status.classList.remove("is-error", "is-ok");
  if (kind === "error") els.status.classList.add("is-error");
  else if (kind === "ok") els.status.classList.add("is-ok");
}

function clearResults() {
  els.results.replaceChildren();
}

function setPreview(file, format) {
  if (currentPreviewUrl) {
    URL.revokeObjectURL(currentPreviewUrl);
    currentPreviewUrl = null;
  }
  currentPreviewUrl = URL.createObjectURL(file);

  const isVideo = VIDEO_FORMATS.has(format);
  const showEl = isVideo ? els.previewVideo : els.previewImage;
  const hideEl = isVideo ? els.previewImage : els.previewVideo;

  if (!hideEl.hidden) {
    if (hideEl.tagName === "VIDEO") {
      hideEl.pause();
      hideEl.removeAttribute("src");
      hideEl.load();
    } else {
      hideEl.removeAttribute("src");
    }
    hideEl.hidden = true;
  }

  showEl.src = currentPreviewUrl;
  if (!isVideo) showEl.alt = file.name;
  showEl.hidden = false;
  if (isVideo) showEl.load();

  els.placeholder.hidden = true;
  els.filename.textContent = `${file.name} * ${formatBytes(file.size)}`;
  els.filename.hidden = false;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (opts.on) {
    for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function copyButton(getText, label = "copy") {
  const btn = el("button", {
    class: "copy-btn",
    attrs: { type: "button", "aria-label": `Copy ${label}` },
    text: label,
  });
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "copied";
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("is-copied");
      }, 1200);
    } catch {
      btn.textContent = "failed";
      setTimeout(() => { btn.textContent = label; }, 1500);
    }
  });
  return btn;
}

function renderField(keyword, text, { inline = false } = {}) {
  return el("div", { class: `field${inline ? " field--inline" : ""}` }, [
    el("div", { class: "field__header" }, [
      el("span", { class: "field__key", text: keyword }),
      copyButton(() => text),
    ]),
    el("pre", { class: "field__value", text }),
  ]);
}

function renderSectionLabel(text) {
  return el("div", { class: "section-label", text });
}

function renderSettingsField(settings) {
  const grid = el("dl", { class: "kv-grid" });
  for (const { key, value } of settings) {
    grid.appendChild(el("dt", { text: key }));
    grid.appendChild(el("dd", { text: value }));
    grid.appendChild(copyButton(() => value, "copy"));
  }

  const allText = settings.map(s => `${s.key}: ${s.value}`).join(", ");
  return el("div", { class: "field" }, [
    el("div", { class: "field__header" }, [
      el("span", { class: "field__key", text: "settings" }),
      copyButton(() => allText, "copy all"),
    ]),
    grid,
  ]);
}

function renderParametersChunk(chunk) {
  // A1111-style "parameters" string -- split into positive/negative/settings.
  const parsed = parseParametersString(chunk.text);
  const nodes = [];

  nodes.push(renderSectionLabel("a1111 parameters"));

  if (parsed.positive) {
    nodes.push(renderField("positive prompt", parsed.positive));
  }
  if (parsed.negative) {
    nodes.push(renderField("negative prompt", parsed.negative));
  }
  if (parsed.settings.length > 0) {
    nodes.push(renderSettingsField(parsed.settings));
  }

  // Always include the raw chunk too -- gives the user a one-click "copy
  // everything" path that round-trips back into A1111/Forge UIs.
  nodes.push(renderField("parameters (raw)", chunk.text));

  return nodes;
}

function looksLikeJson(s) {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

function tryFormatJson(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return null;
  }
}

function renderChunk(chunk) {
  const key = chunk.keyword.toLowerCase();

  if (key === "parameters") {
    return renderParametersChunk(chunk);
  }

  // ComfyUI: `prompt` / `workflow` are JSON. Pretty-print but copy the original.
  if (looksLikeJson(chunk.text)) {
    const pretty = tryFormatJson(chunk.text);
    if (pretty) {
      const node = el("div", { class: "field" }, [
        el("div", { class: "field__header" }, [
          el("span", { class: "field__key", text: chunk.keyword }),
          copyButton(() => chunk.text, "copy"),
        ]),
        el("pre", { class: "field__value", text: pretty }),
      ]);
      return [node];
    }
  }

  return [renderField(chunk.keyword, chunk.text)];
}

function renderChunks(chunks) {
  clearResults();
  if (chunks.length === 0) {
    setStatus("No generation parameters found in this image.", "error");
    return;
  }
  setStatus(`Found ${chunks.length} ${chunks.length === 1 ? "field" : "fields"}.`, "ok");
  const frag = document.createDocumentFragment();
  for (const chunk of chunks) {
    for (const node of renderChunk(chunk)) frag.appendChild(node);
  }
  els.results.appendChild(frag);
}

// --- File handling ----------------------------------------------------

async function handleFile(file) {
  if (!file) return;

  const format = detectFormat(file);
  if (!format) {
    setStatus(`Unsupported file type: ${file.type || file.name}`, "error");
    return;
  }
  if (file.type && !ACCEPTED_TYPES.has(file.type)) {
    // Type mismatch but extension matched -- proceed with a notice
    setStatus(`Reading ${format.toUpperCase()} (declared type: ${file.type})...`);
  } else {
    setStatus(`Reading ${file.name}...`);
  }

  setPreview(file, format);
  clearResults();

  try {
    const buffer = await file.arrayBuffer();
    const chunks = extractChunks(buffer, format);
    renderChunks(chunks);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
  }
}

function pickAcceptedFile(items) {
  for (const item of items) {
    const file = item.kind === "file" ? item.getAsFile() : item;
    if (!file) continue;
    if (file.type && ACCEPTED_TYPES.has(file.type)) return file;
    const ext = file.name?.split(".").pop()?.toLowerCase();
    if (ext && ACCEPTED_EXTS.has(ext)) return file;
  }
  return null;
}

// --- Wire up events ---------------------------------------------------

let dragDepth = 0;

function isFileDrag(e) {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  els.dropzone.classList.add("is-dragover");
});

window.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropzone.classList.remove("is-dragover");
});

window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove("is-dragover");

  const file = e.dataTransfer.files[0]
    ? pickAcceptedFile(e.dataTransfer.files)
    : pickAcceptedFile(e.dataTransfer.items || []);
  if (file) handleFile(file);
  else setStatus("Drop a PNG, JPEG, WebP, WebM, or MP4 file.", "error");
});

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) handleFile(file);
  els.fileInput.value = ""; // allow re-selecting the same file
});

window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const file = pickAcceptedFile(items);
  if (file) {
    e.preventDefault();
    handleFile(file);
  }
});

// --- Pane splitter ----------------------------------------------------

(() => {
  const resizer = document.getElementById("resizer");
  const dropzone = document.getElementById("dropzone");
  const layout = document.querySelector(".layout");
  if (!resizer || !dropzone || !layout) return;

  const MIN_LEFT = 320;
  const MIN_RIGHT = 360;

  function clamp(width) {
    const layoutRect = layout.getBoundingClientRect();
    const padX = parseFloat(getComputedStyle(layout).paddingLeft) || 0;
    const padR = parseFloat(getComputedStyle(layout).paddingRight) || 0;
    const gap = parseFloat(getComputedStyle(layout).columnGap)
      || parseFloat(getComputedStyle(layout).gap) || 0;
    const available = layoutRect.width - padX - padR - gap - resizer.offsetWidth;
    const max = Math.max(MIN_LEFT, available - MIN_RIGHT);
    return Math.max(MIN_LEFT, Math.min(width, max));
  }

  function setWidth(px) {
    dropzone.style.width = `${clamp(px)}px`;
  }

  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("is-active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const layoutLeft = layout.getBoundingClientRect().left
      + (parseFloat(getComputedStyle(layout).paddingLeft) || 0);

    const onMove = (ev) => setWidth(ev.clientX - layoutLeft);

    const onEnd = (ev) => {
      try { resizer.releasePointerCapture(ev.pointerId); } catch {}
      resizer.classList.remove("is-active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onEnd);
      resizer.removeEventListener("pointercancel", onEnd);
    };

    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onEnd);
    resizer.addEventListener("pointercancel", onEnd);
  });

  // Keyboard: ArrowLeft/Right adjust width in 20px steps (40 with shift)
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 40 : 20) * (e.key === "ArrowLeft" ? -1 : 1);
    setWidth(dropzone.getBoundingClientRect().width + step);
  });

  // Reset to default split on double-click
  resizer.addEventListener("dblclick", () => {
    dropzone.style.width = "";
  });

  // Re-clamp on viewport resize so the panes don't end up out-of-bounds
  window.addEventListener("resize", () => {
    if (dropzone.style.width) {
      setWidth(dropzone.getBoundingClientRect().width);
    }
  });
})();
