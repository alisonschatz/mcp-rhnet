FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY specs ./specs
COPY scripts ./scripts
RUN node scripts/validate-specs.js
ENV PORT=3001
EXPOSE 3001
USER node
CMD ["node", "src/http.js"]
