/**
 * The "Use sample app" compose file, as a module.
 *
 * It used to be read off disk with fs at request time, which tied onboarding
 * to process.cwd() and let the sample degrade silently to an empty box in any
 * build that does not trace the fixtures folder. A module cannot go missing.
 *
 * fixtures/sample-app/docker-compose.yml stays on disk because the importer
 * tests read it; tests/screens/sample-compose.test.ts fails if the two drift.
 */
export const SAMPLE_COMPOSE = `version: "3.9"

services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://ledger:ledger@postgres:5432/ledger
      REDIS_URL: redis://redis:6379/0
      QUEUE_URL: amqp://rabbitmq:5672
      SMTP_HOST: mailhog
      S3_ENDPOINT: http://minio:9000
      SESSION_SECRET: dev-only-not-a-real-secret
    depends_on:
      - postgres
      - redis
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"]
      interval: 10s
    restart: unless-stopped
    volumes:
      - ./src:/app/src

  worker:
    build: .
    command: node worker.js
    environment:
      DATABASE_URL: postgres://ledger:ledger@postgres:5432/ledger
      QUEUE_URL: amqp://rabbitmq:5672
      S3_ENDPOINT: http://minio:9000
      SMTP_HOST: mailhog
      AWS_SECRET_ACCESS_KEY: dev-only-not-a-real-key
    depends_on:
      - postgres
      - rabbitmq

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ledger
      POSTGRES_PASSWORD: ledger
      POSTGRES_DB: ledger
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7
    command: redis-server --appendonly yes

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"

  minio:
    image: minio/minio:latest
    command: server /data
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    ports:
      - "9000:9000"

  mailhog:
    image: mailhog/mailhog:v1.0.1
    ports:
      - "8025:8025"

volumes:
  pgdata:
`;
