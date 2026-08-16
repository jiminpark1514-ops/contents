import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IMAGE_DIR = path.join(__dirname, "collected_images");

await fs.mkdir(IMAGE_DIR, { recursive: true });

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));
app.use("/collected_images", express.static(IMAGE_DIR));

/* =========================================================
   진행상황
========================================================= */
let progress = {
  running: false,
  phase: "대기",
  step: "",
  percent: 0,
  detail: "준비 완료",
  logs: [],
  startedAt: null,
  updatedAt: null
};

function resetProgress() {
  progress = {
    running: true,
    phase: "준비",
    step: "시작",
    percent: 0,
    detail: "콘텐츠 생성 작업을 시작합니다.",
    logs: [],
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
}

function setProgress(phase, step, percent, detail) {
  progress.phase = phase;
  progress.step = step;
  progress.percent = Math.max(0, Math.min(100, Number(percent) || 0));
  progress.detail = detail || "";
  progress.updatedAt = Date.now();
  progress.logs.push({
    time: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
    phase,
    step,
    percent: progress.percent,
    detail: progress.detail
  });
  if (progress.logs.length > 80) progress.logs.shift();
  console.log(`[${phase}] ${step} ${progress.percent}% - ${progress.detail}`);
}

function finishProgress(ok, detail) {
  progress.running = false;
  progress.phase = ok ? "완료" : "오류";
  progress.step = ok ? "완료" : "중단";
  progress.percent = ok ? 100 : progress.percent;
  progress.detail = detail;
  progress.updatedAt = Date.now();
  progress.logs.push({
    time: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
    phase: progress.phase,
    step: progress.step,
    percent: progress.percent,
    detail
  });
}

/* =========================================================
   브라우저: 화면에 실제 Chrome 창을 표시
   ※ 로컬 PC에서 실행하면 Chrome 창이 눈에 보입니다.
   ※ Render 같은 서버 환경에서는 서버에 화면이 없으므로
      사용자의 PC 화면에 Chrome이 나타나지는 않습니다.
========================================================= */
let browser = null;
let page = null;

const BLOCKED_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "coupang.com",
  "coupangcdn.com",
  "gmarket.co.kr",
  "11st.co.kr",
  "auction.co.kr",
  "interpark.com",
  "shopping.naver.com"
];

const BLOCKED_URL_WORDS = [
  "/ads/",
  "/ad/",
  "adserver",
  "advertising",
  "banner",
  "sponsor"
];

function shouldBlockRequest(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const lower = url.toLowerCase();
    if (BLOCKED_HOSTS.some(h => host === h || host.endsWith("." + h))) return true;
    return BLOCKED_URL_WORDS.some(x => lower.includes(x));
  } catch {
    return false;
  }
}

async function getPage() {
  if (!browser) {
    setProgress("브라우저", "Chrome 창 시작", 3, "나무위키 접속 과정을 화면에 표시합니다.");
    browser = await chromium.launch({
      headless: false,
      args: [
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check"
      ]
    });
  }

  if (!page || page.isClosed()) {
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 }
    });

    await page.route("**/*", async route => {
      const request = route.request();
      if (shouldBlockRequest(request.url())) {
        await route.abort();
        return;
      }
      await route.continue();
    });

  }

  return page;
}

/* =========================================================
   광고 필터
========================================================= */
const AD_TEXT_PATTERNS = [
  /www\.coupang\.com/i,
  /coupang\.com/i,
  /와우회원혜택/i,
  /첫구매할인/i,
  /로켓배송/i,
  /로켓프레시/i,
  /무료배송/i,
  /쿠팡/i,
  /광고문의/i,
  /광고배너/i,
  /제휴광고/i
];

