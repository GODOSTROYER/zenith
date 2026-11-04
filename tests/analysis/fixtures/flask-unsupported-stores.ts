/** Flask with MySQL, MongoDB and RabbitMQ: none of them exist in the V1 manifest. */
export const flaskUnsupportedStores: Record<string, string> = {
  "requirements.txt": "flask==3.0.2\nmysqlclient==2.2.4\npymongo==4.6.2\npika==1.3.2\ngunicorn==21.2.0\n",
  "app.py": `import os
from flask import Flask

app = Flask(__name__)
DB_HOST = os.environ.get("DB_HOST", "mysql.internal")
MONGO_URI = os.environ["MONGO_URI"]


@app.route("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
`,
};
