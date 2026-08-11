FROM node:20.19.4-bookworm-slim

ENV NODE_ENV=production \
    CLOUDBASE_ENV_ID=cloudbase-d8ga4akpcb66d62a1 \
    CLOUDBASE_USE_RUNTIME_IDENTITY=true \
    UPLOAD_TEMP_DIR=/tmp/admin-upload-broker
WORKDIR /srv/admin-upload-broker

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY src ./src

RUN groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid app --home-dir /nonexistent --shell /usr/sbin/nologin app \
  && mkdir -p /tmp/admin-upload-broker \
  && chown -R app:app /tmp/admin-upload-broker

USER 10001:10001
EXPOSE 8080

CMD ["node", "src/server.js"]
