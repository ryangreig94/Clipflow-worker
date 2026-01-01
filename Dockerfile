FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      yt-dlp \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

CMD ["npm", "start"]
