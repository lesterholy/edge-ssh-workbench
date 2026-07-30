FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/tailnet-connector/package.json apps/tailnet-connector/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @edgesh/tailnet-connector
COPY apps/tailnet-connector apps/tailnet-connector
COPY packages/contracts packages/contracts
RUN npm run build -w @edgesh/tailnet-connector

FROM node:22-alpine
RUN addgroup -S edgesh && adduser -S -G edgesh edgesh
WORKDIR /app
COPY --from=build /app/apps/tailnet-connector/dist/server.cjs ./server.cjs
USER edgesh
ENV LISTEN_HOST=127.0.0.1 PORT=8789
EXPOSE 8789
CMD ["node", "server.cjs"]