function isAdLine(line) {
  const s = String(line || "").replace(/\s+/g, " ").trim();
  if (!s) return false;

  const hits = AD_TEXT_PATTERNS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  if (/^https?:\/\//i.test(s) || /^www\./i.test(s)) return true;
  if (/^[\w.-]+\.(com|co\.kr|net|kr)(\/.*)?$/i.test(s)) return true;
  if (hits >= 2) return true;
  if (hits >= 1 && (s.length < 90 || /할인|혜택|배송|구매|무료/.test(s))) return true;
  return false;
}

function cleanAdText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x => x.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .filter(line => !isAdLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isYeoDam(title = "") {
  const t = String(title).toLowerCase().replace(/\s+/g, "");
  return t.includes("여담");
}

function absoluteUrl(src = "") {
  if (!src) return "";
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return "https://namu.wiki" + src;
  return src;
}

function isNamuImage(src = "") {
  const url = absoluteUrl(src);
  try {
    const u = new URL(url);
    return u.hostname === "i.namu.wiki" && u.pathname.startsWith("/i/");
  } catch {
    return false;
  }
}

function getImageExtension(contentType = "", url = "") {
  const type = contentType.toLowerCase();
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i);
    if (m) return "." + m[1].toLowerCase();
  } catch {}
  return ".jpg";
}

async function downloadImage(originalUrl, index, total) {
  if (!originalUrl || !isNamuImage(originalUrl)) return null;

  const url = absoluteUrl(originalUrl);
  const hash = crypto.createHash("sha1").update(url).digest("hex");

  try {
    const existingFiles = await fs.readdir(IMAGE_DIR);
    const existing = existingFiles.find(filename => filename.startsWith(hash + "."));
    if (existing) {
      setProgress("이미지", `이미지 ${index}/${total}`, 55 + Math.round((index / Math.max(total, 1)) * 15), `이미지 캐시 사용: ${existing}`);
      return { originalUrl: url, localUrl: `/collected_images/${existing}`, filename: existing };
    }
  } catch {}

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
        "Referer": "https://namu.wiki/",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      redirect: "follow"
    });

    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // 광고/오류 페이지가 image/*로 반환되는 경우도 있어 너무 작은 파일은 버린다.
    if (!buffer.length || buffer.length < 1024) return null;

    const ext = getImageExtension(contentType, url);
    const filename = hash + ext;
    await fs.writeFile(path.join(IMAGE_DIR, filename), buffer);

    setProgress("이미지", `이미지 ${index}/${total}`, 55 + Math.round((index / Math.max(total, 1)) * 15), `이미지 저장 완료: ${filename}`);
    return { originalUrl: url, localUrl: `/collected_images/${filename}`, filename };
  } catch (e) {
    setProgress("이미지", `이미지 ${index}/${total}`, 55 + Math.round((index / Math.max(total, 1)) * 15), `이미지 저장 실패(건너뜀): ${e.message}`);
    return null;
  }
}

async function downloadImages(images = []) {
  const result = [];
  const seen = new Set();
  const valid = images.filter(x => isNamuImage(x?.src || x?.url || ""));

  for (let i = 0; i < valid.length; i++) {
    const image = valid[i];
    const originalUrl = absoluteUrl(image.src || image.url || "");
    if (!originalUrl || seen.has(originalUrl)) continue;
    seen.add(originalUrl);

    const saved = await downloadImage(originalUrl, i + 1, valid.length);
    if (!saved) continue;

    result.push({
      originalUrl,
      localUrl: saved.localUrl,
      alt: image.alt || "",
      title: image.title || ""
    });
  }
  return result;
}

/* =========================================================
   문서 수집
========================================================= */
async function getSearchLinks(p) {
  return await p.locator('a[href^="/w/"]').evaluateAll(as =>
    as.map(a => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      title: a.getAttribute("title") || "",
      href: a.getAttribute("href") || ""
    })).filter(x => x.href && x.text)
  );
}

