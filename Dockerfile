FROM node:12

WORKDIR /usr/src/app

COPY *.json ./

RUN npm install\
    && npm install -g ts-node typescript '@types/node'

COPY . .

EXPOSE 8080
CMD [ "ts-node", "server.ts" ]