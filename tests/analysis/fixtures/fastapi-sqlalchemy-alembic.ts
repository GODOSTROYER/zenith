/** FastAPI + SQLAlchemy + alembic, no Dockerfile (buildpack-style inference). */
export const fastapiSqlalchemyAlembic: Record<string, string> = {
  "requirements.txt": "fastapi==0.110.0\nuvicorn[standard]==0.29.0\nsqlalchemy==2.0.28\npsycopg2-binary==2.9.9\nalembic==1.13.1\n",
  ".python-version": "3.12\n",
  "app/__init__.py": "",
  "app/main.py": `from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}
`,
  "app/db.py": `import os
from sqlalchemy import create_engine

engine = create_engine(os.environ["DATABASE_URL"])
`,
  "alembic.ini": "[alembic]\nscript_location = alembic\n",
  "alembic/versions/0001_init.py": "revision = '0001'\n",
};