async function searchNamu(keyword, topic, keywordIndex, keywordTotal) {
  const p = await getPage();
  const base = 5 + Math.round(((keywordIndex - 1) / Math.max(keywordTotal, 1)) * 10);

  // 나무위키 검색창/검색버튼을 사용하지 않고
  // 입력한 검색어를 바로 문서 URL로 만들어 접속한다.
  // 예: 삼성전자 -> https://namu.wiki/w/삼성전자
  const cleanKeyword = String(keyword || "").trim();
  if (!cleanKeyword) {
    throw new Error("검색어가 비어 있습니다.");
  }

  const url = `https://namu.wiki/w/${encodeURIComponent(cleanKeyword)}`;

  setProgress(
    "문서 검색",
    `문서 ${keywordIndex}/${keywordTotal}`,
    base,
    `나무위키 문서 직접 접속: ${cleanKeyword}`
  );

  const response = await p.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  await p.waitForTimeout(1000);

  const status = response ? response.status() : 0;
  const finalUrl = p.url();
  const title = await p.title().catch(() => "");

  // HTTP 404이거나 오류 페이지인 경우 명확하게 알려준다.
  if (status === 404 || /(?:404|존재하지 않는 문서|문서를 찾을 수 없습니다)/i.test(title)) {
    throw new Error(
      `나무위키 문서를 찾지 못했습니다.\n검색어: ${cleanKeyword}\n접속 URL: ${url}\nHTTP: ${status || "확인불가"}`
    );
  }

  // 나무위키가 문서명으로 리다이렉트한 경우 최종 URL을 사용한다.
  if (!finalUrl.includes("/w/")) {
    throw new Error(
      `나무위키 문서 페이지로 이동하지 못했습니다.\n검색어: ${cleanKeyword}\n현재 URL: ${finalUrl}`
    );
  }

  const chosen = {
    text: cleanKeyword,
    title: title || cleanKeyword,
    href: finalUrl
  };

  setProgress(
    "문서 검색",
    `문서 선택 ${keywordIndex}/${keywordTotal}`,
    base + 5,
    `직접 접속한 문서: ${title || cleanKeyword}`
  );

  return {
    chosen,
    url: finalUrl
  };
}

