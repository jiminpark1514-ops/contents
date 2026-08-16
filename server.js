import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { chromium } from "playwright";

const app=express();
const PORT=Number(process.env.PORT||3000);
const MODEL=process.env.OPENAI_MODEL||"gpt-5.6";

app.use(express.json({limit:"4mb"}));
app.use(express.static("."));

const progress={running:false,phase:"대기",step:"",percent:0,detail:"준비 완료",logs:[]};
function log(phase,detail,percent){progress.phase=phase;progress.detail=detail;if(percent!==undefined)progress.percent=percent;progress.logs.push({time:new Date().toLocaleTimeString("ko-KR",{hour12:false}),phase,detail});if(progress.logs.length>100)progress.logs=progress.logs.slice(-100);}
app.get("/api/progress",(req,res)=>{res.setHeader("Cache-Control","no-store");res.json(progress)});

let browser=null;
let page=null;

async function getPage(){
  if(!browser){
    browser=await chromium.launch({headless:String(process.env.NAMU_HEADLESS||"true").toLowerCase()!=="false"});
  }
  if(!page || page.isClosed()){
    page=await browser.newPage({viewport:{width:1400,height:900}});
  }
  return page;
}

async function namuResearch(keyword, topic){
  const p=await getPage();

  await p.goto("https://namu.wiki/w/%EB%82%98%EB%AC%B4%EC%9C%84%ED%82%A4:%EB%8C%80%EB%AC%B8",{
    waitUntil:"domcontentloaded",
    timeout:30000
  });

  const input=p.locator('input[type="search"][placeholder="여기에서 검색"]').first();
  await input.waitFor({state:"visible",timeout:15000});
  await input.fill(keyword);
  await input.press("Enter");

  // 동적 검색결과가 나타날 때까지 짧게 기다린다.
  await p.waitForTimeout(1500);

  // 검색 결과 링크가 실제 DOM에 나타날 때까지 기다린다.
  await p.locator('a[href^="/w/"]').first().waitFor({state:"visible",timeout:15000});

  const links=await p.locator('a[href^="/w/"]').evaluateAll(as=>as.map(a=>({
    text:(a.textContent||"").replace(/\s+/g," ").trim(),
    title:a.getAttribute("title")||"",
    href:a.getAttribute("href")||""
  })).filter(x=>x.href && x.text));

  const needle=(topic||"").trim();
  let candidates=links.filter(x=>{
    const s=(x.text+" "+x.title).toLowerCase();
    return needle && s.includes(needle.toLowerCase());
  });

  // 주제에 해당하는 링크가 없으면 '논란'을 검색어에 붙여 다시 검색한다.
  if(!candidates.length && needle){
    await input.fill(keyword+" "+needle);
    await input.press("Enter");
    await p.waitForTimeout(1500);
    const more=await p.locator('a[href^="/w/"]').evaluateAll(as=>as.map(a=>({
      text:(a.textContent||"").replace(/\s+/g," ").trim(),
      title:a.getAttribute("title")||"",
      href:a.getAttribute("href")||""
    })).filter(x=>x.href&&x.text));
    candidates=more.filter(x=>{
      const s=(x.text+" "+x.title).toLowerCase();
      return s.includes(needle.toLowerCase());
    });
  }

  if(!candidates.length){
    throw new Error(`'${keyword}' 검색결과에서 '${topic}'이 포함된 링크를 찾지 못했습니다.`);
  }

  // 가장 긴 제목/텍스트를 우선: "하영 친일파 가문 업적 소개 논란" 같은 결과를 선택
  candidates.sort((a,b)=>(b.text.length+b.title.length)-(a.text.length+a.title.length));
  const chosen=candidates[0];
  const url=new URL(chosen.href,"https://namu.wiki").href;

  await p.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
  await p.waitForTimeout(1000);

  const result=await p.evaluate(()=>{
    const selectors=["main","article","[role='main']"];
    let el=null;
    for(const s of selectors){
      const x=document.querySelector(s);
      if(x && (x.innerText||"").trim().length>200){el=x;break;}
    }
    if(!el)el=document.body;
    return {
      title:document.title,
      url:location.href,
      text:(el.innerText||"").replace(/\n{3,}/g,"\n\n").trim()
    };
  });

  if(!result.text || result.text.length<100){
    throw new Error(`문서 페이지는 열렸지만 본문을 읽지 못했습니다: ${url}`);
  }

  return {
    keyword,
    selected:chosen,
    url:result.url,
    title:result.title,
    text:result.text.slice(0,60000)
  };
}

