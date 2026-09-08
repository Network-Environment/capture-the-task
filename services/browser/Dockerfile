FROM node:22-bookworm AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install && npx tsc

FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
USER pwuser
EXPOSE 8080
CMD ["node", "dist/index.js"]
