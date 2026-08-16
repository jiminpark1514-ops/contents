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
const MODEL =
  process.env.OPENAI_MODEL ||
  "gpt-5.6";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const IMAGE_DIR =
  path.join(
    __dirname,
    "collected_images"
  );

await fs.mkdir(
  IMAGE_DIR,
  { recursive: true }
);

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.static(__dirname)
);

app.use(
  "/collected_images",
  express.static(IMAGE_DIR)
);

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "content_maker.html"
    )
  );
});

/* =========================================================
   PROGRESS
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
    detail:
      "콘텐츠 생성 작업을 시작합니다.",
    logs: [],
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
}

function setProgress(
  phase,
  step,
  percent,
  detail
) {
  progress.phase = phase;
  progress.step = step;

  progress.percent = Math.max(
    0,
    Math.min(
      100,
      Number(percent) || 0
    )
  );

  progress.detail =
    detail || "";

  progress.updatedAt =
    Date.now();

  progress.logs.push({
    time:
      new Date().toLocaleTimeString(
        "ko-KR",
        { hour12: false }
      ),
    phase,
    step,
    percent:
      progress.percent,
    detail:
      progress.detail
  });

  if (
    progress.logs.length > 100
  ) {
    progress.logs.shift();
  }

  console.log(
    `[${phase}] ${step} ${progress.percent}% - ${progress.detail}`
  );
}

function finishProgress(
  ok,
  detail
) {
  progress.running = false;

  progress.phase =
    ok ? "완료" : "오류";

  progress.step =
    ok ? "완료" : "중단";

  if (ok) {
    progress.percent = 100;
  }

  progress.detail =
    detail || "";

  progress.updatedAt =
    Date.now();

  progress.logs.push({
    time:
      new Date().toLocaleTimeString(
        "ko-KR",
        { hour12: false }
      ),
    phase:
      progress.phase,
    step:
      progress.step,
    percent:
      progress.percent,
    detail:
      progress.detail
  });
}

/* =========================================================
   BROWSER
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

function shouldBlockRequest(
  url
) {
  try {
    const u =
      new URL(url);

    const host =
      u.hostname.toLowerCase();

    const lower =
      url.toLowerCase();

    if (
      BLOCKED_HOSTS.some(
        h =>
          host === h ||
          host.endsWith("." + h)
      )
    ) {
      return true;
    }

    return BLOCKED_URL_WORDS.some(
      word =>
        lower.includes(word)
    );
  } catch {
    return false;
  }
}

async function getPage() {
  if (!browser) {
    setProgress(
      "브라우저",
      "초기화",
      3,
      "나무위키 수집용 Chromium을 창 없이 시작합니다."
    );

    browser =
      await chromium.launch({
        headless: true,

        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage"
        ]
      });
  }

  if (
    !page ||
    page.isClosed()
  ) {
    page =
      await browser.newPage({
        viewport: {
          width: 1440,
          height: 1000
        },

        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/151.0.0.0 Safari/537.36"
      });

    await page.route(
      "**/*",
      async route => {
        const request =
          route.request();

        if (
          shouldBlockRequest(
            request.url()
          )
        ) {
          await route.abort();
          return;
        }

        await route.continue();
      }
    );

    await page.addInitScript(
      () => {
        Object.defineProperty(
          navigator,
          "webdriver",
          {
            get: () =>
              undefined
          }
        );

        Object.defineProperty(
          navigator,
          "languages",
          {
            get: () => [
              "ko-KR",
              "ko",
              "en-US",
              "en"
            ]
          }
        );

        Object.defineProperty(
          navigator,
          "platform",
          {
            get: () =>
              "Win32"
          }
        );
      }
    );
  }

  return page;
}

