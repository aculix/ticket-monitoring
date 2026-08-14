FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/

ENV STATE_PATH=/data/state.json
VOLUME /data
EXPOSE 8080

# --env-file-if-exists so the container works with plain env vars when no .env is mounted.
CMD ["node", "--env-file-if-exists=.env", "src/index.js", "--loop"]
