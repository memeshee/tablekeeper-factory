FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Compile TypeScript to JavaScript
RUN npx tsc

COPY . .

EXPOSE 8080

CMD ["node", "src/index.js"]