/* =========================================================
   AD FILTER
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
  /제휴광고/i,
  /파워링크/i
];

function isAdLine(
  line
) {
  const s =
    String(line || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!s) {
    return false;
  }

  const hits =
    AD_TEXT_PATTERNS.reduce(
      (count, re) =>
        count +
        (re.test(s) ? 1 : 0),
      0
    );

  if (
    /^https?:\/\//i.test(s) ||
    /^www\./i.test(s)
  ) {
    return true;
  }

  if (
    /^[\w.-]+\.(com|co\.kr|net|kr)(\/.*)?$/i.test(
      s
    )
  ) {
    return true;
  }

  if (hits >= 2) {
    return true;
  }

  if (
    hits >= 1 &&
    (
      s.length < 90 ||
      /할인|혜택|배송|구매|무료/.test(
        s
      )
    )
  ) {
    return true;
  }

  return false;
}

function cleanAdText(
  text
) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(x =>
      x
        .replace(
          /\u00a0/g,
          " "
        )
        .replace(
          /[ \t]+/g,
          " "
        )
        .trim()
    )
    .filter(Boolean)
    .filter(
      line =>
        !isAdLine(line)
    )
    .join("\n")
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

function isYeoDam(
  title = ""
) {
  return String(title)
    .toLowerCase()
    .replace(/\s+/g, "")
    .includes("여담");
}

function absoluteUrl(
  src = ""
) {
  if (!src) {
    return "";
  }

  if (
    src.startsWith("//")
  ) {
    return "https:" + src;
  }

  if (
    src.startsWith("/")
  ) {
    return (
      "https://namu.wiki" +
      src
    );
  }

  return src;
}

function isNamuImage(
  src = ""
) {
  const url =
    absoluteUrl(src);

  try {
    const u =
      new URL(url);

    return (
      u.hostname ===
        "i.namu.wiki" &&
      u.pathname.startsWith(
        "/i/"
      )
    );
  } catch {
    return false;
  }
}

function getImageExtension(
  contentType = "",
  url = ""
) {
  const type =
    contentType.toLowerCase();

  if (
    type.includes("png")
  ) {
    return ".png";
  }

  if (
    type.includes("webp")
  ) {
    return ".webp";
  }

  if (
    type.includes("gif")
  ) {
    return ".gif";
  }

  if (
    type.includes("jpeg") ||
    type.includes("jpg")
  ) {
    return ".jpg";
  }

  try {
    const pathname =
      new URL(url)
        .pathname;

    const match =
      pathname.match(
        /\.(jpg|jpeg|png|webp|gif)$/i
      );

    if (match) {
      return (
        "." +
        match[1].toLowerCase()
      );
    }
  } catch {}

  return ".jpg";
}

async function downloadImage(
  originalUrl,
  index,
  total
) {
  if (
    !originalUrl ||
    !isNamuImage(
      originalUrl
    )
  ) {
    return null;
  }

  const url =
    absoluteUrl(
      originalUrl
    );

  const hash =
    crypto
      .createHash("sha1")
      .update(url)
      .digest("hex");

  try {
    const files =
      await fs.readdir(
        IMAGE_DIR
      );

    const existing =
      files.find(
        filename =>
          filename.startsWith(
            hash + "."
          )
      );

    if (existing) {
      setProgress(
        "이미지",
        `이미지 ${index}/${total}`,
        55 +
          Math.round(
            (index /
              Math.max(
                total,
                1
              )) *
              15
          ),
        `이미지 캐시 사용: ${existing}`
      );

      return {
        originalUrl: url,
        localUrl:
          `/collected_images/${existing}`,
        filename:
          existing
      };
    }
  } catch {}

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 " +
              "Chrome/151.0.0.0 Safari/537.36",

            Referer:
              "https://namu.wiki/",

            Accept:
              "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
          },

          redirect:
            "follow"
        }
      );

    if (!response.ok) {
      return null;
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (
      !contentType
        .toLowerCase()
        .startsWith(
          "image/"
        )
    ) {
      return null;
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      !buffer.length ||
      buffer.length < 1024
    ) {
      return null;
    }

    const ext =
      getImageExtension(
        contentType,
        url
      );

    const filename =
      hash + ext;

    await fs.writeFile(
      path.join(
        IMAGE_DIR,
        filename
      ),
      buffer
    );

    setProgress(
      "이미지",
      `이미지 ${index}/${total}`,
      55 +
        Math.round(
          (index /
            Math.max(
              total,
              1
            )) *
            15
        ),
      `이미지 저장 완료: ${filename}`
    );

    return {
      originalUrl: url,
      localUrl:
        `/collected_images/${filename}`,
      filename
    };
  } catch (error) {
    setProgress(
      "이미지",
      `이미지 ${index}/${total}`,
      55 +
        Math.round(
          (index /
            Math.max(
              total,
              1
            )) *
            15
        ),
      `이미지 저장 실패(건너뜀): ${error.message}`
    );

    return null;
  }
}

async function downloadImages(
  images = []
) {
  const result = [];
  const seen =
    new Set();

  const valid =
    images.filter(
      image =>
        isNamuImage(
          image?.src ||
            image?.url ||
            ""
        )
    );

  for (
    let i = 0;
    i < valid.length;
    i++
  ) {
    const image =
      valid[i];

    const originalUrl =
      absoluteUrl(
        image.src ||
          image.url ||
          ""
      );

    if (
      !originalUrl ||
      seen.has(
        originalUrl
      )
    ) {
      continue;
    }

    seen.add(
      originalUrl
    );

    const saved =
      await downloadImage(
        originalUrl,
        i + 1,
        valid.length
      );

    if (!saved) {
      continue;
    }

    result.push({
      originalUrl,
      localUrl:
        saved.localUrl,
      alt:
        image.alt || "",
      title:
        image.title || ""
    });
  }

  return result;
}

/* =========================================================
   SEARCH
   나무위키 대문 → 실제 검색창 → 검색 버튼
========================================================= */

async function getSearchLinks(
  p
) {
  return await p
    .locator(
      'a[href^="/w/"]'
    )
    .evaluateAll(
      links =>
        links
          .map(a => ({
            text:
              (
                a.textContent ||
                ""
              )
                .replace(
                  /\s+/g,
                  " "
                )
                .trim(),

            title:
              a.getAttribute(
                "title"
              ) || "",

            href:
              a.getAttribute(
                "href"
              ) || ""
          }))
          .filter(
            x =>
              x.href &&
              x.text
          )
    );
}

