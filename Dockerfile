# Stage 1: Build native dependencies
FROM node:24-alpine AS builder

WORKDIR /app

# Install build tools required for compiling better-sqlite3
RUN apk add --no-cache python3 make g++ gcc

COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Minimal runtime image
FROM node:24-alpine

WORKDIR /app

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Default environment
ENV NODE_ENV=production
ENV RADAR_DASH_PORT=3010
# Marks the runtime as containerised so the in-app update flag can show.
ENV RADAR_IN_DOCKER=true

EXPOSE 3010

CMD ["node", "server.js"]
