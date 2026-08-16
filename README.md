# Content Maker - Render Docker 배포판

현재 나무위키 수집 로직은 그대로 두고 Render의 Playwright 실행환경만 Docker로 고정한 배포판입니다.

## Render
- Runtime: Docker
- Dockerfile: ./Dockerfile
- Health Check: /api/health
- OPENAI_API_KEY: Render Environment Variables에 입력
- OPENAI_MODEL: gpt-5.6

Playwright 1.55.0 공식 이미지에 브라우저와 Linux 의존성이 포함되어 있어 native runtime의 `su: Authentication failure` 문제를 피합니다.
