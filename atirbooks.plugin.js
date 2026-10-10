// Harbor eBook source plugin for مكتبة الأثير (atirbooks.com).
//
// This whole file runs as the body of a function that receives one argument named
// harbor. There is no DOM, no fetch, no storage. Reach the network only through
// harbor.http and parse HTML only through harbor.parseHtml.
//
// The site is a WordPress download library: books arrive as direct PDF editions
// ("الطبعة") hosted on the site's file host. Listings are HTML archive pages with
// 16 cards per page; every book page carries the metadata plus one download link
// per edition. Book ids are the slugs from /books/<slug>/.
//
// HTML selectors deliberately stick to the plain forms the example plugin uses
// (classes, tags, descendant and child combinators). The page's <main> wrapper and
// id selectors are never queried; the Book Info block is the first <section> of
// the page and the download block is the section that holds .download-link links,
// while author/genre links are classified in JS from their hrefs.
//
// content() is a best-effort PDF text extractor: many of the site's PDFs are
// image-only scans with no text layer at all, so on any failure (non-PDF link,
// image-only file, oversized file, missing sandbox APIs) content() falls back to
// returning the direct PDF link itself.

const BASE = "https://atirbooks.com";

const PAGE_SIZE = 16; // cards per archive page (/books/)

async function getDoc(path) {
  const res = await harbor.http(BASE + path, { responseType: "text" });
  if (!res.ok) throw new Error("http " + res.status + " for " + path);
  return harbor.parseHtml(res.body);
}

