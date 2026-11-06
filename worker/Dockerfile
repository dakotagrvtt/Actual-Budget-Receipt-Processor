FROM node:22-bookworm-slim

# imagemagick: resize/orient; poppler-utils: PDF pages → JPEG; libheif-examples: iPhone HEIC → JPEG.
# python3/make/g++: fallback build tools for @actual-app/api's native SQLite module.
RUN apt-get update && apt-get install -y --no-install-recommends \
      imagemagick poppler-utils libheif-examples ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
ARG ACTUAL_API_VERSION=latest
RUN npm install --omit=dev && npm install --omit=dev "@actual-app/api@${ACTUAL_API_VERSION}"
COPY src ./src

USER node
CMD ["node", "src/index.js"]
