FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const http=require('node:http'); const port=Number(process.env.WEB_PORT||process.env.PORT||3000); const req=http.get({host:'127.0.0.1', port, path:'/api/health', timeout:3000}, (res)=>process.exit(res.statusCode===200?0:1)); req.on('error', ()=>process.exit(1)); req.on('timeout', ()=>{req.destroy(); process.exit(1);});"

CMD ["npm", "start"]
