FROM node:24

# The ping service shells out to the system `ping` binary - make sure it exists.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-3000}/api/health" > /dev/null || exit 1
CMD ["npx", "tsx", "server.ts"]
