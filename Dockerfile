FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 SHOAL_BIND=0.0.0.0 SHOAL_DATA_DIR=/data
COPY --from=build --chown=node:node /app /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssl && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
USER node
EXPOSE 3000 8443
CMD ["npm", "start"]
