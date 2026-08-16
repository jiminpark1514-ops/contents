# Playwright 1.55.0과 브라우저/OS 의존성을 함께 제공하는 공식 이미지
FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

# 의존성 버전을 Playwright 브라우저 이미지와 정확히 맞춘다.
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY content_maker.html ./

RUN mkdir -p /app/collected_images

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]
