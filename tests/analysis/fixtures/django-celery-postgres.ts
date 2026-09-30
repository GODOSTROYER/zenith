/** Django + celery (redis broker) + celery beat + postgres, requirements.txt and a Procfile. */
export const djangoCeleryPostgres: Record<string, string> = {
  "requirements.txt": "Django==5.0.2\ncelery[redis]==5.3.6\npsycopg2-binary==2.9.9\ngunicorn==21.2.0\ndjango-celery-beat==2.5.0\n",
  ".python-version": "3.12\n",
  "manage.py": `#!/usr/bin/env python
import os, sys
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "myproj.settings")
`,
  "myproj/__init__.py": "",
  "myproj/settings.py": `import os
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
DEBUG = os.environ.get("DEBUG", "false")
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("DB_NAME", "app"),
        "PASSWORD": os.environ["DB_PASSWORD"],
    }
}
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
EMAIL_HOST = os.environ.get("EMAIL_HOST", "localhost")
`,
  "myproj/celery.py": `import os
from celery import Celery
app = Celery("myproj")
app.conf.beat_schedule = {"nightly": {"task": "myproj.tasks.nightly", "schedule": 3600}}
`,
  "myproj/wsgi.py": "from django.core.wsgi import get_wsgi_application\napplication = get_wsgi_application()\n",
  "myproj/urls.py": `from django.urls import path
urlpatterns = [path("health/", lambda r: None)]
`,
  Procfile: `web: gunicorn myproj.wsgi --bind 0.0.0.0:8000
worker: celery -A myproj worker -l info
beat: celery -A myproj beat -l info
release: python manage.py migrate --noinput
`,
};
