# Use a Node base image and install Chromium for Puppeteer/whatsapp-web.js.
FROM node:20-slim

# Install Chromium and the libraries it needs to run headless.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libgtk-3-0 \
    libxss1 \
    libasound2 \
    libgbm1 \
    libxkbcommon0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libxext6 \
    libpango-1.0-0 \
    libcairo2 \
    libdrm2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own.
# Both env var names are set because different puppeteer versions look for
# different ones — PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is the older name,
# PUPPETEER_SKIP_DOWNLOAD is what current puppeteer (v22+) actually checks.
# Without this, `npm ci` tries to download Chromium from Google's CDN during
# the build and can fail outright (403s are common from cloud/CI IPs).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway sets PORT automatically; the status/QR page listens on it.
EXPOSE 3000

CMD ["npm", "start"]