async function searchNamu(
  keyword,
  topic,
  keywordIndex,
  keywordTotal
) {
  const p =
    await getPage();

  const base =
    5 +
    Math.round(
      ((keywordIndex - 1) /
        Math.max(
          keywordTotal,
          1
        )) *
        10
    );

  setProgress(
    "문서 검색",
    `검색어 ${keywordIndex}/${keywordTotal}`,
    base,
    `나무위키 대문에서 검색창에 검색어를 입력합니다: ${keyword}`
  );

  await p.goto(
    "https://namu.wiki/w/%EB%82%98%EB%AC%B4%EC%9C%84%ED%82%A4:%EB%8C%80%EB%AC%B8",
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        30000
    }
  );

  /*
    여기서 반드시 실제 나무위키 검색창을 사용한다.
  */

  const searchInput =
    p.locator(
      'input[type="search"][placeholder="여기에서 검색"]'
    ).first();

  await searchInput.waitFor({
    state: "visible",
    timeout: 30000
  });

  setProgress(
    "문서 검색",
    `검색어 입력 ${keywordIndex}/${keywordTotal}`,
    base + 1,
    `나무위키 검색창에 '${keyword}' 입력 중`
  );

  await searchInput.fill(
    keyword
  );

  const searchButton =
    p.locator(
      'a[title="검색"]'
    ).first();

  await searchButton.waitFor({
    state: "visible",
    timeout: 15000
  });

  setProgress(
    "문서 검색",
    `검색 실행 ${keywordIndex}/${keywordTotal}`,
    base + 2,
    `나무위키 검색 버튼을 클릭합니다: ${keyword}`
  );

  await searchButton.click();

  await p
    .waitForLoadState(
      "domcontentloaded",
      {
        timeout:
          20000
      }
    )
    .catch(
      () => {}
    );

  await p.waitForTimeout(
    1000
  );

  setProgress(
    "문서 검색",
    `검색결과 분석 ${keywordIndex}/${keywordTotal}`,
    base + 3,
    `검색 결과 링크를 추출하고 광고/외부 링크를 제외하는 중: ${keyword}`
  );

  let links =
    await getSearchLinks(
      p
    );

  const needle =
    String(topic || "")
      .trim()
      .toLowerCase();

  const key =
    String(keyword)
      .trim()
      .toLowerCase();

  links =
    links.filter(
      x => {
        const text =
          (
            x.text +
            " " +
            x.title
          ).toLowerCase();

        return (
          !isAdLine(
            x.text
          ) &&
          text.includes(
            key
          )
        );
      }
    );

  let candidates =
    links.filter(
      x => {
        const text =
          (
            x.text +
            " " +
            x.title
          ).toLowerCase();

        return (
          needle &&
          text.includes(
            needle
          )
        );
      }
    );

  /*
    주제에 맞는 결과가 없으면
    다시 대문 검색창을 사용한다.
  */

  if (
    !candidates.length &&
    needle
  ) {
    setProgress(
      "문서 검색",
      `주제 재검색 ${keywordIndex}/${keywordTotal}`,
      base + 4,
      `주제 포함 결과가 없어 '${keyword} ${topic}'을 다시 검색합니다`
    );

    await p.goto(
      "https://namu.wiki/w/%EB%82%98%EB%AC%B4%EC%9C%84%ED%82%A4:%EB%8C%80%EB%AC%B8",
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          30000
      }
    );

    const retryInput =
      p.locator(
        'input[type="search"][placeholder="여기에서 검색"]'
      ).first();

    await retryInput.waitFor({
      state:
        "visible",
      timeout:
        30000
    });

    await retryInput.fill(
      `${keyword} ${topic}`
    );

    const retryButton =
      p.locator(
        'a[title="검색"]'
      ).first();

    await retryButton.waitFor({
      state:
        "visible",
      timeout:
        15000
    });

    await retryButton.click();

    await p
      .waitForLoadState(
        "domcontentloaded",
        {
          timeout:
            20000
        }
      )
      .catch(
        () => {}
      );

    await p.waitForTimeout(
      1000
    );

    const more =
      await getSearchLinks(
        p
      );

    candidates =
      more.filter(
        x => {
          const text =
            (
              x.text +
              " " +
              x.title
            ).toLowerCase();

          return (
            !isAdLine(
              x.text
            ) &&
            text.includes(
              key
            ) &&
            text.includes(
              needle
            )
          );
        }
      );
  }

  if (
    !candidates.length
  ) {
    candidates =
      links.filter(
        x =>
          (
            x.text +
            " " +
            x.title
          )
            .toLowerCase()
            .includes(
              key
            )
      );
  }

  if (
    !candidates.length
  ) {
    throw new Error(
      `'${keyword}' 검색 결과를 찾지 못했습니다.`
    );
  }

  candidates.sort(
    (a, b) => {
      const score =
        x => {
          const text =
            (
              x.text +
              " " +
              x.title
            ).toLowerCase();

          let n = 0;

          if (
            text === key
          ) {
            n += 100;
          }

          if (
            text.includes(
              key
            )
          ) {
            n += 30;
          }

          if (
            needle &&
            text.includes(
              needle
            )
          ) {
            n += 70;
          }

          return n;
        };

      return (
        score(b) -
        score(a)
      );
    }
  );

  const chosen =
    candidates[0];

  const url =
    new URL(
      chosen.href,
      "https://namu.wiki"
    ).href;

  setProgress(
    "문서 검색",
    `문서 선택 ${keywordIndex}/${keywordTotal}`,
    base + 5,
    `선택 문서: ${chosen.text}`
  );

  return {
    chosen,
    url
  };
}

/* =========================================================
   DOCUMENT
========================================================= */

