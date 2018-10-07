FROM node:8-alpine

VOLUME ["/input", "/output", "/config"]

WORKDIR /usr/app
COPY . .

RUN apk add --no-cache ffmpeg && \
    npm install && \
    npm run build

ENTRYPOINT ["node", "lib/", "-i", "/input", "-o", "/output", "-p", "/config/profile.json", "--watch"]