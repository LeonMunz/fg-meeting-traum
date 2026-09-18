# fg-meeting-traum

## Lokale Entwicklung

### Voraussetzungen

Benötigt werden:

- Docker
- Node.js 24 + npm (`.nvmrc`: `24`, `engines`: `>=24`)
- Python >= 3.12 (`apps/api/pyproject.toml`: `requires-python = ">=3.12"`)
- `uv`
- PostgreSQL 16 (lokale Referenzversion, konsistent mit CI: `postgres:16`)

Die lokale Anwendung besteht aus:

- PostgreSQL: `localhost:5432`
- Django API: `http://127.0.0.1:8000`
- Vite Frontend: `http://localhost:5173`

---

## 1. Einmalige Einrichtung

### Frontend-Abhängigkeiten installieren

Node-Version gemäß `.nvmrc` verwenden, dann im Repository-Root:

```bash
cd ~/PycharmProjects/fg-meeting-traum

nvm use   # setzt Node 24 gemäß .nvmrc (ohne nvm: direkt Node 24 installieren)
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
  postgres:16
```

Die Datenbankdaten bleiben im Docker-Volume `fg-postgres-data` erhalten.

Danach Migrationen ausführen:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py migrate
```

Optional – Playwright-Chromium für lokale E2E-Nutzung installieren:

```bash
cd ~/PycharmProjects/fg-meeting-traum

npx playwright install chromium
```

---

## 2. Development-Seed anlegen

Der kanonische Dev-Seed ist der idempotente Management-Command `seed_dev`
(`apps/api/accounts/management/commands/seed_dev.py`):

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py migrate
uv run python manage.py seed_dev
```

`seed_dev` legt diese Daten an (alle Werte aus `seed_dev.py` abgeleitet):

- Benutzer `alex`, `chris`, `maria`, `laura` (E-Mail `<benutzer>@example.com`)
- Research Group `FG Example`: `alex` = admin, `chris`/`maria`/`laura` = member
- Projekt `Paper XYZ`: `alex` = owner, `chris` = member, `laura` = viewer,
  `maria` = keine Mitgliedschaft
- Projekt `Maria Private Project`: `maria` = owner, alle anderen ohne
  Mitgliedschaft
- Work Items in `Paper XYZ`: Epic `Literature Review`, Task `Rewrite
  Introduction` (Assignee `chris`), Milestone `First Draft Complete`
  (Assignee `alex`)

### Seed-Passwort

Standardmäßig haben alle neu angelegten Seed-Benutzer das Passwort
`DevPass1!` (Default der Environment-Variable `SEED_PASSWORD` in
`seed_dev.py`). Das Passwort kann vor dem Command überschrieben werden:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

SEED_PASSWORD="MeinSaferesPasswort1" uv run python manage.py seed_dev
```

Wichtig: `seed_dev` setzt das Passwort nur für **neu angelegte** Benutzer;
existierende Benutzer behalten ihr bestehendes Passwort.

### Idempotenz

Erneute Ausführung ist sicher: `seed_dev` verwendet durchgängig
`get_or_create`, erzeugt keine Duplikate und stellt damit reproduzierbar
den kanonischen Seed-Zustand her (belegt u. a. durch
`apps/api/accounts/test_seed_dev.py`).

Login (frisch seedete Datenbank; alle Seed-Benutzer mit dem Seed-Passwort):

```text
Username: alex
Password: DevPass1!
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

Der Vite-Dev-Server leitet `/api` an das Backend weiter (Proxy-Ziel,
Standard: `http://127.0.0.1:8000`; siehe `apps/web/vite.config.ts`).
Läuft das Backend auf einer anderen Adresse, kann das Ziel über
`FG_API_PROXY_TARGET` in einem lokalen, git-ignorierten Env-File
überschrieben werden (Referenz: `apps/web/.env.example`, z. B.
`apps/web/.env.local`):

```bash
# apps/web/.env.local (git-ignoriert, nicht committen)
FG_API_PROXY_TARGET=http://127.0.0.1:8001
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

Prüfen, ob PostgreSQL auf Port 5432 erreichbar ist (macOS):

```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
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

## Frontend-Zieltests (Vitest)

```bash
# Eine Testdatei
npm run test:unit --workspace=web -- src/<pfad-zur-testdatei>

# Einzelner Testfall in einer Testdatei
npm run test:unit --workspace=web -- src/<pfad-zur-testdatei> -t "<testname>"
```

