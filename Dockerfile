FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
# the only writable place: devices / connections / waitlist (never health data)
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8083/healthz >/dev/null || exit 1
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts"]
