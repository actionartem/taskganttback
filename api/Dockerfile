FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY swagger.js ./
COPY mail-integration.js ./
COPY tracker-*.js ./
COPY agent-guide.txt ./

COPY app.js ./

CMD ["node", "app.js"]
