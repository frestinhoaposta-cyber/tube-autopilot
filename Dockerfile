# Tube AutoPilot — imagem de produção para Fly.io
# Usa o Node LTS (22+) exigido pelo package.json.
FROM node:22-slim

# Diretório de trabalho
WORKDIR /app

# Copia os manifests primeiro (aproveita o cache de camadas do docker)
COPY package.json package-lock.json* ./

# Instala apenas as dependências de produção (Node 22 suporta --omit=dev)
RUN npm install --omit=dev --no-audit --no-fund

# Copia o código da aplicação (src, server, scripts)
COPY server ./server
COPY src ./src
COPY scripts ./scripts

# Cria o diretório de dados persistente (montado como volume no Fly.io)
RUN mkdir -p /app/data

# O Fly.io injeta a porta via variável de ambiente PORT
ENV PORT=8080
EXPOSE 8080

# Inicia o servidor
CMD ["node", "server/server.js"]