async function extractDocument(
  p,
  keyword,
  chosen,
  url,
  keywordIndex,
  keywordTotal
) {
  const base =
    18 +
    Math.round(
      ((keywordIndex - 1) /
        Math.max(
          keywordTotal,
          1
        )) *
        30
    );

  setProgress(
    "본문 수집",
    `문서 ${keywordIndex}/${keywordTotal}`,
    base,
    `선택 문서로 이동: ${url}`
  );

  await p.goto(
    url,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        30000
    }
  );

  await p.waitForTimeout(
    700
  );

  setProgress(
    "본문 수집",
    `본문 정리 ${keywordIndex}/${keywordTotal}`,
    base + 3,
    "광고/배너/외부 쇼핑 영역을 DOM 단계에서 제거하는 중"
  );

  const result =
    await p.evaluate(
      () => {
        function clean(
          value = ""
        ) {
          return String(
            value || ""
          )
            .replace(
              /\u00a0/g,
              " "
            )
            .replace(
              /\r/g,
              ""
            )
            .replace(
              /[ \t]+\n/g,
              "\n"
            )
            .replace(
              /\n{3,}/g,
              "\n\n"
            )
            .trim();
        }

        function normalize(
          value = ""
        ) {
          return String(
            value || ""
          )
            .toLowerCase()
            .replace(
              /\s+/g,
              ""
            )
            .replace(
              /[.:·•\-–—]/g,
              ""
            )
            .trim();
        }

        function isYeoDam(
          title = ""
        ) {
          return normalize(
            title
          ).includes(
            "여담"
          );
        }

        const selectors = [
          "main",
          "article",
          "[role='main']"
        ];

        let main = null;

        for (
          const selector
          of selectors
        ) {
          const element =
            document.querySelector(
              selector
            );

          if (
            element &&
            (
              element.innerText ||
              ""
            ).trim().length >
              200
          ) {
            main =
              element;

            break;
          }
        }

        if (!main) {
          main =
            document.body;
        }

        const clone =
          main.cloneNode(
            true
          );

        clone
          .querySelectorAll(
            [
              "script",
              "style",
              "noscript",
              "iframe",
              "ins",
              "canvas",
              "aside",
              "nav",
              "footer",
              "header",
              "[aria-label*='광고']",
              "[aria-label*='ad']",
              "[id*='ad-']",
              "[id*='-ad']",
              "[id^='ad']",
              "[class*='advert']",
              "[class*='ad-banner']",
              "[class*='adbox']",
              "[class*='sponsor']",
              "[class*='banner']"
            ].join(",")
          )
          .forEach(
            el =>
              el.remove()
          );

        clone
          .querySelectorAll(
            "a"
          )
          .forEach(
            a => {
              const href =
                a.getAttribute(
                  "href"
                ) || "";

              if (
                /^https?:\/\//i.test(
                  href
                ) &&
                !href.includes(
                  "namu.wiki"
                )
              ) {
                const text =
                  (
                    a.innerText ||
                    ""
                  ).trim();

                if (
                  /쿠팡|와우|로켓|무료배송|할인|구매|파워링크|광고/i.test(
                    text
                  ) ||
                  /coupang\.com/i.test(
                    href
                  )
                ) {
                  a.remove();
                }
              }
            }
          );

        const rawToc = [];
        const seen =
          new Set();

        clone
          .querySelectorAll(
            'a[href^="#s-"]'
          )
          .forEach(
            a => {
              const href =
                a.getAttribute(
                  "href"
                ) || "";

              if (
                !href.startsWith(
                  "#s-"
                )
              ) {
                return;
              }

              const id =
                href.substring(
                  1
                );

              if (
                !id ||
                seen.has(id)
              ) {
                return;
              }

              let title =
                clean(
                  a.parentElement
                    ?.innerText ||
                    a.innerText ||
                    ""
                )
                  .replace(
                    /\s*\[편집\]\s*/g,
                    " "
                  )
                  .trim();

              if (!title) {
                return;
              }

              const match =
                title.match(
                  /^(\d+(?:\.\d+)*)/
                );

              const number =
                match
                  ? match[1]
                  : "";

              const depth =
                number
                  ? number.split(
                      "."
                    ).length
                  : 1;

              rawToc.push({
                id,
                title,
                number,
                depth
              });

              seen.add(
                id
              );
            }
          );

        const toc = [];
        let yeoDamDepth =
          null;

        for (
          const item
          of rawToc
        ) {
          if (
            isYeoDam(
              item.title
            )
          ) {
            yeoDamDepth =
              item.depth;

            continue;
          }

          if (
            yeoDamDepth !==
            null
          ) {
            if (
              item.depth >
              yeoDamDepth
            ) {
              continue;
            }

            yeoDamDepth =
              null;
          }

          toc.push(
            item
          );
        }

        const sectionNodes =
          toc
            .map(
              item => ({
                ...item,

                el:
                  clone.querySelector(
                    `#${CSS.escape(
                      item.id
                    )}`
                  )
              })
            )
            .filter(
              x =>
                x.el
            );

        const allImages =
          [];

        const imageSeen =
          new Set();

        function isBadImageContext(
          img
        ) {
          const alt =
            clean(
              img.getAttribute(
                "alt"
              ) || ""
            );

          const title =
            clean(
              img.getAttribute(
                "title"
              ) || ""
            );

          const cls =
            String(
              img.className ||
                ""
            ).toLowerCase();

          const parent =
            img.parentElement;

          const parentCls =
            String(
              parent?.className ||
                ""
            ).toLowerCase();

          const parentText =
            clean(
              parent?.innerText ||
                ""
            );

          const grand =
            parent?.parentElement;

          const grandCls =
            String(
              grand?.className ||
                ""
            ).toLowerCase();

          const grandText =
            clean(
              grand?.innerText ||
                ""
            );

          const combined =
            `${alt} ${title} ${cls} ${parentCls} ${grandCls} ${parentText} ${grandText}`;

          if (
            /광고|배너|파워링크|쿠팡|와우회원|로켓배송|로켓프레시|무료배송|첫구매|할인|추천상품|상품구매|쇼핑|상세내용아이콘|상세내용|더보기아이콘|공유아이콘|아이콘/i.test(
              combined
            )
          ) {
            return true;
          }

          const link =
            img.closest(
              "a"
            );

          const href =
            link?.getAttribute(
              "href"
            ) || "";

          if (
            href &&
            /^https?:\/\//i.test(
              href
            ) &&
            !/namu\.wiki/i.test(
              href
            )
          ) {
            return true;
          }

          if (
            /advert|ad[-_]?banner|adbox|adsense|sponsor|powerlink|shopping|commerce|promotion|promo|affiliate/i.test(
              `${cls} ${parentCls} ${grandCls}`
            )
          ) {
            return true;
          }

          if (
            /쿠팡|와우회원|로켓배송|무료배송|첫구매|할인|구매하기|광고|파워링크/i.test(
              `${parentText} ${grandText}`
            )
          ) {
            return true;
          }

          return false;
        }

        clone
          .querySelectorAll(
            "img"
          )
          .forEach(
            img => {
              const src =
                img.getAttribute(
                  "data-src"
                ) ||
                img.getAttribute(
                  "data-original"
                ) ||
                img.getAttribute(
                  "src"
                ) ||
                "";

              if (!src) {
                return;
              }

              const absolute =
                src.startsWith(
                  "//"
                )
                  ? "https:" +
                    src
                  : src;

              if (
                !absolute.startsWith(
                  "https://i.namu.wiki/i/"
                )
              ) {
                return;
              }

              if (
                imageSeen.has(
                  absolute
                )
              ) {
                return;
              }

              if (
                isBadImageContext(
                  img
                )
              ) {
                return;
              }

              const width =
                Number(
                  img.getAttribute(
                    "width"
                  ) || 0
                );

              const height =
                Number(
                  img.getAttribute(
                    "height"
                  ) || 0
                );

              if (
                width &&
                height &&
                width < 100 &&
                height < 70
              ) {
                return;
              }

              if (
                img.closest(
                  "button"
                )
              ) {
                return;
              }

              imageSeen.add(
                absolute
              );

              allImages.push({
                src:
                  absolute,

                alt:
                  clean(
                    img.getAttribute(
                      "alt"
                    ) || ""
                  ),

                title:
                  clean(
                    img.getAttribute(
                      "title"
                    ) || ""
                  ),

                element:
                  img
              });
            }
          );

        const sectionImages =
          new Map();

        for (
          const section
          of sectionNodes
        ) {
          sectionImages.set(
            section.id,
            []
          );
        }

        for (
          const image
          of allImages
        ) {
          let closest =
            null;

          for (
            const section
            of sectionNodes
          ) {
            try {
              const position =
                section.el.compareDocumentPosition(
                  image.element
                );

              if (
                position &
                Node.DOCUMENT_POSITION_FOLLOWING
              ) {
                closest =
                  section;
              }
            } catch {}
          }

          if (closest) {
            sectionImages
              .get(
                closest.id
              )
              .push({
                src:
                  image.src,

                alt:
                  image.alt,

                title:
                  image.title
              });
          }
        }

        const sections =
          [];

        for (
          let i = 0;
          i <
          sectionNodes.length;
          i++
        ) {
          const current =
            sectionNodes[i];

          const next =
            sectionNodes[
              i + 1
            ];

          const range =
            document.createRange();

          range.setStartBefore(
            current.el
          );

          if (next) {
            range.setEndBefore(
              next.el
            );
          } else {
            range.setEndAfter(
              clone.lastElementChild ||
                clone
            );
          }

          const fragment =
            range.cloneContents();

          const wrapper =
            document.createElement(
              "div"
            );

          wrapper.appendChild(
            fragment
          );

          wrapper
            .querySelectorAll(
              "script,style,noscript,button,iframe,ins"
            )
            .forEach(
              x =>
                x.remove()
            );

          sections.push({
            id:
              current.id,

            number:
              current.number,

            title:
              current.title,

            depth:
              current.depth,

            text:
              clean(
                wrapper.innerText ||
                  ""
              ),

            images:
              sectionImages.get(
                current.id
              ) || []
          });
        }

        return {
          title:
            document.title,

          url:
            location.href,

          toc,

          sections,

          text:
            clean(
              clone.innerText ||
                ""
            )
        };
      }
    );

  if (
    !result.text ||
    result.text.length <
      100
  ) {
    throw new Error(
      `문서 본문을 읽지 못했습니다: ${url}`
    );
  }

  const before =
    result.text.length;

  result.text =
    cleanAdText(
      result.text
    );

  for (
    const section
    of result.sections
  ) {
    section.text =
      cleanAdText(
        section.text
      );
  }

  const rawImages =
    [];

  for (
    const section
    of result.sections
  ) {
    for (
      const image
      of section.images ||
      []
    ) {
      rawImages.push(
        image
      );
    }
  }

  setProgress(
    "본문 수집",
    `목차 분석 ${keywordIndex}/${keywordTotal}`,
    base + 8,
    `여담 제외 후 목차 ${result.toc.length}개 발견 · 본문 ${before.toLocaleString()}자 → 광고 제거 후 ${result.text.length.toLocaleString()}자`
  );

  setProgress(
    "이미지",
    `이미지 후보 ${keywordIndex}/${keywordTotal}`,
    base + 12,
    `나무위키 본문 이미지 후보 ${rawImages.length}개 확인`
  );

  const savedAll =
    await downloadImages(
      rawImages
    );

  const savedByOriginal =
    new Map(
      savedAll.map(
        x => [
          x.originalUrl,
          x
        ]
      )
    );

  for (
    const section
    of result.sections
  ) {
    section.images =
      (
        section.images ||
        []
      )
        .map(
          image =>
            savedByOriginal.get(
              absoluteUrl(
                image.src
              )
            )
        )
        .filter(
          Boolean
        );
  }

  const images =
    [];

  const seenImages =
    new Set();

  for (
    const section
    of result.sections
  ) {
    for (
      const image
      of section.images
    ) {
      if (
        seenImages.has(
          image.localUrl
        )
      ) {
        continue;
      }

      seenImages.add(
        image.localUrl
      );

      images.push({
        ...image,

        sectionNumber:
          section.number,

        sectionTitle:
          section.title,

        sectionId:
          section.id
      });
    }
  }

  return {
    keyword,

    selected:
      chosen,

    url:
      result.url,

    title:
      result.title,

    toc:
      result.toc,

    sections:
      result.sections,

    images,

    text:
      result.text.slice(
        0,
        70000
      )
  };
}

