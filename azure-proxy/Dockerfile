# Homer Azure Proxy Dockerfile
# Runs on Azure Container Apps to proxy traffic to Cloudflare tunnel

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source
COPY server.js ./

# Azure Container Apps expects port 8080 by default
ENV PORT=8080
EXPOSE 8080

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs
USER nodejs

CMD ["node", "server.js"]
