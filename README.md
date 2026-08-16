# Content Maker

GitHub + Render 배포용입니다.

1. 이 폴더 전체를 GitHub 새 저장소에 업로드합니다.
2. Render에서 GitHub 저장소를 Web Service로 연결합니다.
3. Build Command: `npm install && npx playwright install chromium`
4. Start Command: `npm start`
5. Environment Variables에 `OPENAI_API_KEY`를 입력합니다.
6. `NAMU_HEADLESS=true`로 창 없이 나무위키를 수집합니다.

블로그는 제목 → 중제목 → 소제목 구조로 만들고, 제공된 관련 이미지를 중복 없이 연결합니다. 여담과 근거 없는 내용은 결과에서 제외하도록 작성 규칙을 넣었습니다.

API 키는 절대 GitHub에 올리지 마세요.
