# Production image for the Muraqaba API.
# Build:  docker build -t muraqaba-api .
# Run:    docker run -p 5000:5000 --env-file .env muraqaba-api
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Application files stay root-owned (read-only for the runtime user).
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1
CMD ["node", "server.js"]
