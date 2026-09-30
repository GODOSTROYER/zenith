/** Next.js + Prisma (postgresql) + Redis (ioredis, bullmq producer) + Dockerfile. */
export const nextjsPrismaRedis: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "shop",
      version: "1.0.0",
      private: true,
      engines: { node: ">=20" },
      scripts: { dev: "next dev", build: "next build", start: "next start", postinstall: "prisma generate" },
      dependencies: { next: "14.2.0", react: "18.3.0", "react-dom": "18.3.0", "@prisma/client": "5.10.0", ioredis: "5.3.2", bullmq: "5.1.0" },
      devDependencies: { prisma: "5.10.0", typescript: "5.4.0" },
    },
    null,
    2
  ),
  "package-lock.json": "{}",
  "prisma/schema.prisma": `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`,
  "prisma/migrations/20240101000000_init/migration.sql": 'CREATE TABLE "User" (id SERIAL PRIMARY KEY);',
  Dockerfile: `FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
EXPOSE 3000
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]
`,
  "src/app/api/health/route.ts": "export async function GET() { return Response.json({ ok: true }); }\n",
  "src/lib/redis.ts": `import Redis from "ioredis";
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
`,
  "src/lib/config.ts": `export const APP_NAME = process.env.APP_NAME ?? "Shop";
export const SESSION_SECRET = process.env.NEXTAUTH_SECRET;
export const SITE = process.env.NEXT_PUBLIC_SITE_URL;
`,
  ".env.example": "DATABASE_URL=\nREDIS_URL=\nNEXTAUTH_SECRET=\nAPP_NAME=Shop\n",
};
