/** A turborepo with two deployable apps and two shared packages; the database lives in a package. */
export const monorepoTwoServices: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["apps/*", "packages/*"], devDependencies: { turbo: "2.0.0" } }, null, 2),
  "turbo.json": '{ "tasks": { "build": {} } }\n',
  "apps/web/package.json": JSON.stringify(
    { name: "@acme/web", scripts: { build: "next build", start: "next start -p 3100" }, dependencies: { next: "14.2.0", react: "18.3.0", "@acme/ui": "workspace:*" } },
    null,
    2
  ),
  "apps/api/package.json": JSON.stringify(
    { name: "@acme/api", scripts: { build: "tsc", start: "node dist/index.js" }, dependencies: { fastify: "4.26.0", "@acme/db": "workspace:*" } },
    null,
    2
  ),
  "apps/api/Dockerfile": `FROM node:22-slim
WORKDIR /app
COPY . .
EXPOSE 4000
CMD ["node", "dist/index.js"]
`,
  "apps/api/src/index.ts": 'import Fastify from "fastify";\nconst app = Fastify();\napp.get("/health", async () => ({ ok: true }));\napp.listen({ port: 4000 });\n',
  "packages/db/package.json": JSON.stringify({ name: "@acme/db", dependencies: { pg: "8.11.0" } }, null, 2),
  "packages/db/src/index.ts": 'import { Pool } from "pg";\nexport const pool = new Pool({ connectionString: process.env.DATABASE_URL });\n',
  "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", dependencies: { react: "18.3.0" } }, null, 2),
};