app.get("/api/health",(req,res)=>{
  res.json({ok:true,apiKeyConfigured:!!process.env.OPENAI_API_KEY,model:MODEL});
});

app.post("/api/namu-search",async(req,res)=>{
  progress.running=true; progress.logs=[];
  try{
    log("준비","나무위키 자료 수집을 시작합니다.",3);
    const {keywords=[],topic="논란"}=req.body||{};
    if(!keywords.length)return res.status(400).json({ok:false,error:"검색어를 입력해주세요."});

    const docs=[];
    for(const keyword of keywords.slice(0,5)){
      docs.push(await namuResearch(keyword,topic));
    }
    log("수집 완료",`문서 ${docs.length}개 · 목차/본문 수집 완료`,35);
    res.json({ok:true,docs});
  }catch(e){
    log("오류",e.message||String(e),35);
    console.error("NAMU:",e);
    res.status(500).json({ok:false,error:e.message||String(e)});
  }
});

app.post("/api/generate",async(req,res)=>{
  progress.running=true;
  try{
    const {keywords=[],topic="인물 소개",style="흥미로운 스토리형",length="보통",sourceText="",docs=[]}=req.body||{};
    if(!keywords.length)return res.status(400).json({ok:false,error:"검색어를 입력해주세요."});
    if(!process.env.OPENAI_API_KEY)return res.status(500).json({ok:false,error:"OPENAI_API_KEY가 없습니다."});
    const research=docs.map(d=>`===== ${d.keyword} / ${d.title} =====\nURL: ${d.url}\n### 전체 목차\n${(d.toc||[]).map(x=>`${x.number}. ${x.title}`).join("\n")}\n### 본문\n${d.text}\n### 이미지\n${(d.images||[]).map((x,i)=>`${i+1}. ${x.src} | ${x.alt||""}`).join("\n")}`).join("\n\n");
    log("AI 작성","전체 목차와 세부 내용을 AI 입력자료로 구성합니다.",45);
    const prompt=`한국어 연예/이슈 전문 블로그 편집자다. 기본 스타일은 흥미로운 스토리형이다.\n검색어: ${keywords.join(", ")}\n주제: ${topic}\n분량: ${length}\n\n작성 규칙:\n- 제공된 자료에 없는 사실을 만들지 않는다.\n- "수집 문서에는", "나무위키에 따르면", "문서에는", "기재돼 있다", "서술됐다", "출처 및 검증 메모" 같은 메타 표현을 쓰지 않는다.\n- 사실로 보기 어렵거나 근거가 없는 내용은 결과에서 제외한다. 빈 목차를 억지로 채우지 않는다.\n- 의혹은 의혹으로 구분하되, 자료에 있는 구체적인 핵심 기록과 자극적인 대목을 빠뜨리지 않는다.\n- 조상의 행적과 후손 개인의 행동을 동일시하지 않는다.\n- 제목은 클릭을 부르는 강한 제목으로 작성한다.\n- 목차에서 하위 소목차가 2개 이상인 큰 항목은 별도의 중제목을 만들고, 그 아래 소목차를 각각 소제목으로 작성한다. 특히 3.1~3.11처럼 소목차가 많은 경우 중제목 1개 아래에 각 항목을 빠짐없이 다룬다.\n- blogSections의 type은 major(중제목) 또는 section(소제목)이다.\n- 각 소제목에는 구체적인 사건, 기록, 발언 등 핵심 내용을 충분히 담는다.\n- 관련 이미지가 제공되면 서로 다른 이미지로 연결한다.\n- 쇼츠는 0~35초 7구간이며 첫 구간은 강한 후킹, 중간에는 가장 충격적인 핵심 기록을 배치한다.\n- factCheck는 만들지 않는다.\n\nJSON만 반환:\n{"title":"제목","summary":"도입","blog":"완성된 블로그 본문","blogSections":[{"type":"major","heading":"중제목","body":"연결 문장","imageIndex":1},{"type":"section","heading":"소제목","body":"본문","imageIndex":2}],"shorts":[{"time":"0~3초","text":"후킹","imageIndex":1},{"time":"3~7초","text":"핵심","imageIndex":2},{"time":"7~12초","text":"핵심","imageIndex":3},{"time":"12~18초","text":"핵심","imageIndex":4},{"time":"18~24초","text":"핵심","imageIndex":5},{"time":"24~30초","text":"핵심","imageIndex":6},{"time":"30~35초","text":"마무리","imageIndex":7}],"hashtags":["#태그1","#태그2","#태그3","#태그4","#태그5"]}\n\n추가 자료:\n${sourceText||"(없음)"}\n\n나무위키 자료:\n${research}`;
    log("AI 작성","중제목·소제목 구조와 쇼츠 핵심 내용을 작성 중입니다.",55);
    const r=await new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:120000,maxRetries:0}).responses.create({model:MODEL,input:prompt});
    log("AI 작성","AI 응답을 받아 결과를 정리하고 있습니다.",82);
    let raw=(r.output_text||"").trim().replace(/^```json\s*/i,"").replace(/```$/i,"").trim();
    let data;try{data=JSON.parse(raw)}catch{const m=raw.match(/\{[\s\S]*\}/);if(!m)throw new Error("AI 결과 JSON 해석 실패");data=JSON.parse(m[0])}
    const imgs=docs.flatMap(d=>d.images||[]), used=new Set();
    function imageFor(n){const preferred=imgs[Math.max(0,Number(n||1)-1)];if(preferred&&!used.has(preferred.src)){used.add(preferred.src);return preferred.src}const next=imgs.find(x=>!used.has(x.src));if(next){used.add(next.src);return next.src}return ""}
    data.blogSections=(data.blogSections||[]).map(s=>({...s,imageUrl:imageFor(s.imageIndex)}));
    data.shorts=(data.shorts||[]).map(s=>({...s,imageUrl:imageFor(s.imageIndex)}));
    const esc=x=>String(x??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]));
    data.blogHtml=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.title)}</title><style>body{max-width:860px;margin:40px auto;padding:0 20px;font-family:Arial,'Noto Sans KR',sans-serif;line-height:1.9;color:#222}h1{font-size:34px;line-height:1.35}h2{font-size:28px;margin-top:48px;border-left:6px solid #222;padding-left:12px}h3{font-size:22px;margin-top:30px;font-weight:800}p{font-size:17px}img{display:block;max-width:100%;height:auto;margin:18px auto;border-radius:12px}</style></head><body><h1>${esc(data.title)}</h1><p>${esc(data.summary||"")}</p>${data.blogSections.map(s=>(s.type==="major"?`<h2>${esc(s.heading)}</h2>`:`<h3>${esc(s.heading)}</h3>`)+(s.imageUrl?`<img src="${esc(s.imageUrl)}" alt="${esc(s.heading)}">`:"")+`<p>${esc(s.body).replace(/\n/g,"<br>")}</p>`).join("")}</body></html>`;
    log("완료","블로그 HTML · 중제목/소제목 · 관련 이미지 · 쇼츠 생성 완료",100);
    res.json({ok:true,...data});
  }catch(e){console.error("AI:",e);log("오류",e.message||String(e),82);res.status(500).json({ok:false,error:e.message||String(e),status:e.status||null});}
  finally{progress.running=false;}
});

app.listen(PORT,"0.0.0.0",()=>console.log(`Content Maker Browser: http://127.0.0.1:${PORT}/content_maker.html`));

process.on("SIGINT",async()=>{if(browser)await browser.close();process.exit(0)});