async function extractDocument(p, keyword, chosen, url, keywordIndex, keywordTotal) {
  const base = 18 + Math.round(((keywordIndex - 1) / Math.max(keywordTotal, 1)) * 30);
  setProgress("본문 수집", `문서 ${keywordIndex}/${keywordTotal}`, base, `선택 문서로 이동: ${url}`);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await p.waitForTimeout(700);

  setProgress("본문 수집", `본문 정리 ${keywordIndex}/${keywordTotal}`, base + 3, "광고/배너/외부 쇼핑 영역을 DOM 단계에서 제거하는 중");

  const result = await p.evaluate(() => {
    function clean(value = "") {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function normalize(value = "") {
      return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[.:·•\-–—]/g, "").trim();
    }

    function isYeoDam(title = "") {
      return normalize(title).includes("여담");
    }

    const selectors = ["main", "article", "[role='main']"];
    let main = null;
    for (const s of selectors) {
      const x = document.querySelector(s);
      if (x && (x.innerText || "").trim().length > 200) { main = x; break; }
    }
    if (!main) main = document.body;

    const clone = main.cloneNode(true);
    clone.querySelectorAll([
      "script", "style", "noscript", "iframe", "ins", "canvas",
      "aside", "nav", "footer", "header",
      "[aria-label*='광고']", "[aria-label*='ad']",
      "[id*='ad-']", "[id*='-ad']", "[id^='ad']",
      "[class*='advert']", "[class*='ad-banner']", "[class*='adbox']",
      "[class*='sponsor']", "[class*='banner']"
    ].join(",")).forEach(el => el.remove());

    clone.querySelectorAll("a").forEach(a => {
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href) && !href.includes("namu.wiki")) {
        const txt = (a.innerText || "").trim();
        if (/쿠팡|와우|로켓|무료배송|할인|구매/i.test(txt) || /coupang\.com/i.test(href)) {
          a.remove();
        }
      }
    });

    const rawToc = [];
    const seen = new Set();
    clone.querySelectorAll('a[href^="#s-"]').forEach(a => {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("#s-")) return;
      const id = href.substring(1);
      if (!id || seen.has(id)) return;
      let title = clean(a.parentElement?.innerText || a.innerText || "").replace(/\s*\[편집\]\s*/g, " ").trim();
      if (!title) return;
      const m = title.match(/^(\d+(?:\.\d+)*)/);
      const number = m ? m[1] : "";
      const depth = number ? number.split(".").length : 1;
      rawToc.push({ id, title, number, depth });
      seen.add(id);
    });

    const toc = [];
    let yeoDamDepth = null;
    for (const item of rawToc) {
      if (isYeoDam(item.title)) {
        yeoDamDepth = item.depth;
        continue;
      }
      if (yeoDamDepth !== null) {
        if (item.depth > yeoDamDepth) continue;
        yeoDamDepth = null;
      }
      toc.push(item);
    }

    const sectionNodes = toc.map(item => ({ ...item, el: clone.querySelector(`#${CSS.escape(item.id)}`) })).filter(x => x.el);
    const allImages = [];
    const imageSeen = new Set();

    // 이미지 자체의 alt/title만 보는 것이 아니라
    // 이미지가 들어있는 링크/부모 영역의 텍스트까지 확인해 광고를 걸러낸다.
    function isBadImageContext(img) {
      const alt = clean(img.getAttribute("alt") || "");
      const title = clean(img.getAttribute("title") || "");
      const cls = String(img.className || "").toLowerCase();
      const parent = img.parentElement;
      const parentCls = String(parent?.className || "").toLowerCase();
      const parentText = clean(parent?.innerText || "");
      const grand = parent?.parentElement;
      const grandCls = String(grand?.className || "").toLowerCase();
      const grandText = clean(grand?.innerText || "");

      const combined = `${alt} ${title} ${cls} ${parentCls} ${grandCls} ${parentText} ${grandText}`;

      // 광고/쇼핑/UI 이미지
      if (/광고|배너|파워링크|쿠팡|와우회원|로켓배송|로켓프레시|무료배송|첫구매|할인|추천상품|상품구매|쇼핑|상세내용아이콘|상세내용|더보기아이콘|공유아이콘|아이콘/i.test(combined)) {
        return true;
      }

      // 광고 링크 또는 나무위키 외부 링크에 걸린 썸네일은 수집하지 않는다.
      const link = img.closest("a");
      const href = link?.getAttribute("href") || "";
      if (href && /^https?:\/\//i.test(href) && !/namu\.wiki/i.test(href)) return true;

      // 광고 영역으로 흔히 쓰이는 클래스/속성
      if (/advert|ad[-_]?banner|adbox|adsense|sponsor|powerlink|shopping|commerce|promotion|promo|affiliate/i.test(`${cls} ${parentCls} ${grandCls}`)) {
        return true;
      }

      // 이미지 주변 텍스트가 명백한 쇼핑 광고 문구인 경우
      if (/쿠팡|와우회원|로켓배송|무료배송|첫구매|할인|구매하기|광고|파워링크/i.test(`${parentText} ${grandText}`)) {
        return true;
      }

      return false;
    }

    clone.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
      if (!src) return;
      const absolute = src.startsWith("//") ? "https:" + src : src;
      if (!absolute.startsWith("https://i.namu.wiki/i/")) return;
      if (imageSeen.has(absolute)) return;
      if (isBadImageContext(img)) return;

      const width = Number(img.getAttribute("width") || 0);
      const height = Number(img.getAttribute("height") || 0);
      if (width && height && width < 100 && height < 70) return;

      // 작은 UI 아이콘/버튼 이미지는 제외한다.
      const role = String(img.getAttribute("role") || "").toLowerCase();
      if (role === "button" || img.closest("button")) return;

      imageSeen.add(absolute);
      allImages.push({
        src: absolute,
        alt: clean(img.getAttribute("alt") || ""),
        title: clean(img.getAttribute("title") || ""),
        element: img
      });
    });

    const sectionImages = new Map();
    for (const section of sectionNodes) sectionImages.set(section.id, []);

    for (const image of allImages) {
      let closest = null;
      for (const section of sectionNodes) {
        try {
          const position = section.el.compareDocumentPosition(image.element);
          if (position & Node.DOCUMENT_POSITION_FOLLOWING) closest = section;
        } catch {}
      }
      if (closest) sectionImages.get(closest.id).push({ src: image.src, alt: image.alt, title: image.title });
    }

    const sections = [];
    for (let i = 0; i < sectionNodes.length; i++) {
      const current = sectionNodes[i];
      const next = sectionNodes[i + 1];
      const range = document.createRange();
      range.setStartBefore(current.el);
      if (next) range.setEndBefore(next.el);
      else range.setEndAfter(clone.lastElementChild || clone);
      const fragment = range.cloneContents();
      const wrapper = document.createElement("div");
      wrapper.appendChild(fragment);
      wrapper.querySelectorAll("script,style,noscript,button,iframe,ins").forEach(x => x.remove());
      sections.push({
        id: current.id,
        number: current.number,
        title: current.title,
        depth: current.depth,
        text: clean(wrapper.innerText || ""),
        images: sectionImages.get(current.id) || []
      });
    }

    return {
      title: document.title,
      url: location.href,
      toc,
      sections,
      text: clean(clone.innerText || "")
    };
  });

  if (!result.text || result.text.length < 100) throw new Error(`문서 본문을 읽지 못했습니다: ${url}`);

  const before = result.text.length;
  result.text = cleanAdText(result.text);
  for (const section of result.sections) section.text = cleanAdText(section.text);

  const rawImages = [];
  for (const section of result.sections) {
    for (const image of section.images || []) rawImages.push(image);
  }

  setProgress("본문 수집", `목차 분석 ${keywordIndex}/${keywordTotal}`, base + 8, `여담 제외 후 목차 ${result.toc.length}개 발견 · 본문 ${before.toLocaleString()}자 → 광고 제거 후 ${result.text.length.toLocaleString()}자`);
  setProgress("이미지", `이미지 후보 ${keywordIndex}/${keywordTotal}`, base + 12, `나무위키 본문 이미지 후보 ${rawImages.length}개 확인`);

  const savedAll = await downloadImages(rawImages);
  const savedByOriginal = new Map(savedAll.map(x => [x.originalUrl, x]));

  for (const section of result.sections) {
    section.images = (section.images || [])
      .map(image => savedByOriginal.get(absoluteUrl(image.src)))
      .filter(Boolean);
  }

  const images = [];
  const seenImages = new Set();
  for (const section of result.sections) {
    for (const image of section.images) {
      if (seenImages.has(image.localUrl)) continue;
      seenImages.add(image.localUrl);
      images.push({ ...image, sectionNumber: section.number, sectionTitle: section.title, sectionId: section.id });
    }
  }

  return {
    keyword,
    selected: chosen,
    url: result.url,
    title: result.title,
    toc: result.toc,
    sections: result.sections,
    images,
    text: result.text.slice(0, 70000)
  };
}

