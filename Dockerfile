FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
