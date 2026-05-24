FROM node:20.18-alpine

WORKDIR /app

# Install build dependencies for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy source
COPY . .

# Create data directory for SQLite
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "src/server.js"]
