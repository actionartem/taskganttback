FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

# 👇 вот ЭТОГО раньше не было
COPY swagger.js ./

COPY app.js ./

CMD ["node", "app.js"]
