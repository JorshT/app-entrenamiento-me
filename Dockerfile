# Alternativa a Vercel (VPS, Railway, Fly.io…). Define DATABASE_URL para usar Supabase;
# sin ella usa PGlite y guarda los datos en /data (monta un volumen ahí).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
