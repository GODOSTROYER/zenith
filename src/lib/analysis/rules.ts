/**
 * The dependency → meaning table. One row says "if this package is a
 * (production) dependency, then this framework / datastore / worker / cron /
 * health signal is present". Confidence starts at the row's value and drops
 * one step for a dev-only dependency unless the row is a build tool that is
 * normally dev-only (`devOk`).
 *
 * Reading a dependency name is a claim about intent, not proof of use — hence
 * `medium` for packages that are often installed for something else.
 */
import { addDatastore } from "./record";
import type { Ctx, Eco, RootFacts } from "./model";
import { lowerConfidence } from "./text";
import type { Confidence, DatastoreKind, DatastoreRequirement, FrameworkRequirement } from "./types";

type Effect =
  | { t: "fw"; name: string; role: FrameworkRequirement["role"]; port?: number }
  | { t: "ds"; kind: DatastoreKind; engine?: string; role?: DatastoreRequirement["role"] }
  | { t: "worker"; tech: string; command?: string }
  | { t: "cron"; tech: string; inProcess: boolean }
  | { t: "health"; path: string };

interface DepRule {
  eco: Eco;
  names: string[];
  effect: Effect;
  conf: Confidence;
  devOk?: boolean;
  /** Match `name` and `name/...` (Go module paths with a major-version suffix). */
  prefix?: boolean;
}

const RULES: DepRule[] = [];
const rule = (eco: Eco, names: string[], effect: Effect, conf: Confidence = "high", extra: { devOk?: boolean; prefix?: boolean } = {}): void => {
  RULES.push({ eco, names, effect, conf, ...extra });
};
const web = (eco: Eco, names: string[], name: string, port?: number, conf: Confidence = "high", prefix = false) =>
  rule(eco, names, { t: "fw", name, role: "web", port }, conf, { prefix });
const ds = (eco: Eco, names: string[], kind: DatastoreKind, conf: Confidence = "high", engine?: string, role?: DatastoreRequirement["role"], prefix = false) =>
  rule(eco, names, { t: "ds", kind, engine, role }, conf, { prefix });

/* ---------------------------------- node --------------------------------- */

web("npm", ["next"], "Next.js", 3000);
web("npm", ["@remix-run/node", "@remix-run/react", "@remix-run/serve", "@remix-run/express"], "Remix", 3000);
web("npm", ["express"], "Express", 3000);
web("npm", ["fastify"], "Fastify", 3000);
web("npm", ["@nestjs/core"], "NestJS", 3000);
web("npm", ["hono", "@hono/node-server"], "Hono", 3000);
web("npm", ["koa"], "Koa", 3000);
rule("npm", ["vite"], { t: "fw", name: "Vite", role: "static" }, "high", { devOk: true });
rule("npm", ["react-scripts"], { t: "fw", name: "Create React App", role: "static" }, "high", { devOk: true });

