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

let progress = { running: false, phase: "대기", step: "", percent: 0, detail: "준비 완료" };

function resetProgress() {
  progress = { running: true, phase: "준비", step: "시작", percent: 0, detail: "작업 시작" };
}

function finishProgress(ok, detail) {
  progress.running = false;
  progress.phase = ok ? "완료" : "오류";
  progress.detail = detail;
}

let browser = null;
let page = null;

const BLOCKED_HOSTS = ["doubleclick.net", "googlesyndication.com", "googleadservices.com", "coupang.com"];
function shouldBlockRequest(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return BLOCKED_HOSTS.some(h => host === h || host.endsWith("." + h));
  } catch { return false; }
}

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
  }
  if (!page || page.isClosed()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    await page.route("**/*", async route => {
      if (shouldBlockRequest(route.request().url())) { await route.abort(); return; }
      await route.continue();
    });
  }
  return page;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, apiKeyConfigured: !!process.env.OPENAI_API_KEY, model: MODEL });
});

app.get("/api/progress", (req, res) => { res.json(progress); });

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
    const { topic = "이슈 분석", style = "흥미로운 스토리형", length = "아주 길고 상세하게", sourceText = "" } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY가 없습니다." });
    }

    const prompt = `너는 파격적이고 자극적인 대중문화·역사 이슈 전문 스토리텔러다. 제공된 사실 데이터만을 기반으로 대중의 이목을 단숨에 사로잡을 수 있는 강렬하고 흥미진진한 콘텐츠를 작성하라.

주제: ${topic}
스타일: ${style}
분량 및 강도: ${length} (※ 절대 대충 쓰지 말고, 방대한 디테일과 사건의 내막을 낱낱이 파헤쳐 매우 길고 상세하게 작성할 것)

[필수 작성 규칙]
1. 사실 확인된 데이터만 철저히 기반으로 작성할 것 (환각 절대 금지). HTML 태그를 직접 텍스트 안에 넣지 말고 순수 텍스트로만 제목과 본문을 작성할 것.
2. [쇼츠용 자막 생성 규칙]
   - 절대로 짧거나 부실하게 작성하지 말고, 최소 5개 이상의 상세 타임라인 구간(예: 00:00, 00:30, 01:00 등)으로 나누어 길고 깊이 있게 작성할 것.
   - 초반 시작 부분(첫 타임라인)은 무조건 시청자의 뒤통수를 치거나 귀를 의심하게 만들 정도로 매우 자극적이고 파격적인 '충격 후킹 멘트'로 시작할 것. (예: "당신이 몰랐던 충격적인 진실...", "전 국민을 경악하게 만든 그날의 실체...")

수정/참고 자료:
${sourceText || "(없음)"}`;

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
    const data = JSON.parse(raw);

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
