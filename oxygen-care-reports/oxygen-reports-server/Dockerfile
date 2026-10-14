FROM node:20-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
RUN chown -R node:node /app/.next
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
