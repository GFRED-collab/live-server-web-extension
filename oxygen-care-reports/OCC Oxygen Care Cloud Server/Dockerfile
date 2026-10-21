FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3003 HOST=0.0.0.0 OCC_DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node package.json server.mjs sign-in-api.mjs qrcode-generator.cjs sync-api.mjs calendar-api.mjs groups-api.mjs updates-api.mjs ./
COPY --chown=node:node public/ ./public/
USER node
EXPOSE 3003
CMD ["node", "server.mjs"]
