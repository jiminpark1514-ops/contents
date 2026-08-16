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

function finishProgress(ok, detail) {
  progress.running = false;
  progress.phase = ok ? "완료" : "오류";
  progress.step = ok ? "완료" : "중단";
  progress.percent = ok ? 100 : progress.percent;
  progress.detail = detail;
  progress.updatedAt = Date.now();
}

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

function buildResearch(docs) {
  return docs.map(doc => `문서 제목: ${doc.title}\n본문: ${doc.text}`).join("\n\n");
}

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
    const { topic = "이슈 분석", style = "흥미로운 스토리형", length = "매우 길고 상세하게", sourceText = "", docs = [] } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY가 없습니다." });
    }

    const research = Array.isArray(docs) && docs.length > 0 ? buildResearch(docs) : "";

    const prompt = `너는 파격적이고 자극적인 대중문화·역사 이슈 전문 스토리텔러다. 제공된 사실 데이터를 기반으로 대중의 이목을 단숨에 사로잡을 수 있는 강렬하고 흥미진진한 콘텐츠를 작성하라.

주제: ${topic}
스타일: ${style}
분량 및 강도: ${length} (※ 절대 대충 쓰지 말고, 방대한 디테일과 사건의 내막을 낱낱이 파헤쳐 매우 길고 상세하게 작성할 것)

[필수 작성 규칙]
1. 사실 확인된 데이터만 철저히 기반으로 작성할 것 (환각 절대 금지).
2. [블로그용 생성 규칙]
   - 각 섹션마다 분량을 매우 길고 풍부하게 작성할 것.
   - 텍스트 코드가 아니라 실제 HTML 태그('<H2>', '<H3>', '<P>')로 즉시 웹에서 렌더링될 수 있도록 마크업 구조를 완벽히 갖출 것.
   - 굵고 큰 폰트 스타일(예: style="font-size:24px; font-weight:bold;")을 명확히 지정할 것.
3. [쇼츠용 자막 생성 규칙]
   - **절대로 짧거나 부실하게 작성하지 말고, 최소 5개 이상의 상세 타임라인 구간으로 나누어 길고 깊이 있게 작성할 것.**
   - **초반 시작 부분(첫 타임라인)은 무조건 시청자의 뒤통수를 치거나 귀를 의심하게 만들 정도로 매우 자극적이고 파격적인 '충격 후킹 멘트'로 시작할 것.** (예: "당신이 몰랐던 충격적인 진실...", "전 국민을 경악하게 만든 그날의 실체...")
   - 숨겨진 내막, 논란의 핵심, 대중의 비판 등 자극적이고 흥미로운 포인트를 생생한 구어체 대본으로 풀어낼 것.

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

    // 블로그 HTML 조합 (프론트에서 innerHTML을 통해 렌더링된 모습으로 바로 보이도록 구성)
    let htmlBlogContent = `<div style="font-family: 'Noto Sans KR', Arial, sans-serif; color: #20242b; padding: 10px;">`;
    htmlBlogContent += `<h1 style="font-size:30px; font-weight:bold; margin-bottom:20px; line-height:1.3; color:#111;">${escHtml(data.title)}</h1>\n`;
    htmlBlogContent += `<p style="font-size:16px; line-height:1.7; margin-bottom:25px; color:#444; background:#f9fafc; padding:15px; border-left:4px solid #20242b; border-radius:4px;">${escHtml(data.summary)}</p><hr style="border:0; border-top:1px solid #e3e7ed; margin:20px 0;">\n`;

    for (const s of (data.blogSections || [])) {
      if (s.depth === 2) {
        htmlBlogContent += `<h3 style="font-size:20px; font-weight:bold; margin-top:24px; margin-bottom:12px; color:#222;">${escHtml(s.heading)}</h3>\n`;
      } else {
        htmlBlogContent += `<h2 style="font-size:25px; font-weight:bold; margin-top:35px; margin-bottom:15px; color:#000;">${escHtml(s.heading)}</h2>\n`;
      }
      
      if (s.imageUrl) {
        htmlBlogContent += `<div style="margin:20px 0; text-align:center;"><img src="${s.imageUrl}" alt="${escHtml(s.heading)}" style="max-width:100%; height:auto; border-radius:10px; box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>\n`;
      }

      htmlBlogContent += `<p style="font-size:16px; line-height:1.8; margin-bottom:20px; color:#333;">${escHtml(s.body)}</p>\n`;
    }
    htmlBlogContent += `</div>`;

    data.blog = htmlBlogContent;

    finishProgress(true, "완료");
    res.json({ ok: true, ...data });
  } catch (e) {
    finishProgress(false, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use("/api/*", (req, res) => {
  res.status(404).json({ ok: false, error: "존재하지 않는 API 경로입니다." });
});

function escHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
