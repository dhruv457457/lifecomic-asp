# LifeComic ASP — comic generation service (Express + native canvas/sharp/pdfkit).
# node:22-slim (glibc, matches local Node 22) so prebuilt binaries for @napi-rs/canvas and sharp
# install cleanly. Mirrors the sibling trading-memory-guard-asp image that deploys on Railway.
FROM node:22-slim

# fontconfig + a real font so @napi-rs/canvas can letter panels (slim images ship no fonts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching. Native modules pull prebuilt binaries here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
# The app reads PORT from the environment (Railway injects it); default 4020 for local runs.
ENV PORT=4020
EXPOSE 4020

# npm start uses --env-file=.env, which errors if the file is absent. On Railway env vars are
# injected directly, so start node without an env file.
CMD ["node", "src/server.js"]