ds("npm", ["pg", "postgres", "pg-promise", "pg-pool", "slonik", "@vercel/postgres", "@neondatabase/serverless", "node-pg-migrate"], "postgres");
ds("npm", ["mysql", "mysql2", "@planetscale/database"], "mysql");
ds("npm", ["mongodb", "mongoose"], "mongodb");
ds("npm", ["sqlite3", "better-sqlite3"], "sqlite", "medium");
ds("npm", ["redis", "ioredis", "bull", "bullmq", "connect-redis", "@keyv/redis", "rate-limit-redis"], "redis");
ds("npm", ["@upstash/redis"], "redis", "medium");
ds("npm", ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-request-presigner", "multer-s3", "minio"], "object_store", "high", "s3");
ds("npm", ["aws-sdk"], "object_store", "low", "s3");
ds("npm", ["@aws-sdk/client-sqs", "sqs-consumer", "sqs-producer"], "queue", "high", "sqs", "both");
ds("npm", ["amqplib", "amqp-connection-manager", "rascal"], "rabbitmq", "high", "amqp");
ds("npm", ["kafkajs"], "kafka");
ds("npm", ["nodemailer", "@sendgrid/mail", "postmark", "mailgun.js", "mailgun-js", "resend", "emailjs"], "email", "high", "smtp");
ds("npm", ["@aws-sdk/client-ses", "@aws-sdk/client-sesv2"], "email", "high", "ses");
for (const cron of ["node-cron", "cron", "node-schedule", "agenda", "@nestjs/schedule", "bree", "toad-scheduler"]) rule("npm", [cron], { t: "cron", tech: cron, inProcess: true }, "medium");

/* --------------------------------- python -------------------------------- */

web("pip", ["django"], "Django", 8000);
web("pip", ["flask"], "Flask", 5000);
web("pip", ["fastapi"], "FastAPI", 8000);
rule("pip", ["celery"], { t: "worker", tech: "celery" }, "medium");
ds("pip", ["celery[redis]"], "redis", "high", "celery-broker");
ds("pip", ["celery[sqs]"], "queue", "high", "sqs");
ds("pip", ["celery[librabbitmq]", "celery[amqp]"], "rabbitmq", "high", "amqp");
rule("pip", ["django-celery-beat", "celery-beat"], { t: "cron", tech: "celery-beat", inProcess: false }, "medium");
rule("pip", ["rq", "django-rq"], { t: "worker", tech: "rq", command: "rq worker" }, "medium");
rule("pip", ["dramatiq"], { t: "worker", tech: "dramatiq" }, "medium");
rule("pip", ["apscheduler"], { t: "cron", tech: "apscheduler", inProcess: true }, "medium");
ds("pip", ["psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "pg8000", "django-postgres-extra"], "postgres");
ds("pip", ["mysqlclient", "pymysql", "mysql-connector-python", "aiomysql"], "mysql");
ds("pip", ["pymongo", "motor", "mongoengine", "beanie"], "mongodb");
ds("pip", ["redis", "aioredis", "django-redis", "rq", "django-rq"], "redis");
ds("pip", ["django-storages"], "object_store", "medium", "s3");
ds("pip", ["pika", "aio-pika"], "rabbitmq");
ds("pip", ["kafka-python", "confluent-kafka", "aiokafka"], "kafka");
ds("pip", ["sendgrid", "django-anymail", "flask-mail", "django-ses", "sib-api-v3-sdk"], "email", "high", "smtp");

/* ---------------------------------- ruby --------------------------------- */

web("gem", ["rails"], "Rails", 3000);
web("gem", ["sinatra"], "Sinatra", 4567);
rule("gem", ["sidekiq"], { t: "worker", tech: "sidekiq", command: "bundle exec sidekiq" }, "medium");
rule("gem", ["resque"], { t: "worker", tech: "resque" }, "medium");
rule("gem", ["delayed_job", "delayed_job_active_record"], { t: "worker", tech: "delayed_job" }, "medium");
ds("gem", ["sidekiq", "resque", "redis", "redis-rails", "hiredis"], "redis");
rule("gem", ["whenever"], { t: "cron", tech: "whenever", inProcess: false }, "medium");
for (const cron of ["clockwork", "rufus-scheduler", "sidekiq-cron", "sidekiq-scheduler"]) rule("gem", [cron], { t: "cron", tech: cron, inProcess: true }, "medium");
ds("gem", ["pg"], "postgres");
ds("gem", ["mysql2", "trilogy"], "mysql");
ds("gem", ["sqlite3"], "sqlite", "low");
ds("gem", ["mongoid"], "mongodb");
ds("gem", ["aws-sdk-s3"], "object_store", "high", "s3");
ds("gem", ["aws-sdk-sqs"], "queue", "high", "sqs", "both");
ds("gem", ["bunny"], "rabbitmq");
ds("gem", ["sendgrid-ruby", "postmark-rails", "mailgun-ruby"], "email", "high", "smtp");
ds("gem", ["aws-sdk-ses", "aws-sdk-sesv2"], "email", "high", "ses");

/* ----------------------------------- java -------------------------------- */

web("mvn", ["spring-boot-starter-web", "spring-boot-starter-webflux"], "Spring Boot", 8080);
web("mvn", ["spring-boot-starter-parent", "spring-boot-starter"], "Spring Boot", 8080, "medium");
rule("mvn", ["spring-boot-starter-actuator"], { t: "health", path: "/actuator/health" }, "medium");
ds("mvn", ["postgresql"], "postgres");
ds("mvn", ["mysql-connector-j", "mysql-connector-java", "mariadb-java-client"], "mysql");
ds("mvn", ["spring-boot-starter-data-redis", "jedis", "lettuce-core", "spring-session-data-redis"], "redis");
ds("mvn", ["spring-boot-starter-data-mongodb", "mongodb-driver-sync"], "mongodb");
ds("mvn", ["spring-boot-starter-amqp", "amqp-client", "spring-rabbit"], "rabbitmq");
ds("mvn", ["spring-kafka", "kafka-clients"], "kafka");
ds("mvn", ["spring-boot-starter-mail", "jakarta.mail", "javax.mail", "simple-java-mail"], "email", "high", "smtp");
ds("mvn", ["aws-java-sdk-s3"], "object_store", "high", "s3");
ds("mvn", ["aws-java-sdk-sqs", "spring-cloud-aws-starter-sqs"], "queue", "high", "sqs", "both");
ds("mvn", ["sqlite-jdbc"], "sqlite", "medium");
rule("mvn", ["spring-boot-starter-quartz", "quartz"], { t: "cron", tech: "quartz", inProcess: true }, "medium");

/* ------------------------------------ go --------------------------------- */

web("go", ["github.com/gin-gonic/gin"], "Gin", 8080, "high", true);
web("go", ["github.com/labstack/echo"], "Echo", 1323, "high", true);
web("go", ["github.com/gofiber/fiber"], "Fiber", 3000, "high", true);
web("go", ["github.com/go-chi/chi", "github.com/gorilla/mux"], "Go HTTP router", undefined, "medium", true);
ds("go", ["github.com/lib/pq", "github.com/jackc/pgx", "gorm.io/driver/postgres", "github.com/uptrace/bun/driver/pgdriver"], "postgres", "high", undefined, undefined, true);
ds("go", ["github.com/go-sql-driver/mysql", "gorm.io/driver/mysql"], "mysql", "high", undefined, undefined, true);
ds("go", ["go.mongodb.org/mongo-driver"], "mongodb", "high", undefined, undefined, true);
ds("go", ["github.com/go-redis/redis", "github.com/redis/go-redis", "github.com/gomodule/redigo", "github.com/hibiken/asynq"], "redis", "high", undefined, undefined, true);
ds("go", ["github.com/aws/aws-sdk-go-v2/service/s3", "github.com/aws/aws-sdk-go/service/s3", "github.com/minio/minio-go"], "object_store", "high", "s3", undefined, true);
ds("go", ["github.com/aws/aws-sdk-go-v2/service/sqs", "github.com/aws/aws-sdk-go/service/sqs"], "queue", "high", "sqs", "both", true);
ds("go", ["github.com/streadway/amqp", "github.com/rabbitmq/amqp091-go"], "rabbitmq", "high", undefined, undefined, true);
ds("go", ["github.com/segmentio/kafka-go", "github.com/IBM/sarama", "github.com/Shopify/sarama"], "kafka", "high", undefined, undefined, true);
ds("go", ["github.com/mattn/go-sqlite3", "modernc.org/sqlite"], "sqlite", "medium", undefined, undefined, true);
ds("go", ["github.com/sendgrid/sendgrid-go", "gopkg.in/gomail.v2", "github.com/wneessen/go-mail"], "email", "high", "smtp", undefined, true);
ds("go", ["github.com/aws/aws-sdk-go-v2/service/ses", "github.com/aws/aws-sdk-go-v2/service/sesv2"], "email", "high", "ses", undefined, true);
rule("go", ["github.com/robfig/cron"], { t: "cron", tech: "robfig/cron", inProcess: true }, "medium", { prefix: true });
rule("go", ["github.com/hibiken/asynq"], { t: "worker", tech: "asynq" }, "medium", { prefix: true });

/* ------------------------------ php / rust ------------------------------- */

web("composer", ["laravel/framework"], "Laravel", 8000);
rule("composer", ["laravel/horizon"], { t: "worker", tech: "laravel-horizon", command: "php artisan horizon" }, "medium");
ds("composer", ["predis/predis"], "redis");
ds("composer", ["mongodb/mongodb"], "mongodb");
ds("composer", ["league/flysystem-aws-s3-v3"], "object_store", "high", "s3");
ds("composer", ["symfony/mailer", "phpmailer/phpmailer"], "email", "high", "smtp");
web("cargo", ["axum"], "Axum", 3000);
web("cargo", ["actix-web"], "Actix Web", 8080);
web("cargo", ["rocket"], "Rocket", 8000);
ds("cargo", ["tokio-postgres", "postgres"], "postgres");
ds("cargo", ["redis"], "redis");
ds("cargo", ["aws-sdk-s3"], "object_store", "high", "s3");
ds("cargo", ["aws-sdk-sqs"], "queue", "high", "sqs", "both");
ds("cargo", ["lettre"], "email", "high", "smtp");
ds("cargo", ["mongodb"], "mongodb");
ds("cargo", ["rusqlite"], "sqlite", "medium");

/* --------------------------------- apply --------------------------------- */

const matches = (r: DepRule, name: string): boolean => r.names.some((n) => name === n || (r.prefix === true && name.startsWith(`${n}/`)));

/** Apply every matching row to the root's dependencies. Deterministic: deps in key order, rows in table order. */
export function applyDependencyRules(ctx: Ctx, f: RootFacts): void {
  for (const key of [...f.deps.keys()].sort()) {
    const dep = f.deps.get(key)!;
    for (const r of RULES) {
      if (r.eco !== dep.eco || !matches(r, dep.name)) continue;
      const conf = dep.dev && !r.devOk ? lowerConfidence(r.conf) : r.conf;
      const e = r.effect;
      switch (e.t) {
        case "fw":
          ctx.frameworks.add(`${e.name}\u0000${f.root.dir}`, { name: e.name, root: f.root.dir, role: e.role }, conf, dep.evidence);
          if (e.role === "static") f.staticFrameworks.push({ name: e.name, confidence: conf, evidence: dep.evidence });
          else f.webFrameworks.push({ name: e.name, defaultPort: e.port, confidence: conf, evidence: dep.evidence });
          break;
        case "ds":
          if (e.kind === "sqlite" && dep.dev) break; // SQLite in dev/test dependencies is the norm and says nothing about production
          addDatastore(ctx, f.root.dir, e.kind, conf, dep.evidence, { engine: e.engine, role: e.role });
          break;
        case "worker":
          f.workers.push({ tech: e.tech, confidence: conf, evidence: dep.evidence, command: e.command });
          break;
        case "cron":
          f.crons.push({ mechanism: e.tech, confidence: conf, evidence: dep.evidence, inProcess: e.inProcess });
          break;
        case "health":
          f.healths.push({ path: e.path, declared: false, evidence: dep.evidence });
          break;
      }
    }
  }
}
