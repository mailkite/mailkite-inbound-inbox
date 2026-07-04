# Docs: docs/templates/inbound-inbox.md
# Node runtime image — used by Railway, Render, DigitalOcean App Platform, Fly, or any Docker host.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Default DB location; mount a volume here for persistence (Fly [mounts], Render disk, …).
ENV DATABASE_PATH=/data/inbox.db
RUN mkdir -p /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/node/server.js"]