// Covers MUST be absolute http(s) or Harbor drops them.
function abs(url) {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

function cleanTitle(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

// Line-scoped "label : value" extraction for spans like "عدد مرات التحميل : 96233".
function fieldOf(text, label) {
  const m = new RegExp(label + "\\s*:\\s*([^\\n]+)").exec(text || "");
  return m ? m[1].trim() : undefined;
}

function numberOf(text, re) {
  const m = re.exec(text || "");
  return m ? Number(m[1].replace(/[^\d]/g, "")) : undefined;
}

// Harbor passes only tag IDs declared by tags(). Translate reserved IDs to the
// real GET parameters the /books/ archive supports: book_category (category slug),
// order_by ("popular" = most downloaded, empty = newest) and is_reference.
function listingPath(keyword, tagId, page) {
  const params = new URLSearchParams();
  // Default ordering: the popular tab sorts by downloads, search by newest.
  params.set("order_by", keyword ? "" : "popular");
  if (tagId?.startsWith("category:")) {
    params.set("book_category", tagId.slice("category:".length));
  }
  if (tagId === "type:reference") params.set("is_reference", "1");
  if (tagId === "sort:popular") params.set("order_by", "popular");
  if (tagId === "sort:latest") params.set("order_by", "");
  if (keyword) params.set("keyword", keyword);
  params.set("paged_books", String(page));
  return "/books/?" + params.toString();
}

function bookSlug(href) {
  const m = /\/books\/([^/?#]+)/.exec(href || "");
  return m ? m[1] : "";
}

function cardToSummary(el) {
  const link = el.querySelector("a[href*='/books/']");
  if (!link) return null;
  const id = bookSlug(link.attr("href"));
  if (!id) return null;
  const img = el.querySelector("img");
  const rawTitle =
    el.querySelector("h3 .title-category")?.text() ||
    img?.attr("alt") ||
    el.querySelector("h3 a")?.text() ||
    "";
  return {
    // The id is the book slug from its permalink, opaque to Harbor and handed
    // straight back to detail/chapters as /books/<id>/.
    id,
    title: cleanTitle(rawTitle),
    cover: abs(img?.attr("src")),
  };
}

// ---------------------------------------------------------------------------
// Best-effort PDF text extraction (pure JS, no libraries, no DOM).
//
// Pipeline: binary fetch via harbor.http -> quick rejects (non-PDF link,
// missing text layer, oversized) -> inflate every non-image/non-font stream
// with the built-in pure-JS inflater -> resolve font ToUnicode CMaps ->
// decode Tj/TJ strings per font -> assemble page text. Any failure returns
// null and content() falls back to the direct PDF link.
// ---------------------------------------------------------------------------

const PDF_MAX_BYTES = 40 * 1024 * 1024;
const PDF_MIN_TEXT_CHARS = 200;

function toLatin1(bytes) {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

// Pure-JS zlib/DEFLATE inflater (RFC1950/1951), used instead of any platform
// decompression API: it works in every sandbox and, unlike stream APIs that
// hard-fail on it, it simply stops at the final DEFLATE block when a PDF stream
// slice carries trailing junk (which /Length values and endstream padding often
// leave behind).
const INFLATE_MAX_OUT = 8 * 1024 * 1024;

function buildHuff(lengths, count) {
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) return null;
  }
  const offs = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Array(count);
  for (let i = 0; i < count; i++) symbols[i] = 0;
  for (let sym = 0; sym < count; sym++) {
    if (lengths[sym] !== 0) {
      symbols[offs[lengths[sym]]] = sym;
      offs[lengths[sym]] += 1;
    }
  }
  return { counts, symbols };
}

const INFLATE_FIXED_LIT = (function () {
  const lens = new Array(288);
  for (let i = 0; i < 288; i++) lens[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  return buildHuff(lens, 288);
})();

const INFLATE_FIXED_DIST = (function () {
  const lens = new Array(30);
  for (let i = 0; i < 30; i++) lens[i] = 5;
  return buildHuff(lens, 30);
})();

const LITLEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LITLEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function inflateRawBytes(bytes, start) {
  let out = new Uint8Array(65536);
  let outLen = 0;
  let pos = start;
  const n = bytes.length;
  let bitbuf = 0;
  let bitcnt = 0;

  function ensure(add) {
    if (outLen + add > out.length) {
      let cap = out.length;
      while (cap < outLen + add) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(out.subarray(0, outLen));
      out = next;
    }
  }
  function bit() {
    if (bitcnt === 0) {
      if (pos >= n) return -1;
      bitbuf = bytes[pos++];
      bitcnt = 8;
    }
    const b = bitbuf & 1;
    bitbuf >>>= 1;
    bitcnt -= 1;
    return b;
  }
  function bits(needCount) {
    let v = 0;
    for (let i = 0; i < needCount; i++) {
      const b = bit();
      if (b < 0) return -1;
      v += b << i;
    }
    return v;
  }
  function need(needCount) {
    const v = bits(needCount);
    if (v < 0) throw 0;
    return v;
  }
  function decode(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      const b = bit();
      if (b < 0) throw 0;
      code += b;
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw 0;
  }

  try {
    let last = 0;
    do {
      last = need(1);
      const type = need(2);
      if (type === 0) {
        bitbuf = 0;
        bitcnt = 0;
        if (pos + 4 > n) throw 0;
        const len = bytes[pos] + bytes[pos + 1] * 256;
        const nlen = bytes[pos + 2] + bytes[pos + 3] * 256;
        if ((len ^ 0xffff) !== nlen) throw 0;
        pos += 4;
        if (pos + len > n) throw 0;
        if (outLen + len > INFLATE_MAX_OUT) throw 0;
        ensure(len);
        out.set(bytes.subarray(pos, pos + len), outLen);
        outLen += len;
        pos += len;
      } else if (type === 1 || type === 2) {
        let litH = INFLATE_FIXED_LIT;
        let distH = INFLATE_FIXED_DIST;
        if (type === 2) {
          const hlit = need(5) + 257;
          const hdist = need(5) + 1;
          const hclen = need(4) + 4;
          if (hlit > 286 || hdist > 30) throw 0;
          const clen = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = need(3);
          const clenH = buildHuff(clen, 19);
          if (clenH == null) throw 0;
          const total = hlit + hdist;
          const lens = new Array(total);
          for (let i = 0; i < total; i++) lens[i] = 0;
          let i = 0;
          while (i < total) {
            const sym = decode(clenH);
            if (sym < 16) {
              lens[i++] = sym;
            } else if (sym === 16) {
              if (i === 0) throw 0;
              const prev = lens[i - 1];
              let rep = 3 + need(2);
              while (rep > 0 && i < total) {
                lens[i++] = prev;
                rep--;
              }
            } else if (sym === 17) {
              let rep = 3 + need(3);
              while (rep > 0 && i < total) {
                lens[i++] = 0;
                rep--;
              }
            } else {
              let rep = 11 + need(7);
              while (rep > 0 && i < total) {
                lens[i++] = 0;
                rep--;
              }
            }
          }
          if (lens[256] === 0) throw 0;
          const dlens = new Array(hdist);
          for (let j = 0; j < hdist; j++) dlens[j] = lens[hlit + j];
          litH = buildHuff(lens, hlit);
          distH = buildHuff(dlens, hdist);
          if (litH == null || distH == null) throw 0;
        }
        for (;;) {
          const sym = decode(litH);
          if (sym < 256) {
            if (outLen + 1 > INFLATE_MAX_OUT) throw 0;
            ensure(1);
            out[outLen++] = sym;
          } else if (sym === 256) {
            break;
          } else {
            const li = sym - 257;
            if (li >= 29) throw 0;
            const len = LITLEN_BASE[li] + need(LITLEN_EXTRA[li]);
            const dsym = decode(distH);
            if (dsym >= 30) throw 0;
            const dist = DIST_BASE[dsym] + need(DIST_EXTRA[dsym]);
            if (dist > outLen) throw 0;
            if (outLen + len > INFLATE_MAX_OUT) throw 0;
            ensure(len);
            let from = outLen - dist;
            for (let k = 0; k < len; k++) out[outLen++] = out[from++];
          }
        }
      } else {
        throw 0;
      }
    } while (last === 0);
    return out.subarray(0, outLen);
  } catch (e) {
    return null;
  }
}

function inflateZlibBytes(bytes) {
  if (bytes.length < 6) return null;
  if ((bytes[0] & 0x0f) === 8 && (bytes[0] * 256 + bytes[1]) % 31 === 0 && (bytes[1] & 0x20) === 0) {
    return inflateRawBytes(bytes, 2);
  }
  return inflateRawBytes(bytes, 0);
}

function parseObjectSpans(raw) {
  const spans = [];
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const id = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const bodyEnd = raw.indexOf("endobj", bodyStart);
    if (bodyEnd < 0) break;
    spans.push({ id, bodyStart, bodyEnd });
    re.lastIndex = bodyEnd + 6;
  }
  return spans;
}

// Find the font resource labels (/F1 -> font object) inside one object body.
function collectFontLabels(body, labelToFont) {
  const re = /\/Font\s*<<([\s\S]{0,4000}?)>>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const pair = /\/(\w+)\s+(\d+)\s+0\s+R/g;
    let p;
    while ((p = pair.exec(m[1])) !== null) {
      labelToFont[p[1]] = Number(p[2]);
    }
  }
}

// Objects compressed inside object streams appear only after inflation; their
// "N 0 obj << dict >>" entries are separated by the next obj marker.
function scanVirtualObjects(text, fontToCMap, labelToFont) {
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  let prev = null;
  while ((m = re.exec(text)) !== null) {
    if (prev) {
      applyObjectBody(text.slice(prev.start, m.index), prev.id, fontToCMap, labelToFont);
    }
    prev = { id: Number(m[1]), start: m.index + m[0].length };
  }
  if (prev) {
    applyObjectBody(
      text.slice(prev.start, Math.min(text.length, prev.start + 8192)),
      prev.id,
      fontToCMap,
      labelToFont,
    );
  }
}

function applyObjectBody(body, id, fontToCMap, labelToFont) {
  const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
  if (tu) fontToCMap[id] = Number(tu[1]);
  collectFontLabels(body, labelToFont);
}

function hexToUnicode(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const v = parseInt(clean.slice(i, i + 4), 16);
    if (!isNaN(v)) out += String.fromCharCode(v);
  }
  return out;
}

// ToUnicode CMaps map font codes to UTF-16BE text via bfchar/bfrange entries.
function parseCMap(text) {
  if (text.indexOf("beginbfchar") < 0 && text.indexOf("beginbfrange") < 0) return null;
  const entries = {};
  let codeLen = 0;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (cs) {
    const pair = cs[1].match(/<([0-9A-Fa-f]+)>/);
    if (pair) codeLen = pair[1].length / 2;
  }
  let m;
  const bcr = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bcr.exec(text)) !== null) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = re.exec(m[1])) !== null) {
      if (!codeLen) codeLen = p[1].length / 2;
      entries[parseInt(p[1], 16)] = hexToUnicode(p[2]);
    }
  }
  const brr = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = brr.exec(text)) !== null) {
    const re =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[((?:\s*<[0-9A-Fa-f]+>\s*)+)\])/g;
    let p;
    while ((p = re.exec(m[1])) !== null) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (!codeLen) codeLen = p[1].length / 2;
      if (hi - lo > 65535) continue;
      if (p[3] !== undefined) {
        if (p[3].length <= 4) {
          const base = parseInt(p[3], 16);
          for (let c = lo; c <= hi; c++) entries[c] = String.fromCharCode(base + (c - lo));
        } else {
          const dst = hexToUnicode(p[3]);
          for (let c = lo; c <= hi; c++) entries[c] = dst;
        }
      } else if (p[4] !== undefined) {
        const arr = p[4].match(/<([0-9A-Fa-f]+)>/g) || [];
        for (let c = lo; c <= hi; c++) {
          const i = c - lo;
          if (i < arr.length) entries[c] = hexToUnicode(arr[i]);
        }
      }
    }
  }
  if (!codeLen) codeLen = 2;
  return { codeLen: codeLen === 1 ? 1 : 2, entries };
}

