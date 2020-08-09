FROM node:lts-alpine

VOLUME ["/input", "/output"]

WORKDIR /usr/app
COPY . .

RUN apk add --no-cache ffmpeg \
 && npm install \
 && npm run build \
 && rm -rf node_modules

ENTRYPOINT ["node", "lib", "-i", "/input", "-o", "/output", "-p", "/profile.yml", "--watch"]
