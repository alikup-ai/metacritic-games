# Бэкенд: API и обработчик. Роль выбирается переменной APP_ROLE.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# NODE_ENV здесь НЕ production: иначе npm ci пропустит devDependencies,
# а среди них tsx, который выполняет TypeScript в рабочем режиме.
RUN npm ci

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Процесс не работает от имени root
USER node

EXPOSE 3001

# Проверка живости обращается только к своей базе, без внешних сервисов
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/app/main.ts"]