// Tokenize a content stream: names, strings (literal with PDF escapes and
// nesting, or hex), numbers and bare operators. Dictionary delimiters (<< >>)
// and array brackets are skipped; their contents still tokenize.
function tokenizeContent(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") { i++; continue; }
    if (c === "[" || c === "]") { i++; continue; }
    if (c === "<" && text[i + 1] === "<") { i += 2; continue; }
    if (c === ">" && text[i + 1] === ">") { i += 2; continue; }
    if (c === "(") {
      let j = i + 1;
      let depth = 1;
      let str = "";
      while (j < n && depth > 0) {
        const ch = text[j];
        if (ch === "\\") {
          const nx = text[j + 1];
          if (nx === "n") { str += "\n"; j += 2; }
          else if (nx === "r") { str += "\r"; j += 2; }
          else if (nx === "t") { str += "\t"; j += 2; }
          else if (nx === "b") { str += "\b"; j += 2; }
          else if (nx === "f") { str += "\f"; j += 2; }
          else if (nx === "(") { str += "("; j += 2; }
          else if (nx === ")") { str += ")"; j += 2; }
          else if (nx === "\\") { str += "\\"; j += 2; }
          else if (nx === "\n") { j += 2; }
          else if (nx === "\r") { j += text[j + 2] === "\n" ? 3 : 2; }
          else if (nx >= "0" && nx <= "7") {
            let oct = "";
            let k = j + 1;
            while (k < n && oct.length < 3 && text[k] >= "0" && text[k] <= "7") {
              oct += text[k];
              k++;
            }
            str += String.fromCharCode(parseInt(oct, 8));
            j = k;
          } else { str += nx; j += 2; }
        } else if (ch === "(") { depth++; str += ch; j++; }
        else if (ch === ")") { depth--; if (depth > 0) str += ch; j++; }
        else { str += ch; j++; }
      }
      tokens.push({ t: "str", v: str, hex: false });
      i = j;
      continue;
    }
    if (c === "<") {
      let j = i + 1;
      let hex = "";
      while (j < n && text[j] !== ">") {
        const h = text[j];
        if ((h >= "0" && h <= "9") || (h >= "a" && h <= "f") || (h >= "A" && h <= "F") ||
            h === " " || h === "\n" || h === "\r" || h === "\t") {
          hex += h;
          j++;
        } else break;
      }
      tokens.push({ t: "str", v: hex, hex: true });
      i = j + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < n && !/[\s/<>\[\]()>]/.test(text[j])) j++;
      tokens.push({ t: "name", v: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === "-" || c === "+" || c === ".") {
      let j = i;
      while (j < n && ((text[j] >= "0" && text[j] <= "9") || text[j] === ".")) j++;
      if (j === i) {
        i++;
        continue;
      }
      const v = parseFloat(text.slice(i, j));
      if (!isNaN(v)) tokens.push({ t: "num", v });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !/[\s/<>\[\]()]/.test(text[j])) j++;
    if (j > i) tokens.push({ t: "op", v: text.slice(i, j) });
    i = j > i ? j : i + 1;
  }
  return tokens;
}