async function namuResearch(keyword, topic, keywordIndex, keywordTotal) {
  const p = await getPage();
  const search = await searchNamu(keyword, topic, keywordIndex, keywordTotal);
  return await extractDocument(p, keyword, search.chosen, search.url, keywordIndex, keywordTotal);
}

function buildResearch(docs) {
  return docs.map(doc => {
    let output = `\n\n========== ${doc.keyword} ==========\n`;
    output += `문서 제목: ${doc.title}\n문서 URL: ${doc.url}\n`;
    output += "\n[전체 목차]\n";
    for (const toc of doc.toc || []) output += `${toc.number || ""} ${toc.title}\n`;
    output += "\n[목차별 원문]\n";
    for (const section of doc.sections || []) {
      output += `\n\n----- ${section.number || ""} ${section.title} -----\n${section.text || "(내용 없음)"}`;
    }
    return output;
  }).join("\n\n");
}

function normalizeSection(value = "") {
  return String(value || "").replace(/^s-/i, "").trim();
}

function normalize(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[.:·•\-–—]/g, "").trim();
}

function attachImages(data, docs) {
  const allImages = [];
  for (const doc of docs) {
    for (const section of doc.sections || []) {
      for (const image of section.images || []) {
        if (image.localUrl) allImages.push({ ...image, sectionNumber: section.number, sectionTitle: section.title, sectionId: section.id });
      }
    }
  }

  const used = new Set();
  function findImage(sourceSection, heading = "") {
    const source = normalizeSection(sourceSection);
    let found = allImages.find(image => !used.has(image.localUrl) && normalizeSection(image.sectionNumber) === source);
    if (!found && heading) {
      const h = normalize(heading);
      found = allImages.find(image => {
        if (used.has(image.localUrl)) return false;
        const title = normalize(image.sectionTitle);
        return title && (title.includes(h) || h.includes(title));
      });
    }
    if (found) used.add(found.localUrl);
    return found || null;
  }

  data.blogSections = Array.isArray(data.blogSections) ? data.blogSections : [];
  data.blogSections = data.blogSections.map(section => {
    const image = findImage(section.sourceSection, section.heading);
    return {
      ...section,
      body: String(section.body || "").trim(),
      imageUrl: image?.localUrl || null,
      imageOriginalUrl: image?.originalUrl || null
    };
  });

  data.shorts = Array.isArray(data.shorts) ? data.shorts : [];
  data.shorts = data.shorts.map(shot => {
    const image = findImage(shot.sourceSection, shot.text);
    return {
      ...shot,
      imageUrl: image?.localUrl || null,
      imageOriginalUrl: image?.originalUrl || null
    };
  });

  return { data, allImages };
}

