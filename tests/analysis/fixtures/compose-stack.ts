/** docker-compose with a built app and images for postgres, mysql, mongo, redis, rabbitmq and elasticsearch. */
export const composeStack: Record<string, string> = {
  "package.json": JSON.stringify({ name: "ledger", scripts: { start: "node index.js" }, dependencies: { express: "4.19.0" } }, null, 2),
  "index.js": `require("express")().listen(process.env.PORT || 3000);\n`,
  "docker-compose.yml": `services:
  web:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://ledger:ledger@postgres:5432/ledger
      CACHE_URL: redis://redis:6379/0
      LEGACY_DB: mysql
    depends_on:
      - postgres
      - redis
      - mysql
      - mongo
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/ready"]
  postgres:
    image: postgres:16
  mysql:
    image: mysql:8
  mongo:
    image: mongo:7
  redis:
    image: redis:7
  rabbitmq:
    image: rabbitmq:3
  search:
    image: elasticsearch:8.12.0
`,
};
