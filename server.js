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
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "content_maker.html")));

const contentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    factCheck: { type: "array", items: { type: "object", additionalProperties: false, properties: { claim: { type: "string" }, status: { type: "string" }, explanation: { type: "string" } }, required: ["claim", "status", "explanation"] } },
    blogSections: { type: "array", items: { type: "object", additionalProperties: false, properties: { sourceSection: { type: "string" }, heading: { type: "string" }, body: { type: "string" }, depth: { type: "integer" } }, required: ["sourceSection", "heading", "body", "depth"] } },
    shorts: { type: "array", items: { type: "object", additionalProperties: false, properties: { time: { type: "string" }, text: { type: "string" }, sourceSection: { type: "string" } }, required: ["time", "text", "sourceSection"] } },
    hashtags: { type: "array", items: { type: "string" } }
  },
  required: ["title", "summary", "factCheck", "blogSections", "shorts", "hashtags"]
};

app.post("/api/generate", async (req, res) => {
  try {
    const { topic, style, length, sourceText, docs } = req.body || {};
    
    // 유효성 검사 수정: sourceText가 비어있어도 docs가 있으면 통과, 
    // 혹은 둘 다 없으면 단순히 "내용을 입력해주세요"로 명확히 안내
    if (!sourceText?.trim() && (!Array.isArray(docs) || !docs.length)) {
      return res.status(400).json({ ok: false, error: "붙여넣은 내용이 없거나 검색된 자료가 없습니다." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000 });
    const prompt = `주제: ${topic}\n스타일: ${style}\n분량: ${length}\n\n내용:\n${sourceText || "(자료 없음)"}`;
    
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "content_maker_result", strict: true, schema: contentSchema } },
      max_tokens: 12000
    });

    const data = JSON.parse(response.choices[0].message.content);
    data.blog = (data.blogSections || []).map(s => `${s.heading}\n\n${s.body}`).join("\n\n");
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, apiKeyConfigured: !!process.env.OPENAI_API_KEY }));

app.listen(PORT, "0.0.0.0", () => console.log(`Server running at http://127.0.0.1:${PORT}`));
