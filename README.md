w# fg-meeting-traum

## Lokale Entwicklung

### Voraussetzungen

Benötigt werden:

- Docker
- Node.js + npm
- Python
- `uv`

Die lokale Anwendung besteht aus:

- PostgreSQL: `localhost:5432`
- Django API: `http://127.0.0.1:8000`
- Vite Frontend: `http://localhost:5173`

---

## 1. Einmalige Einrichtung

### Frontend-Abhängigkeiten installieren

Im Repository-Root:

```bash
cd ~/PycharmProjects/fg-meeting-traum

npm ci
```

### Backend-Abhängigkeiten installieren

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv sync
```

### PostgreSQL-Container einmalig anlegen

Dieser Befehl wird **nur beim ersten Setup** benötigt:

```bash
docker run -d \
  --name fg-postgres \
  -e POSTGRES_DB=fg_workspace \
  -e POSTGRES_USER=fg_workspace \
  -e POSTGRES_PASSWORD=fg_workspace \
  -p 5432:5432 \
  -v fg-postgres-data:/var/lib/postgresql/data \
  postgres:17
```

Die Datenbankdaten bleiben im Docker-Volume `fg-postgres-data` erhalten.

Danach Migrationen ausführen:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py migrate
```

---

## 2. Development-User anlegen

Bei einer neuen/leeren Datenbank existiert der lokale Benutzer noch nicht automatisch.

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py shell -c "
from django.contrib.auth import get_user_model
User = get_user_model()
user, created = User.objects.get_or_create(
    username='alex',
    defaults={'email': 'alex@example.com'}
)
user.set_password('DevPass1!')
user.is_active = True
user.save()
print('created:', created)
print('username:', user.username)
"
```

Login:

```text
Username: alex
Password: DevPass1!
```

Optional prüfen:

```bash
uv run python manage.py shell -c "
from django.contrib.auth import authenticate
u = authenticate(username='alex', password='DevPass1!')
print('LOGIN OK' if u else 'LOGIN FAILED')
"
```

---

# Start

Für die normale Entwicklung werden zwei Terminals benötigt.

## Terminal 1 – PostgreSQL + Backend

PostgreSQL starten:

```bash
docker start fg-postgres
```

Optional prüfen:

```bash
docker ps --filter name=fg-postgres
```

Danach Django starten:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py runserver 127.0.0.1:8000
```

Das Terminal offen lassen.

Die API läuft anschließend unter:

```text
http://127.0.0.1:8000
```

---

## Terminal 2 – Frontend

```bash
cd ~/PycharmProjects/fg-meeting-traum

npm run dev
```

Das Frontend läuft anschließend unter:

```text
http://localhost:5173
```

Login:

```text
Username: alex
Password: DevPass1!
```

---

# PostgreSQL verwalten

Bestehenden Container starten:

```bash
docker start fg-postgres
```

Container stoppen:

```bash
docker stop fg-postgres
```

Status prüfen:

```bash
docker ps -a --filter name=fg-postgres
```

Logs anzeigen:

```bash
docker logs fg-postgres --tail 50
```

Prüfen, ob PostgreSQL auf Port 5432 erreichbar ist:

```bash
ss -ltnp | grep 5432
```

Wichtig:

```bash
docker run ...
```

nicht bei jedem Start erneut ausführen. Dieser Befehl legt den Container an und wird nur einmal benötigt.

Wenn folgende Meldung erscheint:

```text
Conflict. The container name "/fg-postgres" is already in use
```

existiert der Container bereits. Dann nur:

```bash
docker start fg-postgres
```

verwenden.

---

# Migrationen

Nach Backend-/Model-Änderungen:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py migrate
```

Prüfen, ob unbeabsichtigte Migrationen fehlen:

```bash
uv run python manage.py makemigrations --check
```

---

# Tests und Checks

## Frontend

Im Repository-Root:

```bash
cd ~/PycharmProjects/fg-meeting-traum

npm run build
npm run lint
```

## Backend

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py check
uv run python manage.py makemigrations --check
uv run python manage.py test
```

---

# Häufige Probleme

## PostgreSQL: Connection refused auf Port 5432

Fehler:

```text
connection to server at "127.0.0.1", port 5432 failed
```

Prüfen:

```bash
docker ps -a --filter name=fg-postgres
```

Falls der Container nicht läuft:

```bash
docker start fg-postgres
```

---

## Login gibt 401 zurück

Wenn `/api/auth/login/` mit `401` antwortet, stimmen Benutzername/Passwort nicht oder der Dev-User existiert in der aktuellen Datenbank noch nicht.

Dev-User erneut anlegen bzw. Passwort zurücksetzen:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py shell -c "
from django.contrib.auth import get_user_model
User = get_user_model()
user, _ = User.objects.get_or_create(username='alex')
user.set_password('DevPass1!')
user.is_active = True
user.save()
print('Dev login reset.')
"
```

Danach:

```text
alex / DevPass1!
```

---

## Login gibt 403 wegen CSRF zurück

Typischer Fehler:

```text
Origin checking failed - http://localhost:5173 does not match any trusted origins
```

Für die lokale Entwicklung kann der Vite-Proxy in
`apps/web/vite.config.ts` den Backend-Origin mitsenden:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8000',
      changeOrigin: true,
      headers: {
        Origin: 'http://127.0.0.1:8000',
      },
    },
  },
},
```

Nach einer Änderung an `vite.config.ts` Vite neu starten:

```bash
npm run dev
```

Lokale, maschinenspezifische Änderungen an `vite.config.ts` nicht versehentlich mit anderen Feature-Änderungen committen.

---

# Schnellstart

Wenn alles bereits eingerichtet ist:

### Terminal 1

```bash
docker start fg-postgres

cd ~/PycharmProjects/fg-meeting-traum/apps/api
uv run python manage.py runserver 127.0.0.1:8000
```

### Terminal 2

```bash
cd ~/PycharmProjects/fg-meeting-traum
npm run dev
```

Dann öffnen:

```text
http://localhost:5173
```

Login:

```text
alex
DevPass1!
```