async function namuResearch(
  keyword,
  topic,
  keywordIndex,
  keywordTotal
) {
  const p =
    await getPage();

  const search =
    await searchNamu(
      keyword,
      topic,
      keywordIndex,
      keywordTotal
    );

  return await extractDocument(
    p,
    keyword,
    search.chosen,
    search.url,
    keywordIndex,
    keywordTotal
  );
}

/* =========================================================
   RESEARCH
========================================================= */

function buildResearch(
  docs
) {
  return docs
    .map(
      doc => {
        let output =
          `\n\n========== ${doc.keyword} ==========\n`;

        output +=
          `문서 제목: ${doc.title}\n`;

        output +=
          `문서 URL: ${doc.url}\n`;

        output +=
          "\n[전체 목차]\n";

        for (
          const toc
          of doc.toc ||
          []
        ) {
          output +=
            `${toc.number || ""} ${toc.title}\n`;
        }

        output +=
          "\n[목차별 원문]\n";

        for (
          const section
          of doc.sections ||
          []
        ) {
          output +=
            `\n\n----- ${section.number || ""} ${section.title} -----\n`;

          output +=
            section.text ||
            "(내용 없음)";
        }

        return output;
      }
    )
    .join(
      "\n\n"
    );
}

/* =========================================================
   IMAGE ATTACH
========================================================= */

