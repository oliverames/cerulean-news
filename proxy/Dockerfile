# Relay image. The only dependency is the Google News URL decoder, which has
# to run here because its two calls to news.google.com are blocked from a
# Worker exactly like the feeds are.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./

USER node

ENV PORT=8790
ENV BIND_ADDR=0.0.0.0
EXPOSE 8790

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
