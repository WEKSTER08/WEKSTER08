FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV PORT=8787 HOST=0.0.0.0 RELAY_DB=/data/relay.db
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
