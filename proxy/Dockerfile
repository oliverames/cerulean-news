# Minimal relay image. No dependencies: the server is one file using only
# Node builtins, so there is nothing to install and nothing to audit.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# Drop privileges; the image's own unprivileged user is enough.
USER node

ENV PORT=8790
ENV BIND_ADDR=0.0.0.0
EXPOSE 8790

HEALTHCHECK --interval=60s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