Achtung: `npm run test:unit` ohne `--workspace=web` ist am Repository-Root
kein gültiger Aufruf (dort existiert kein solches Script); die
Workspace-Qualifizierung gehört zum kanonischen Befehl.

## Backend

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

uv run python manage.py check
uv run python manage.py makemigrations --check
uv run python manage.py test
```

## Backend-Zieltests (Django)

`uv run python manage.py test <app-oder-testpfad>` akzeptiert App-,
Modul-, Klassen- oder Methodenpfade:

```bash
cd ~/PycharmProjects/fg-meeting-traum/apps/api

# App
uv run python manage.py test accounts

# Testmodul
uv run python manage.py test accounts.test_seed_dev

# Einzelne Testmethode
uv run python manage.py test accounts.test_seed_dev.SeedDevIdempotencyTest.test_seed_dev_runs_twice_without_duplicates
```

## E2E (Playwright)

Kanonischer Agentenpfad (mit explizitem Consent für den destruktiven Reset
des isolierten `fg_e2e`-Schemas):

```bash
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e [optionale playwright-argumente]
```

Beispiele (Playwright-Argumente werden an `playwright test` durchgereicht):

```bash
# Komplette E2E-Suite
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e

# Einzelne Spec
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e e2e/login.spec.ts

# Einzelner Test über -g (Namensmuster)
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e e2e/login.spec.ts -g "logs in and keeps the session across a reload"

# Headed (Browser sichtbar)
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e --headed

# Playwright-UI-Modus
FG_ALLOW_E2E_RESET=1 ./scripts/agent-verify.sh e2e --ui
```

Alternativ über die Root-npm-Scripts (ebenfalls mit Consent):

```bash
FG_ALLOW_E2E_RESET=1 npm run test:e2e -- e2e/login.spec.ts
FG_ALLOW_E2E_RESET=1 npm run test:e2e:headed
FG_ALLOW_E2E_RESET=1 npm run test:e2e:ui
```

### Consent-Vertrag

Jeder echte E2E-Lauf muss `FG_ALLOW_E2E_RESET=1` sichtbar setzen. Der
Consent wird an zwei Stellen technisch geprüft:

1. im kanonischen Entrypoint `scripts/agent-verify.sh` (Profile `e2e`/`full`),
2. im destruktiven Management-Command `reset_e2e` selbst (zusätzlich mit
   `DJANGO_SETTINGS_MODULE=config.settings_e2e`).

Weil der Guard im `reset_e2e`-Command liegt, sind auch direkte
`npm run test:e2e`-, `npx playwright test`- und Management-Command-Aufrufe
geschützt. Der Reset betrifft ausschließlich das isolierte `fg_e2e`-Schema
der E2E-Konfiguration. Reine `--list`-Aufrufe starten keinen Webserver und
führen keinen Reset aus; sie benötigen daher keinen Consent.

## Harness-Vertragstests

Statische Vertragstests für den Verifikations-Harness und die CI-Workflows
(ohne Browser, ohne echte Profile, ohne CI-Ausführung; nicht Teil der
`agent-verify`-Profile und nicht von den CI-Workflows aufgerufen):

```bash
bash scripts/tests/agent-doctor.test.sh
bash scripts/tests/agent-verify.test.sh
bash scripts/tests/core-workflow.test.sh
bash scripts/tests/e2e-workflow.test.sh
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

Wenn `/api/auth/login/` mit `401` antwortet, stimmen Benutzername/Passwort
nicht oder die Seed-Benutzer existieren in der aktuellen Datenbank noch
nicht.

Fehlende Benutzer: `seed_dev` (siehe oben) erneut ausführen. Hinweis:
`seed_dev` setzt das Passwort nur für neu angelegte Benutzer; ein
bestehendes, abweichendes Passwort für `alex` wird so zurückgesetzt:

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

Diese Meldung bedeutet, dass der Request-Origin nicht in
`CSRF_TRUSTED_ORIGINS` (`apps/api/config/settings.py`) enthalten ist. Die
kanonischen Vite-Dev-Origine `http://localhost:5173` und
`http://127.0.0.1:5173` sind dort bereits vertraut, und der Vite-Proxy
sendet keinen ersetzten Origin — ein manueller `vite.config.ts`-Workaround
ist daher nicht erforderlich.

Prüfen: läuft das Frontend tatsächlich auf dem kanonischen Port 5173
(Vite weicht bei Portbelegung auf einen anderen Port aus)?

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
