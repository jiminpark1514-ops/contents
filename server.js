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

let progress = { running: false, phase: "대기", step: "", percent: 0, detail: "준비 완료", logs: [] };

function resetProgress() { progress = { running: true, phase: "준비", step: "시작", percent: 0, detail: "시작", logs: [], startedAt: Date.now() }; }
function setProgress(phase, step, percent, detail) {
  progress.phase = phase; progress.step = step; progress.percent = percent; progress.detail = detail;
  progress.logs.push({ time: new Date().toLocaleTimeString("ko-KR"), phase, step, percent, detail });
}

const contentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
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
        properties: { time: { type: "string" }, text: { type: "string" }, sourceSection: { type: "string" } },
        required: ["time", "text", "sourceSection"]
      }
    },
    hashtags: { type: "array", items: { type: "string" } }
  },
  required: ["title", "summary", "blogSections", "shorts", "hashtags"]
};

app.post("/api/generate", async (req, res) => {
  resetProgress();
  try {
    const { topic, style, length, sourceText, docs } = req.body;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `너는 독자의 시선을 단번에 사로잡는 '클릭베이트' 전문 블로그 에디터다.
주제: ${topic}
스타일: ${style} (매우 자극적이고, 속도감 있는 문체 사용, 독자의 호기심을 극대화할 것)
분량: ${length}

규칙:
1. 소제목(h2)은 독자가 클릭하지 않고는 못 배기게 아주 자극적으로 작성하고 <b> 태그로 강조할 것.
2. 문체는 간결하고 임팩트 있게 작성하며, 문단 사이사이에 강렬한 질문을 던질 것.
3. 이슈의 핵심을 관통하는 충격적인 반전 요소를 반드시 포함할 것.
4. 이미지가 배치될 곳에 내용을 작성하고, 이미지는 imageUrl을 사용하도록 JSON 구조를 유지할 것.

수정/참고 자료: ${sourceText}
`;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "content_maker_result", strict: true, schema: contentSchema } }
    });

    const data = JSON.parse(response.choices[0].message.content);
    
    // HTML 조립
    data.blog = (data.blogSections || []).map(s => {
      let content = `<h2><b>${s.heading}</b></h2>\n\n${s.body}\n\n`;
      return content;
    }).join("\n\n");

    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0");
