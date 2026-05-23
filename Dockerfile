FROM node:20-alpine

WORKDIR /app

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