// ActualText (/Span <</ActualText <FEFF...>> BDC) carries logical-order
// UTF-16BE (with BOM); its glyphs inside the span are superseded.
function decodeActualText(tk) {
  if (tk.hex) {
    const s = hexToUnicode(tk.v);
    return s.indexOf("\uFEFF") === 0 ? s.slice(1) : s;
  }
  return tk.v;
}

// Walk the tokens: track the font (/F# size Tf), the text position (Tm sets
// the line start absolutely, Td/TD move it, T* steps one line), ActualText
// spans and every shown string. Returns positioned text records.
function interpretContent(tokens, cmapByLabel) {
  const records = [];
  let label = null;
  let size = 12;
  let lastName = null;
  const nums = [];
  const pending = [];
  const spans = [];
  let pendingActual = null;
  let lx = 0;
  let ly = 0;
  let cx = 0;
  let cy = 0;
  function emitPending() {
    const top = spans.length > 0 ? spans[spans.length - 1] : null;
    const inActual = top != null && top.actual != null;
    for (const tk of pending) {
      if (inActual) {
        if (top.x0 === undefined) { top.x0 = cx; top.y0 = cy; }
        continue;
      }
      const s = decodeOpString({ str: tk.v, hex: tk.hex }, cmapByLabel[label] || null);
      if (!s) continue;
      records.push({ x: cx, y: cy, s, label });
      cx += s.length * size * 0.5;
    }
    pending.length = 0;
  }
  for (const tk of tokens) {
    if (tk.t === "num") { nums.push(tk.v); continue; }
    if (tk.t === "name") { lastName = tk.v; continue; }
    if (tk.t === "str") {
      if (lastName === "ActualText") {
        pendingActual = tk;
        lastName = null;
      } else {
        pending.push(tk);
      }
      continue;
    }
    switch (tk.v) {
      case "Tf":
        if (lastName && nums.length >= 1) {
          label = lastName;
          size = nums[nums.length - 1];
        }
        lastName = null;
        nums.length = 0;
        break;
      case "Tm":
        if (nums.length >= 6) {
          lx = nums[nums.length - 2];
          ly = nums[nums.length - 1];
          cx = lx;
          cy = ly;
        }
        lastName = null;
        nums.length = 0;
        break;
      case "Td":
      case "TD":
        if (nums.length >= 2) {
          lx += nums[nums.length - 2];
          ly += nums[nums.length - 1];
          cx = lx;
          cy = ly;
        }
        lastName = null;
        nums.length = 0;
        break;
      case "T*":
        cy = ly - size * 1.25;
        cx = lx;
        lastName = null;
        nums.length = 0;
        break;
      case "Tj":
      case "TJ":
        emitPending();
        lastName = null;
        nums.length = 0;
        break;
      case "BDC":
      case "BMC":
        spans.push({ actual: pendingActual != null ? decodeActualText(pendingActual) : null });
        pendingActual = null;
        lastName = null;
        nums.length = 0;
        break;
      case "EMC":
        emitPending();
        if (spans.length > 0) {
          const sp = spans.pop();
          if (sp.actual != null && sp.actual.replace(/\s+/g, "") !== "") {
            records.push({
              x: sp.x0 !== undefined ? sp.x0 : cx,
              y: sp.y0 !== undefined ? sp.y0 : cy,
              s: sp.actual,
              label,
              actual: true,
            });
          }
        }
        lastName = null;
        nums.length = 0;
        break;
      default:
        lastName = null;
        nums.length = 0;
    }
  }
  emitPending();
  return records;
}

