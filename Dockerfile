FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=3000 DB_FILE=/data/chess.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
