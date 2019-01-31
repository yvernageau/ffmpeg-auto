FROM node:lts-alpine

VOLUME ["/input", "/output"]

WORKDIR /usr/app
COPY . .

RUN apk add --no-cache ffmpeg && \
    npm install && \
    npm run build

ENTRYPOINT ["node", "lib", "-i", "/input", "-o", "/output", "-p", "/profile.json", "--watch"]