const MIRROR_PAIRS = {};
(function () {
  const pairs = ["()", "[]", "{}", "<>", "\u00ab\u00bb", "\u2039\u203a"];
  for (const p of pairs) {
    MIRROR_PAIRS[p[0]] = p[1];
    MIRROR_PAIRS[p[1]] = p[0];
  }
})();

function isArabicChar(s) {
  return /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s || "");
}

function isMarkChar(c) {
  const v = c.charCodeAt(0);
  return (
    (v >= 0x064b && v <= 0x065f) || v === 0x0670 ||
    (v >= 0x06d6 && v <= 0x06dc) || (v >= 0x06df && v <= 0x06e8) ||
    (v >= 0x06ea && v <= 0x06ed)
  );
}

// Visual (left-to-right) glyph order -> logical order: reverse the string,
// mirror paired brackets/quotes, then restore LTR runs (Latin letters, digits,
// Arabic-Indic digits) that the visual reversal broke.
function visualToLogical(s) {
  if (!isArabicChar(s)) return s;
  const arr = s.split("");
  arr.reverse();
  for (let i = 0; i < arr.length; i++) {
    const m = MIRROR_PAIRS[arr[i]];
    if (m) arr[i] = m;
  }
  let i = 0;
  while (i < arr.length) {
    const c = arr[i];
    if (/[A-Za-z0-9]/.test(c) || (c >= "\u0660" && c <= "\u0669")) {
      let j = i;
      while (j < arr.length) {
        const d = arr[j];
        if (/[A-Za-z0-9@._:/+~&#-]/.test(d) || (d >= "\u0660" && d <= "\u0669")) j++;
        else break;
      }
      if (j - i >= 2) {
        const run = arr.slice(i, j).reverse();
        for (let k = 0; k < run.length; k++) arr[i + k] = run[k];
      }
      i = j;
    } else i++;
  }
  return arr.join("");
}

// After visual->logical reversal a combining mark lands before its base
// letter; swap each mark back onto the letter that follows it.
function fixDiacritics(s) {
  if (s.length < 2) return s;
  const arr = s.split("");
  for (let i = 0; i + 1 < arr.length; i++) {
    if (isMarkChar(arr[i]) && !isMarkChar(arr[i + 1])) {
      const tmp = arr[i];
      arr[i] = arr[i + 1];
      arr[i + 1] = tmp;
      i++;
    }
  }
  return arr.join("");
}

let PRESENTATION_MAP = null;

// Fold Arabic presentation forms (shaped glyphs, lam-alef ligatures, ...) to
// base letters, built once from NFKC when the sandbox has String.normalize.
function normalizePresentation(s) {
  if (PRESENTATION_MAP === null) {
    PRESENTATION_MAP = {};
    if (typeof String.prototype.normalize === "function") {
      const ranges = [
        [0xfb50, 0xfdff],
        [0xfe70, 0xfeff],
      ];
      for (let a = 0; a < ranges.length; a++) {
        for (let c = ranges[a][0]; c <= ranges[a][1]; c++) {
          const ch = String.fromCharCode(c);
          const norm = ch.normalize("NFKC");
          if (norm !== ch) PRESENTATION_MAP[ch] = norm;
        }
      }
    }
  }
  if (!s) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const m = PRESENTATION_MAP[ch];
    out += m !== undefined ? m : ch;
  }
  return out;
}

// A glyph string repeated at the same x on five or more distinct lines of the
// same page (content stream) is a decorative column, not text.
function dropOrnaments(records) {
  const hits = {};
  for (const r of records) {
    const key = (r.label || "?") + "|" + Math.round(r.x) + "|" + r.s;
    if (!hits[key]) hits[key] = {};
    hits[key][Math.round(r.y)] = true;
  }
  const out = [];
  for (const r of records) {
    const key = (r.label || "?") + "|" + Math.round(r.x) + "|" + r.s;
    if (Object.keys(hits[key]).length >= 5) continue;
    out.push(r);
  }
  return out;
}

// Group positioned records into lines by y (stream order kept within a line),
// then rebuild each line's reading order. Word-generated RTL pages emit glyph
// chunks in visual order (left-to-right, x positions increasing): such lines
// are reversed wholesale and every raw glyph string is flipped back to
// logical form with LTR runs protected. Lines whose x positions clearly move
// right-to-left are already logical and stay as emitted. ActualText records
// are logical Unicode either way and only follow the line's order.
function assembleRecords(records) {
  records.sort((a, b) => a.y - b.y);
  const lines = [];
  let line = null;
  for (const r of records) {
    if (!line || Math.abs(r.y - line.y) > 30) {
      line = { y: r.y, items: [r] };
      lines.push(line);
    } else {
      line.items.push(r);
    }
  }
  const out = [];
  for (const ln of lines) {
    const rtl = ln.items.some((r) => isArabicChar(r.s));
    if (!rtl) {
      let text = "";
      for (const it of ln.items) text += normalizePresentation(it.s);
      out.push(text);
      continue;
    }
    let increasing = 0;
    let decreasing = 0;
    for (let i = 1; i < ln.items.length; i++) {
      const dx = ln.items[i].x - ln.items[i - 1].x;
      if (dx > 1) increasing++;
      else if (dx < -1) decreasing++;
    }
    const visual = increasing >= decreasing;
    const items = visual ? ln.items.slice().reverse() : ln.items;
    let text = "";
    for (const it of items) {
      if (it.actual) text += it.s;
      else if (visual) text += fixDiacritics(visualToLogical(normalizePresentation(it.s)));
      else text += normalizePresentation(it.s);
    }
    out.push(text);
  }
  return out.join("\n");
}

function isCommonTextChar(v) {
  return (
    v === 9 || v === 10 || v === 13 || (v >= 32 && v <= 126) ||
    (v >= 0x0600 && v <= 0x06ff) || (v >= 0x0750 && v <= 0x077f) ||
    (v >= 0x08a0 && v <= 0x08ff) || (v >= 0xa0 && v <= 0x24f) ||
    (v >= 0xfb50 && v <= 0xfdff) || (v >= 0xfe70 && v <= 0xfeff)
  );
}

// Decode one string operand through its font's ToUnicode map; without a map,
// prefer UTF-16BE when the byte pairs look like text, else single bytes.
function decodeOpString(op, cmap) {
  let bytes;
  if (op.hex) {
    const clean = op.str.replace(/\s+/g, "");
    if (clean.length < 2 || clean.length % 2 !== 0) return "";
    bytes = new Array(clean.length / 2);
    for (let b = 0; b < bytes.length; b++) {
      bytes[b] = parseInt(clean.slice(b * 2, b * 2 + 2), 16);
    }
  } else {
    bytes = new Array(op.str.length);
    for (let b = 0; b < op.str.length; b++) {
      bytes[b] = op.str.charCodeAt(b) & 0xff;
    }
  }
  if (cmap && cmap.entries) {
    let out = "";
    if (cmap.codeLen === 1) {
      for (let i = 0; i < bytes.length; i++) {
        const v = cmap.entries[bytes[i]];
        if (v !== undefined) out += v;
      }
    } else {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const v = cmap.entries[bytes[i] * 256 + bytes[i + 1]];
        if (v !== undefined) out += v;
      }
    }
    return out;
  }
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let u = "";
    let common = 0;
    const units = bytes.length / 2;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const v = bytes[i] * 256 + bytes[i + 1];
      u += String.fromCharCode(v);
      if (isCommonTextChar(v)) common++;
    }
    if (common * 5 >= units * 3) return u;
  }
  let latin = "";
  for (let i = 0; i < bytes.length; i++) latin += String.fromCharCode(bytes[i]);
  return latin;
}

