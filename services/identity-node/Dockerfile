FROM node:20-alpine

WORKDIR /app

COPY services/identity-node/package*.json ./
RUN npm install

COPY services/identity-node/ .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
