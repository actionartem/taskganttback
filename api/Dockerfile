FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY swagger.js ./

COPY app.js ./

CMD ["node", "app.js"]
