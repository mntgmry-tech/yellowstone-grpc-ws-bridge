FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production
ENV WS_BIND=0.0.0.0
ENV WS_PORT=8787

CMD ["node", "dist/index.js"]