/* =========================================================
   API
========================================================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, apiKeyConfigured: !!process.env.OPENAI_API_KEY, model: MODEL, headless: false, adFilter: true, visibleBrowser: true });
});

app.get("/api/progress", (req, res) => {
  res.json(progress);
});

app.post("/api/namu-search", async (req, res) => {
  resetProgress();
  try {
    const { keywords = [], topic = "논란" } = req.body || {};
    if (!Array.isArray(keywords) || !keywords.length) return res.status(400).json({ ok: false, error: "검색어를 입력해주세요." });

    const docs = [];
    const total = Math.min(keywords.length, 5);
    for (let i = 0; i < total; i++) {
      const keyword = String(keywords[i] || "").trim();
      if (!keyword) continue;
      docs.push(await namuResearch(keyword, topic, i + 1, total));
    }

    setProgress("수집 완료", "AI 입력자료 준비", 73, `문서 ${docs.length}개 · 전체 목차/본문/이미지 수집 완료. 광고와 여담은 제외했습니다.`);
    res.json({ ok: true, docs });
  } catch (e) {
    console.error("NAMU:", e);
    finishProgress(false, e.message || String(e));
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

const contentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    factCheck: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          status: { type: "string" },
          explanation: { type: "string" }
        },
        required: ["claim", "status", "explanation"]
      }
    },
    blogSections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceSection: { type: "string" },
          heading: { type: "string" },
          body: { type: "string" },
          depth: { type: "integer" }
        },
        required: ["sourceSection", "heading", "body", "depth"]
      }
    },
    shorts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          time: { type: "string" },
          text: { type: "string" },
          sourceSection: { type: "string" }
        },
        required: ["time", "text", "sourceSection"]
      }
    },
    hashtags: { type: "array", items: { type: "string" } }
  },
  required: ["title", "summary", "factCheck", "blogSections", "shorts", "hashtags"]
};

app.post("/api/generate", async (req, res) => {
  try {
    const { keywords = [], topic = "인물 소개", style = "흥미로운 스토리형", length = "보통", sourceText = "", docs = [] } = req.body || {};
    if (!keywords.length) return res.status(400).json({ ok: false, error: "검색어를 입력해주세요." });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY가 없습니다." });
    if (!Array.isArray(docs) || !docs.length) return res.status(400).json({ ok: false, error: "수집된 나무위키 자료가 없습니다." });

    setProgress("AI 작성", "자료 정리", 76, "수집된 전체 목차와 본문을 AI 입력자료로 묶는 중입니다.");
    const research = buildResearch(docs);
    setProgress("AI 작성", "프롬프트 구성", 78, `AI에 전달할 자료 ${research.length.toLocaleString()}자 · 세부 목차까지 포함`);

    const prompt = `너는 한국 연예·사회·역사 이슈 전문 콘텐츠 작가다.

검색어: ${keywords.join(", ")}
주제: ${topic}
스타일: ${style}
분량: ${length}

아래 수집자료를 바탕으로 블로그와 쇼츠를 작성하라.

규칙:
1. 자료에 없는 사실을 만들지 않는다.
2. 원본의 중요한 세부 목차와 사건을 임의로 생략하지 않는다.
3. 여담 목차는 사용하지 않는다.
4. 의혹/주장/반론은 사실과 구분한다.
5. 조상의 행적과 후손 개인의 행위를 동일시하지 않는다.
6. 블로그 각 section에는 원본 목차 번호를 sourceSection으로 기록한다.
7. 3.6, 5.1.1 같은 세부 목차도 중요한 내용이면 반드시 반영한다.
8. 이미지는 프로그램이 수집해서 연결하므로 imageUrl/imageQuery를 만들지 않는다.
9. 출력은 반드시 지정된 JSON 구조만 사용한다.

추가 자료:
${sourceText || "(없음)"}

수집자료:
${research}`;

    setProgress("AI 작성", "OpenAI 요청 중", 82, "구조화된 JSON 형식으로 블로그/쇼츠를 작성하고 있습니다. 화면은 멈춘 것이 아니라 AI 응답을 기다리는 중입니다.");

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 0 });
    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "content_maker_result",
          strict: true,
          schema: contentSchema
        }
      },
      max_output_tokens: 12000
    });

    setProgress("AI 작성", "AI 응답 수신", 91, "AI 응답을 받았습니다. JSON 구조를 검증하고 이미지 위치를 연결합니다.");
    const raw = (response.output_text || "").trim();
    if (!raw) throw new Error("AI가 빈 결과를 반환했습니다.");

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("AI 구조화 결과를 JSON으로 읽지 못했습니다. 다시 생성해주세요.");
    }

    setProgress("AI 작성", "이미지 연결", 95, "각 블로그 소제목과 가장 가까운 원문 이미지를 연결하는 중입니다.");
    const attached = attachImages(data, docs);
    data = attached.data;
    data.images = attached.allImages;
    data.blog = (data.blogSections || []).map(s => `${s.heading}\n\n${s.body}`).join("\n\n");
    data.namuSources = docs.map(doc => ({
      keyword: doc.keyword,
      title: doc.title,
      url: doc.url,
      selected: doc.selected,
      toc: doc.toc || [],
      sections: (doc.sections || []).map(section => ({
        id: section.id,
        number: section.number,
        title: section.title,
        depth: section.depth,
        textLength: (section.text || "").length,
        images: section.images || []
      })),
      images: doc.images || []
    }));

    finishProgress(true, `완료 · 블로그 ${data.blogSections.length}개 소제목 · 이미지 ${data.images.length}개 연결`);
    res.json({ ok: true, ...data });
  } catch (e) {
    console.error("AI:", e);
    finishProgress(false, e.message || String(e));
    res.status(500).json({ ok: false, error: e.message || String(e), status: e.status || null });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log(" CONTENT MAKER - HEADLESS");
  console.log(` http://127.0.0.1:${PORT}/content_maker.html`);
  console.log(` MODEL: ${MODEL}`);
  console.log(" 브라우저 창: 표시 안 함");
  console.log(" 광고 필터: ON");
  console.log(" 진행상황 API: /api/progress");
  console.log("==========================================");
});

async function shutdown() {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
