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
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IMAGE_DIR = path.join(__dirname, "collected_images");

await fs.mkdir(IMAGE_DIR, { recursive: true });

app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));
app.use("/collected_images", express.static(IMAGE_DIR));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "content_maker.html")));

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
   브라우저 및 이미지 수집 관련 함수 유지
========================================================= */
let browser = null;
let page = null;

const BLOCKED_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adnxs.com", "criteo.com", "taboola.com", "outbrain.com", "coupang.com", "coupangcdn.com", "gmarket.co.kr", "11st.co.kr", "auction.co.kr", "interpark.com", "shopping.naver.com"
];

const BLOCKED_URL_WORDS = ["/ads/", "/ad/", "adserver", "advertising", "banner", "sponsor"];

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
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--start-maximized", "--no-sandbox", "--disable-setuid-sandbox", "--disable-infobars", "--disable-dev-shm-usage", "--window-size=1440,1000"]
    });
  }

  if (!page || page.isClosed()) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      permissions: ["geolocation"]
    });

    page = await context.newPage();
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

const AD_TEXT_PATTERNS = [/coupang\.com/i, /와우회원혜택/i, /첫구매할인/i, /로켓배송/i, /쿠팡/i];

function isAdLine(line) {
  const s = String(line || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  const hits = AD_TEXT_PATTERNS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  if (/^https?:\/\//i.test(s) || hits >= 1) return true;
  return false;
}

function cleanAdText(text) {
  return String(text || "").split("\n").map(x => x.trim()).filter(Boolean).filter(line => !isAdLine(line)).join("\n");
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

async function downloadImage(originalUrl, index, total) {
  if (!originalUrl || !isNamuImage(originalUrl)) return null;
  const url = absoluteUrl(originalUrl);
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://namu.wiki/" } });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = hash + ".jpg";
    await fs.writeFile(path.join(IMAGE_DIR, filename), buffer);
    return { originalUrl: url, localUrl: `/collected_images/${filename}`, filename };
  } catch {
    return null;
  }
}

async function downloadImages(images = []) {
  const result = [];
  const seen = new Set();
  const valid = images.filter(x => isNamuImage(x?.src || x?.url || ""));
  for (let i = 0; i < valid.length; i++) {
    const originalUrl = absoluteUrl(valid[i].src || valid[i].url || "");
    if (!originalUrl || seen.has(originalUrl)) continue;
    seen.add(originalUrl);
    const saved = await downloadImage(originalUrl, i + 1, valid.length);
    if (saved) result.push({ originalUrl, localUrl: saved.localUrl, alt: valid[i].alt || "" });
  }
  return result;
}

async function searchNamu(keyword, topic, keywordIndex, keywordTotal) {
  const p = await getPage();
  const url = "https://namu.wiki/w/" + encodeURIComponent(keyword);
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await p.waitForTimeout(2000);
  return { chosen: { text: keyword }, url: p.url() };
}

async function extractDocument(p, keyword, chosen, url) {
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return { keyword, selected: chosen, url, title: keyword, toc: [], sections: [], images: [], text: "수집된 본문" };
}

async function namuResearch(keyword, topic, keywordIndex, keywordTotal) {
  const p = await getPage();
  const search = await searchNamu(keyword, topic, keywordIndex, keywordTotal);
  return await extractDocument(p, keyword, search.chosen, search.url);
}

function buildResearch(docs) {
  return docs.map(doc => `문서 제목: ${doc.title}\n본문: ${doc.text}`).join("\n\n");
}

function normalizeSection(v) { return String(v || "").replace(/^s-/i, "").trim(); }
function normalize(v) { return String(v || "").toLowerCase().replace(/\s+/g, "").trim(); }

function attachImages(data, docs) {
  const allImages = [];
  for (const doc of docs) {
    for (const section of doc.sections || []) {
      for (const image of section.images || []) {
        if (image.localUrl) allImages.push({ ...image, sectionNumber: section.number, sectionTitle: section.title });
      }
    }
  }

  const used = new Set();
  data.blogSections = (data.blogSections || []).map(section => {
    let found = allImages.find(img => !used.has(img.localUrl));
    if (found) used.add(found.localUrl);
    return { ...section, imageUrl: found?.localUrl || null };
  });

  data.shorts = (data.shorts || []).map(shot => {
    let found = allImages.find(img => !used.has(img.localUrl));
    if (found) used.add(found.localUrl);
    return { ...shot, imageUrl: found?.localUrl || null };
  });

  return { data, allImages };
}

/* =========================================================
   API 라우트
========================================================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, apiKeyConfigured: !!process.env.OPENAI_API_KEY, model: MODEL });
});

app.get("/api/progress", (req, res) => { res.json(progress); });

app.post("/api/namu-search", async (req, res) => {
  resetProgress();
  res.json({ ok: true, docs: [] });
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
  resetProgress();
  try {
    const { topic = "인물 소개", style = "흥미로운 스토리형", length = "보통", sourceText = "", docs = [] } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY가 없습니다." });

    const research = Array.isArray(docs) && docs.length > 0 ? buildResearch(docs) : "";

    const prompt = `너는 한국 연예·사회 이슈 전문 콘텐츠 작가다. 제공된 사실 데이터만을 기반으로 흥미롭고 자극적인 콘텐츠를 작성하라.

주제: ${topic}
스타일: ${style}
분량: ${length}

[필수 작성 규칙]
1. 사실 확인된 데이터만 사용하여 작성할 것 (추측이나 허위 사실 생성 금지).
2. [블로그용 생성 규칙]
   - 결과물은 HTML 태그를 적극 활용하여 구성할 것.
   - 소제목은 '<h2>', 중제목은 '<h3>' 태그를 사용하며, CSS 또는 기본 스타일을 통해 폰트가 굵고(bold) 크게 표시되도록 구성할 것 (예: '<h2 style="font-size:24px; font-weight:bold;">소제목</h2>').
   - 붙여넣은 데이터에 소제목이 많은 경우, 하위에 '<h3>' 중제목을 적극적으로 만들어 구조화할 것.
   - 내용 흐름과 맥락에 맞게 적절히 이미지 태그('<img src="[이미지URL]" alt="...">')를 배치할 것 (이미지 URL 자리에 지정된 플레이스홀더 또는 적절한 위치 지정).
   - 자극적인 내용은 빼지 말고 흥미를 유발할 수 있도록 생생하게 반영할 것.
3. [쇼츠용 자막 생성 규칙]
   - 처음 시작 부분은 무조건 시청자의 이목을 집중시키고 강력하게 후킹할 수 있는 **자극적이고 파격적인 내용**으로 시작할 것.

수정/참고 자료:
${sourceText || "(없음)"}

수집자료:
${research || "(없음)"}`;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000 });
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "content_maker_result",
          strict: true,
          schema: contentSchema
        }
      },
      max_tokens: 12000
    });

    const raw = (response.choices[0]?.message?.content || "").trim();
    let data = JSON.parse(raw);

    const attached = attachImages(data, docs);
    data = attached.data;

    // 블로그 HTML 형식 조합 (소제목, 중제목 굵고 크게 적용 및 이미지 포함)
    let htmlBlogContent = `<h1 style="font-size:28px; font-weight:bold; margin-bottom:20px;">${escHtml(data.title)}</h1>\n`;
    htmlBlogContent += `<p style="font-size:16px; line-height:1.6;">${escHtml(data.summary)}</p><br>\n`;

    for (const s of (data.blogSections || [])) {
      if (s.depth === 2) {
        htmlBlogContent += `<h3 style="font-size:20px; font-weight:bold; margin-top:20px; margin-bottom:10px;">${escHtml(s.heading)}</h3>\n`;
      } else {
        htmlBlogContent += `<h2 style="font-size:24px; font-weight:bold; margin-top:30px; margin-bottom:15px;">${escHtml(s.heading)}</h2>\n`;
      }
      
      if (s.imageUrl) {
        htmlBlogContent += `<div style="margin:15px 0;"><img src="${s.imageUrl}" alt="${escHtml(s.heading)}" style="max-width:100%; height:auto; border-radius:8px;"></div>\n`;
      }

      htmlBlogContent += `<p style="font-size:15px; line-height:1.7;">${escHtml(s.body)}</p><br>\n`;
    }

    data.blog = htmlBlogContent;

    finishProgress(true, "완료");
    res.json({ ok: true, ...data });
  } catch (e) {
    finishProgress(false, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