async function pdfExtractText(bytes) {
  const raw = toLatin1(bytes);
  // No ToUnicode maps and no embedded fonts anywhere: the file draws images
  // and/or unmapped custom encodings, there is no recoverable text.
  if (raw.indexOf("/ToUnicode") < 0 && raw.indexOf("/FontFile") < 0) return null;

  const objects = parseObjectSpans(raw);
  const objById = {};
  for (const o of objects) objById[o.id] = o;

  // Font program streams (/FontFile, /FontFile2, /FontFile3 refs) hold binary
  // tables that never contain page text; skip them by object id.
  const fontStreamIds = {};
  const ffRe = /\/FontFile[23]?\s+(\d+)\s+0\s+R/g;
  for (const o of objects) {
    let fm;
    while ((fm = ffRe.exec(raw.slice(o.bodyStart, o.bodyEnd))) !== null) {
      fontStreamIds[Number(fm[1])] = true;
    }
  }

  const regions = [];
  const sre = /stream\r?\n/g;
  let sm;
  while ((sm = sre.exec(raw)) !== null) {
    if (raw.slice(sm.index - 3, sm.index) === "end") continue;
    const start = sm.index + sm[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    if (end - start >= 2 && end - start <= 3 * 1024 * 1024) {
      let obj = null;
      for (const o of objects) {
        if (start >= o.bodyStart && start < o.bodyEnd) { obj = o; break; }
      }
      regions.push({ start, end, obj });
    }
    sre.lastIndex = end + 9;
  }

  const streamTexts = [];
  for (const r of regions) {
    const dict = r.obj ? raw.slice(r.obj.bodyStart, r.start) : "";
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    if (r.obj && fontStreamIds[r.obj.id]) continue;
    let text;
    if (/FlateDecode/.test(dict)) {
      const out = inflateZlibBytes(bytes.subarray(r.start, r.end));
      if (out == null) continue;
      text = toLatin1(out);
    } else {
      text = raw.slice(r.start, r.end);
    }
    streamTexts.push({ objId: r.obj ? r.obj.id : null, text });
  }

  const labelToFont = {};
  const fontToCMap = {};
  const fontRefIds = [];
  for (const o of objects) {
    const body = raw.slice(o.bodyStart, o.bodyEnd);
    applyObjectBody(body, o.id, fontToCMap, labelToFont);
    const ref = /\/Font\s+(\d+)\s+0\s+R/.exec(body);
    if (ref) fontRefIds.push(Number(ref[1]));
  }
  for (const e of streamTexts) {
    scanVirtualObjects(e.text, fontToCMap, labelToFont);
  }
  for (const refId of fontRefIds) {
    const t = objById[refId];
    if (t) collectFontLabels(raw.slice(t.bodyStart, t.bodyEnd), labelToFont);
  }

  const streamTextById = {};
  for (const e of streamTexts) {
    if (e.objId != null && streamTextById[e.objId] == null) streamTextById[e.objId] = e.text;
  }
  const cmapByLabel = {};
  for (const label of Object.keys(labelToFont)) {
    const tuId = fontToCMap[labelToFont[label]];
    if (tuId == null) continue;
    const cmapText = streamTextById[tuId];
    if (cmapText) {
      const map = parseCMap(cmapText);
      if (map) cmapByLabel[label] = map;
    }
  }

  const outTexts = [];
  for (const e of streamTexts) {
    const t = e.text;
    if (t.indexOf("BT") < 0 || t.indexOf("Tf") < 0) continue;
    let records = null;
    try {
      records = interpretContent(tokenizeContent(t), cmapByLabel);
    } catch (err) {
      continue;
    }
    // A real page content stream sets a font (/F# ... Tf) before showing any
    // text; binary junk that merely contains the letters BT/Tf does not.
    let sawFont = false;
    for (const r of records) {
      if (r.label != null) {
        sawFont = true;
        break;
      }
    }
    if (!sawFont) continue;
    const kept = dropOrnaments(records);
    if (kept.length === 0) continue;
    try {
      outTexts.push(assembleRecords(kept));
    } catch (err) {
      continue;
    }
  }
  const all = outTexts.join("\n");
  const text = all
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text || null;
}

// Binary PDF fetch. harbor.http may return an ArrayBuffer, a typed array or a
// (hopefully latin1-decoded) string; anything else -> null -> link fallback.
async function fetchPdfBytes(url) {
  const res = await harbor.http(url, { responseType: "arraybuffer" });
  if (!res || !res.ok || !res.body) return null;
  const body = res.body;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (body && typeof body.byteLength === "number") {
    if (body instanceof Uint8Array) return body;
    return new Uint8Array(body.buffer || body, body.byteOffset || 0, body.byteLength);
  }
  if (typeof body === "string") {
    if (body.indexOf("%PDF-") !== 0) return null;
    const out = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

// Returns extracted text, or null when the chapter should stay a plain link.
async function pdfChapterText(url) {
  // Only direct PDF files can carry a text layer; the archive.org viewer pages
  // some editions use stay links.
  if (!/^https?:\/\/.+\.pdf(\?|$)/i.test(url)) return null;
  let bytes = null;
  try {
    bytes = await fetchPdfBytes(url);
  } catch (e) {
    return null;
  }
  if (bytes == null || bytes.length < 8 || bytes.length > PDF_MAX_BYTES) return null;
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) return null;
  let text = null;
  try {
    text = await pdfExtractText(bytes);
  } catch (e) {
    return null;
  }
  if (text == null) return null;
  if (text.replace(/\s+/g, "").length < PDF_MIN_TEXT_CHARS) return null;
  return text;
}

const plugin = {
  // id must match the manifest id in repo.json.
  id: "atirbooks",
  name: "مكتبة الأثير",

  // offset is an item offset (0, 16, 32, ...). tagId is set when the user filters.
  async popular(offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const doc = await getDoc(listingPath(null, tagId, page));
    return doc.querySelectorAll(".card-books-template").map(cardToSummary).filter(Boolean);
  },

  async search(query, offset, tagId) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const doc = await getDoc(listingPath(query, tagId, page));
    return doc.querySelectorAll(".card-books-template").map(cardToSummary).filter(Boolean);
  },

  async detail(id) {
    const doc = await getDoc("/books/" + id + "/");
    const sections = doc.querySelectorAll("section");
    if (sections.length === 0) return null;

    // The first section of the page is the Book Info card; the page's only
    // "flex-1" div is its metadata block.
    const info = sections[0].querySelector(".flex-1") || sections[0];
    const infoText = info.text();

    // The download block is the section holding the edition download links.
    let section = null;
    for (const s of sections) {
      if (s.querySelector(".download-link")) { section = s; break; }
    }
    const sectionText = section ? section.text() : "";
    const description = section?.querySelector(".short-desc")?.text().trim() || "";
    const publisher = fieldOf(sectionText, "الناشر");
    const parts = numberOf(sectionText, /عدد الأجزاء\s*:\s*(\d+)/);
    const downloads = numberOf(infoText, /عدد مرات التحميل\s*:\s*([\d.,،]+)/);
    const added = fieldOf(infoText, "تاريخ الاضافة");

    // Author and genre links classified in JS: plain selectors only.
    let author;
    const genres = [];
    for (const a of info.querySelectorAll("a")) {
      const href = a.attr("href") || "";
      const label = cleanTitle(a.text());
      if (!label) continue;
      if (author == null && href.indexOf("/authors/") !== -1) author = label;
      else if (href.indexOf("/books-category/") !== -1 && genres.indexOf(label) < 0) {
        genres.push(label);
      }
    }

    // The site exposes no status/rating/ISBN metadata; fold its book-level facts
    // into a description footer instead of inventing fields.
    const extras = [
      publisher && "الناشر: " + publisher,
      parts != null && "عدد الأجزاء: " + parts,
      downloads != null && "عدد مرات التحميل: " + downloads,
      added && "تاريخ الاضافة: " + added,
    ].filter(Boolean);

    return {
      id,
      title: cleanTitle(info.querySelector("h2")?.text() || doc.querySelector("h1")?.text() || id),
      cover: abs(sections[0].querySelector("img")?.attr("src")),
      author: author || undefined,
      description: [description, ...extras].filter(Boolean).join("\n"),
      genres,
      // Each download edition (الطبعة) counts as one chapter entry.
      chapters: section ? section.querySelectorAll(".download-link").length || undefined : undefined,
      // عدد الأجزاء is the edition's explicit part count.
      volumes: parts,
      originalLanguage: "ar",
    };
  },

  // The site serves each book as direct PDF editions, not web pages of prose, so
  // every download edition (الطبعة) is one chapter and its id IS the direct PDF
  // URL on the site's file host.
  async chapters(id) {
    const doc = await getDoc("/books/" + id + "/");
    const sections = doc.querySelectorAll("section");
    let section = null;
    for (const s of sections) {
      if (s.querySelector(".download-link")) { section = s; break; }
    }
    if (!section) return [];
    let cards = section.querySelectorAll(".grid > div");
    const linksOnly = cards.length === 0;
    if (linksOnly) cards = section.querySelectorAll(".download-link");
    const entries = [];
    for (const card of cards) {
      const link = linksOnly ? card : card.querySelector("a.download-link");
      const url = link?.attr("href") || link?.attr("data-url") || "";
      if (!/^https?:\/\//i.test(url)) continue;
      const cardText = linksOnly ? section.text() : card.text();
      const publisher = fieldOf(cardText, "الناشر");
      const parts = numberOf(cardText, /عدد الأجزاء\s*:\s*(\d+)/);
      const bits = ["تحميل الطبعة"];
      if (publisher) bits.push("الناشر: " + publisher);
      if (parts != null) bits.push("عدد الأجزاء: " + parts);
      entries.push({
        id: url,
        chapter: String(entries.length + 1),
        // Zero-based reading position.
        position: entries.length,
        title: bits.join(" — "),
        // The site exposes no per-edition volume index.
        volume: undefined,
        pages: 0,
        language: "ar",
      });
    }
    return entries;
  },

  // chapterId is the edition's direct PDF URL encoded by chapters() above.
  // Best effort: extract readable text from the PDF (image-only scans and any
  // failure fall back to the direct link).
  async content(chapterId) {
    let text = null;
    try {
      text = await pdfChapterText(chapterId);
    } catch (e) {
      text = null;
    }
    return text != null ? text : chapterId;
  },

  // Native filters the /books/ archive actually supports: the full category list
  // is read live from the archive's own filter form, plus its two sort modes and
  // its "reference books only" toggle.
  async tags() {
    const doc = await getDoc("/books/");
    const categories = doc
      .querySelectorAll("select[name='book_category'] option")
      .map((o) => ({
        id: "category:" + (o.attr("value") || ""),
        name: cleanTitle(o.text()),
        group: "التصنيف",
      }))
      .filter((t) => t.id !== "category:" && t.name);
    return [
      { id: "sort:popular", name: "الأكثر تحميلاً", group: "الترتيب" },
      { id: "sort:latest", name: "الأحدث", group: "الترتيب" },
      { id: "type:reference", name: "أمهات الكتب فقط", group: "نوع الكتاب" },
      ...categories,
    ];
  },
};
