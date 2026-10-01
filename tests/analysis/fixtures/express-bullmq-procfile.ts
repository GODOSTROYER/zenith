/** Express + pg + bullmq worker + knex migrations, run with a Procfile. */
export const expressBullmqProcfile: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "orders-api",
      main: "server.js",
      engines: { node: "20.x" },
      scripts: { start: "node server.js", worker: "node worker.js" },
      dependencies: { express: "4.19.0", pg: "8.11.0", bullmq: "5.1.0", knex: "3.1.0", nodemailer: "6.9.0" },
    },
    null,
    2
  ),
  Procfile: "web: node server.js\nworker: node worker.js\nrelease: npx knex migrate:latest\n",
  "knexfile.js": `module.exports = { client: "pg", connection: process.env.DATABASE_URL };\n`,
  "server.js": `const express = require("express");
const { Pool } = require("pg");
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.get("/healthz", (req, res) => res.send("ok"));
app.get("/orders", async (req, res) => res.json((await pool.query("select 1")).rows));
const PORT = process.env.PORT || 8080;
app.listen(PORT);
`,
  "worker.js": `const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");
const smtpHost = process.env.SMTP_HOST || "smtp.internal";
new Worker("jobs", async (job) => { await nodemailer.createTransport({ host: smtpHost }).sendMail(job.data); }, {
  connection: { host: process.env.REDIS_HOST || "localhost" },
});
`,
};
