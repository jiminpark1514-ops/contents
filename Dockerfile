FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm install && npx playwright install --with-deps chromium
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