function normalizeSection(
  value = ""
) {
  return String(
    value || ""
  )
    .replace(
      /^s-/i,
      ""
    )
    .trim();
}

function normalize(
  value = ""
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      ""
    )
    .replace(
      /[.:·•\-–—]/g,
      ""
    )
    .trim();
}

function attachImages(
  data,
  docs
) {
  const allImages =
    [];

  for (
    const doc
    of docs
  ) {
    for (
      const section
      of doc.sections ||
      []
    ) {
      for (
        const image
        of section.images ||
        []
      ) {
        if (
          image.localUrl
        ) {
          allImages.push({
            ...image,

            sectionNumber:
              section.number,

            sectionTitle:
              section.title,

            sectionId:
              section.id
          });
        }
      }
    }
  }

  const used =
    new Set();

  function findImage(
    sourceSection,
    heading = ""
  ) {
    const source =
      normalizeSection(
        sourceSection
      );

    let found =
      allImages.find(
        image =>
          !used.has(
            image.localUrl
          ) &&
          normalizeSection(
            image.sectionNumber
          ) === source
      );

    if (
      !found &&
      heading
    ) {
      const h =
        normalize(
          heading
        );

      found =
        allImages.find(
          image => {
            if (
              used.has(
                image.localUrl
              )
            ) {
              return false;
            }

            const title =
              normalize(
                image.sectionTitle
              );

            return (
              title &&
              (
                title.includes(
                  h
                ) ||
                h.includes(
                  title
                )
              )
            );
          }
        );
    }

    if (found) {
      used.add(
        found.localUrl
      );
    }

    return (
      found || null
    );
  }

  data.blogSections =
    Array.isArray(
      data.blogSections
    )
      ? data.blogSections
      : [];

  data.blogSections =
    data.blogSections.map(
      section => {
        const image =
          findImage(
            section.sourceSection,
            section.heading
          );

        return {
          ...section,

          body:
            String(
              section.body ||
                ""
            ).trim(),

          imageUrl:
            image?.localUrl ||
            null,

          imageOriginalUrl:
            image?.originalUrl ||
            null
        };
      }
    );

  data.shorts =
    Array.isArray(
      data.shorts
    )
      ? data.shorts
      : [];

  data.shorts =
    data.shorts.map(
      shot => {
        const image =
          findImage(
            shot.sourceSection,
            shot.text
          );

        return {
          ...shot,

          imageUrl:
            image?.localUrl ||
            null,

          imageOriginalUrl:
            image?.originalUrl ||
            null
        };
      }
    );

  return {
    data,
    allImages
  };
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    const hasApiKey =
      Boolean(
        process.env.OPENAI_API_KEY
      );

    res.json({
      ok: true,

      status:
        "connected",

      connected:
        true,

      server:
        "Content Maker",

      apiKeyConfigured:
        hasApiKey,

      apiKey:
        hasApiKey,

      openaiApiKeyConfigured:
        hasApiKey,

      model:
        MODEL,

      openaiModel:
        MODEL,

      headless:
        true,

      browser:
        "chromium",

      adFilter:
        true,

      message:
        "서버 연결 정상",

      timestamp:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   PROGRESS API
========================================================= */

app.get(
  "/api/progress",
  (req, res) => {
    res.json(
      progress
    );
  }
);

/* =========================================================
   JOB RESULT STORE
   ★ 추가: 오래 걸리는 작업의 최종 결과를 저장해두고
   프론트엔드가 폴링으로 가져가게 한다.
========================================================= */

let jobStore = {
  namuSearch: {
    running: false,
    result: null,
    error: null
  },
  generate: {
    running: false,
    result: null,
    error: null
  }
};

/* =========================================================
   NAMU SEARCH API
   ★ 수정: 요청을 즉시 202로 응답하고,
   실제 작업은 백그라운드에서 수행한다.
   (Playwright 다중 페이지 수집은 수십 초~수 분 걸릴 수 있어
   프록시/호스팅 타임아웃(HTML 504 페이지)에 걸려
   "Unexpected token '<'" 에러가 나던 원인)
========================================================= */

app.post(
  "/api/namu-search",
  (req, res) => {
    const {
      keywords = [],
      topic =
        "인물 소개"
    } =
      req.body || {};

    if (
      !Array.isArray(
        keywords
      ) ||
      !keywords.length
    ) {
      return res.status(
        400
      ).json({
        ok: false,
        error:
          "검색어를 입력해주세요."
      });
    }

    if (
      jobStore.namuSearch
        .running
    ) {
      return res.status(
        409
      ).json({
        ok: false,
        error:
          "이미 검색 작업이 진행 중입니다. 완료 후 다시 시도해주세요."
      });
    }

    resetProgress();

    jobStore.namuSearch = {
      running: true,
      result: null,
      error: null
    };

    // 즉시 응답 (202 Accepted) — 프론트엔드는 /api/progress 를
    // 폴링하다가 완료되면 /api/namu-search/result 로 결과를 가져간다.
    res.status(202).json({
      ok: true,
      started: true,
      message:
        "검색을 시작했습니다. /api/progress 로 진행 상황을 확인하세요."
    });

    (async () => {
      try {
        const docs = [];

        const total =
          Math.min(
            keywords.length,
            5
          );

        for (
          let i = 0;
          i < total;
          i++
        ) {
          const keyword =
            String(
              keywords[i] || ""
            ).trim();

          if (!keyword) {
            continue;
          }

          docs.push(
            await namuResearch(
              keyword,
              topic,
              i + 1,
              total
            )
          );
        }

        setProgress(
          "수집 완료",
          "AI 입력자료 준비",
          73,
          `문서 ${docs.length}개 · 전체 목차/본문/이미지 수집 완료. 광고와 여담은 제외했습니다.`
        );

        jobStore.namuSearch = {
          running: false,
          result: { ok: true, docs },
          error: null
        };

        finishProgress(
          true,
          `문서 ${docs.length}개 수집 완료`
        );
      } catch (error) {
        console.error(
          "NAMU:",
          error
        );

        jobStore.namuSearch = {
          running: false,
          result: null,
          error:
            error.message ||
            String(error)
        };

        finishProgress(
          false,
          error.message ||
            String(error)
        );
      }
    })();
  }
);

app.get(
  "/api/namu-search/result",
  (req, res) => {
    const job =
      jobStore.namuSearch;

    if (job.running) {
      return res.status(
        202
      ).json({
        ok: true,
        running: true
      });
    }

    if (job.error) {
      return res.status(
        500
      ).json({
        ok: false,
        error:
          job.error
      });
    }

    if (!job.result) {
      return res.status(
        404
      ).json({
        ok: false,
        error:
          "아직 실행된 검색 작업이 없습니다."
      });
    }

    res.json(
      job.result
    );
  }
);

/* =========================================================
   AI SCHEMA
========================================================= */

const contentSchema = {
  type: "object",

  additionalProperties:
    false,

  properties: {
    title: {
      type: "string"
    },

    summary: {
      type: "string"
    },

    factCheck: {
      type: "array",

      items: {
        type: "object",

        additionalProperties:
          false,

        properties: {
          claim: {
            type: "string"
          },

          status: {
            type: "string"
          },

          explanation: {
            type: "string"
          }
        },

        required: [
          "claim",
          "status",
          "explanation"
        ]
      }
    },

    blogSections: {
      type: "array",

      items: {
        type: "object",

        additionalProperties:
          false,

        properties: {
          sourceSection: {
            type: "string"
          },

          heading: {
            type: "string"
          },

          body: {
            type: "string"
          },

          depth: {
            type: "integer"
          }
        },

        required: [
          "sourceSection",
          "heading",
          "body",
          "depth"
        ]
      }
    },

    shorts: {
      type: "array",

      items: {
        type: "object",

        additionalProperties:
          false,

        properties: {
          time: {
            type: "string"
          },

          text: {
            type: "string"
          },

          sourceSection: {
            type: "string"
          }
        },

        required: [
          "time",
          "text",
          "sourceSection"
        ]
      }
    },

    hashtags: {
      type: "array",

      items: {
        type: "string"
      }
    }
  },

  required: [
    "title",
    "summary",
    "factCheck",
    "blogSections",
    "shorts",
    "hashtags"
  ]
};

/* =========================================================
   AI GENERATE
   ★ 수정: 이 라우트도 동일하게 즉시 응답 + 백그라운드 처리로 변경
========================================================= */

app.post(
  "/api/generate",
  (req, res) => {
    const {
      keywords = [],
      topic =
        "인물 소개",
      style =
        "흥미로운 스토리형",
      length =
        "보통",
      sourceText = "",
      docs = []
    } =
      req.body || {};

    if (
      !keywords.length
    ) {
      return res.status(
        400
      ).json({
        ok: false,
        error:
          "검색어를 입력해주세요."
      });
    }

    if (
      !process.env.OPENAI_API_KEY
    ) {
      return res.status(
        500
      ).json({
        ok: false,
        error:
          "OPENAI_API_KEY가 Render 환경변수에 설정되어 있지 않습니다."
      });
    }

    if (
      !Array.isArray(
        docs
      ) ||
      !docs.length
    ) {
      return res.status(
        400
      ).json({
        ok: false,
        error:
          "수집된 나무위키 자료가 없습니다."
      });
    }

    if (
      jobStore.generate
        .running
    ) {
      return res.status(
        409
      ).json({
        ok: false,
        error:
          "이미 생성 작업이 진행 중입니다. 완료 후 다시 시도해주세요."
      });
    }

    jobStore.generate = {
      running: true,
      result: null,
      error: null
    };

    res.status(202).json({
      ok: true,
      started: true,
      message:
        "AI 생성을 시작했습니다. /api/progress 로 진행 상황을 확인하세요."
    });

    (async () => {
      try {
        setProgress(
          "AI 작성",
          "자료 정리",
          76,
          "수집된 전체 목차와 본문을 AI 입력자료로 묶는 중입니다."
        );

        const research =
          buildResearch(
            docs
          );

        setProgress(
          "AI 작성",
          "프롬프트 구성",
          78,
          `AI에 전달할 자료 ${research.length.toLocaleString()}자 · 세부 목차까지 포함`
        );

        const prompt = `
너는 한국 연예·사회·역사 이슈 전문 콘텐츠 작가다.

검색어:
${keywords.join(", ")}

주제:
${topic}

스타일:
${style}

분량:
${length}

아래 수집자료를 바탕으로 블로그와 쇼츠를 작성하라.

중요한 작성 규칙:

1. 자료에 없는 사실을 만들지 않는다.
2. 사실로 확인되지 않는 내용을 사실처럼 단정하지 않는다.
3. 기록이 확인되지 않은 내용은 본문에서 제외한다.
4. '수집 문서에는'이라는 표현을 사용하지 않는다.
5. '수집된 자료에 따르면' 같은 메타 표현을 사용하지 않는다.
6. 자료에 없는 내용을 AI가 임의로 보충하지 않는다.
7. 여담 목차는 사용하지 않는다.
8. 확인되지 않은 의혹을 사실처럼 작성하지 않는다.
9. 조상의 행적과 후손 개인의 행위를 동일시하지 않는다.
10. 세부 목차가 많으면 상위 목차를 중제목으로 만들고 하위 목차를 소제목으로 구성한다.
11. 3.1.1, 3.1.2 같은 세부 목차도 중요한 내용은 반영한다.
12. 블로그 제목은 title에 작성한다.
13. 블로그 본문은 blogSections에 작성한다.
14. depth가 1이면 큰 중제목,
15. depth가 2 이상이면 소제목 성격으로 작성한다.
16. 각 section에는 원본 목차 번호를 sourceSection으로 기록한다.
17. 이미지 URL은 만들지 않는다. 프로그램이 원본 이미지와 연결한다.
18. 쇼츠도 확인된 자료만 사용한다.
19. factCheck를 위해 사실을 새로 조사하지 않는다.
20. factCheck에는 자료에서 직접 확인 가능한 내용만 넣는다.

추가 자료:
${sourceText || "(없음)"}

수집자료:
${research}
`;

        setProgress(
          "AI 작성",
          "OpenAI 요청 중",
          82,
          "구조화된 JSON 형식으로 블로그/쇼츠를 작성하고 있습니다."
        );

        const client =
          new OpenAI({
            apiKey:
              process.env.OPENAI_API_KEY,

            timeout:
              120000,

            maxRetries: 0
          });

        const response =
          await client.responses.create(
            {
              model:
                MODEL,

              input:
                prompt,

              text: {
                format: {
                  type:
                    "json_schema",

                  name:
                    "content_maker_result",

                  strict:
                    true,

                  schema:
                    contentSchema
                }
              },

              max_output_tokens:
                12000
            }
          );

        setProgress(
          "AI 작성",
          "AI 응답 수신",
          91,
          "AI 응답을 받았습니다. JSON 구조를 검증하고 이미지 위치를 연결합니다."
        );

        const raw =
          (
            response.output_text ||
            ""
          ).trim();

        if (!raw) {
          throw new Error(
            "AI가 빈 결과를 반환했습니다."
          );
        }

        let data;

        try {
          data =
            JSON.parse(
              raw
            );
        } catch {
          throw new Error(
            "AI 구조화 결과를 JSON으로 읽지 못했습니다."
          );
        }

        setProgress(
          "AI 작성",
          "이미지 연결",
          95,
          "각 블로그 소제목과 가장 가까운 원문 이미지를 연결하는 중입니다."
        );

        const attached =
          attachImages(
            data,
            docs
          );

        data =
          attached.data;

        data.images =
          attached.allImages;

        data.blog =
          (
            data.blogSections ||
            []
          )
            .map(
              section =>
                `${section.heading}\n\n${section.body}`
            )
            .join(
              "\n\n"
            );

        data.namuSources =
          docs.map(
            doc => ({
              keyword:
                doc.keyword,

              title:
                doc.title,

              url:
                doc.url,

              selected:
                doc.selected,

              toc:
                doc.toc || [],

              sections:
                (
                  doc.sections ||
                  []
                ).map(
                  section => ({
                    id:
                      section.id,

                    number:
                      section.number,

                    title:
                      section.title,

                    depth:
                      section.depth,

                    textLength:
                      (
                        section.text ||
                        ""
                      ).length,

                    images:
                      section.images ||
                      []
                  })
                ),

              images:
                doc.images ||
                []
            })
          );

        jobStore.generate = {
          running: false,
          result: { ok: true, ...data },
          error: null
        };

        finishProgress(
          true,
          `완료 · 블로그 ${data.blogSections.length}개 소제목 · 이미지 ${data.images.length}개 연결`
        );
      } catch (error) {
        console.error(
          "AI:",
          error
        );

        jobStore.generate = {
          running: false,
          result: null,
          error:
            error.message ||
            String(error)
        };

        finishProgress(
          false,
          error.message ||
            String(error)
        );
      }
    })();
  }
);

app.get(
  "/api/generate/result",
  (req, res) => {
    const job =
      jobStore.generate;

    if (job.running) {
      return res.status(
        202
      ).json({
        ok: true,
        running: true
      });
    }

    if (job.error) {
      return res.status(
        500
      ).json({
        ok: false,
        error:
          job.error
      });
    }

    if (!job.result) {
      return res.status(
        404
      ).json({
        ok: false,
        error:
          "아직 실행된 생성 작업이 없습니다."
      });
    }

    res.json(
      job.result
    );
  }
);

/* =========================================================
   ★ 추가: /api/* 경로에서 매칭되는 라우트가 없을 때
   기본 Express 404 HTML 대신 JSON을 돌려준다.
   (경로 오타/프론트-백엔드 불일치 시 "Unexpected token '<'" 방지)
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: `API 경로를 찾을 수 없습니다: ${req.method} ${req.originalUrl}`
    });
  }
);

/* =========================================================
   ★ 추가: 전역 에러 핸들러
   라우트 안에서 예외가 던져지거나 body 파싱이 실패해도
   기본 HTML 에러 페이지 대신 JSON을 반환한다.
========================================================= */

app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    ok: false,
    error: err.message || "서버 내부 오류가 발생했습니다."
  });
});

/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "CONTENT MAKER - HEADLESS"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `MODEL: ${MODEL}`
    );

    console.log(
      `OPENAI_API_KEY: ${
        process.env.OPENAI_API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      "BROWSER: HEADLESS"
    );

    console.log(
      "AD FILTER: ON"
    );

    console.log(
      "=========================================="
    );
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {
  try {
    if (browser) {
      await browser.close();
    }
  } catch {}

  process.exit(0);
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

/* =========================================================
   ★ 추가: 처리되지 않은 Promise 거부로 인한 서버 다운 방지
========================================================= */

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
