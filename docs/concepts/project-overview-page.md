Die Anmerkungen verbessern das Konzept deutlich. Ich würde sie fast vollständig übernehmen und daraus jetzt eine **verbindliche Project-IA für Punkt 1** machen.

Der wichtigste Gewinn ist, dass damit ein paar noch vorhandene Widersprüche verschwinden: Overview zeigt weiterhin ausgewählte Work Items, wird aber **keine zweite Arbeitsfläche**, weil jeder Eintrag exakt dasselbe Work-Item-Overlay öffnet wie Board/List. Und der Project Shell wird wirklich stabil, weil die variable Beschreibung dort rausfliegt.

## Verbindliche Project-Struktur

Der Project Shell enthält künftig nur den stabilen Kontext:

```text
← Projects

ACTIVE

Paper XYZ Test                                  AL  CD  LD    Owner

Work Items    Overview    Settings
──────────────────────────────────────────────────────────────
```

**Nicht** im Shell:

* Beschreibung
* Project Goal
* KPIs
* Work-Item-Zahlen
* Activity
* Data-Platzhalter

Damit bleibt seine Höhe praktisch konstant.

Die drei Tabs sind für den aktuellen Produktstand ausreichend:

```text
Work Items | Overview | Settings
```

`Members` wandert als Bereich nach `Settings`. `Data` wird erst sichtbar, wenn dort tatsächlich eine nutzbare Funktion existiert.

Das reduziert nicht nur Navigation, sondern behebt einen Teil des Frankenstein-Eindrucks direkt: Es gibt weniger gleichgewichtige Oberflächen, die um Aufmerksamkeit konkurrieren.

---

# 1. Work Items ist die Default-Route

Das sollte nicht nur ein visueller Default sein, sondern eine echte URL-Struktur:

```text
/projects/123
        ↓ redirect
/projects/123/work-items
```

Weitere Routen:

```text
/projects/123/work-items
/projects/123/overview
/projects/123/settings
```

Damit funktionieren:

* Deep Links
* Browser Back/Forward
* Refresh
* geteilte Links
* später View-State pro Tab

sauber.

Das ist deutlich besser als einen internen React-State `activeTab = 'work-items'` zu verwenden.

---

# 2. Der leere Project-Start ist wichtiger als die fertige Overview

Das ist die stärkste Anmerkung.

Wenn Work Items die Default-Seite ist, sieht jeder neue Nutzer zunächst ein Projekt ohne Arbeit. Ein Board mit vier leeren Spalten wäre dafür die schlechteste erste Darstellung.

Ich würde den leeren Zustand deshalb **nicht einmal als leeres Board rendern**.

Stattdessen:

```text
Work Items


No work items yet.

Create the first piece of project work.

                         + New work item
```

Mehr nicht.

Keine Illustration.
Keine drei Erklärboxen.
Keine „Learn more“-Links.
Keine vier leeren Columns.

Sobald der erste Work Item existiert, erscheint die normale Work-Items-Ansicht.

Das erfüllt die Onboarding-Aufgabe mit genau einer Entscheidung:

> Arbeit anlegen.

---

# 3. Keine Filter-Toolbar in v1

Hier würde ich ebenfalls korrigieren.

Bei kleinen Forschungsprojekten:

```text
Search | Assignee | Type | Status | Filters
```

zu zeigen, bevor das Problem existiert, macht die Oberfläche technisch statt arbeitsorientiert.

Für jetzt würde ich die Toolbar auf:

```text
Work Items  8                         + New work item    Board | List
```

reduzieren.

Die Avatare im Project Shell können später oder direkt jetzt eine sehr leichte Filterfunktion bekommen:

```text
AL   CD   LD
```

Klick auf Chris:

```text
AL  [CD]  LD
```

→ Work Items zeigt nur Items mit Chris.

Noch besser: derselbe Filter funktioniert sowohl in Board als auch List.

Ein zweiter Klick hebt ihn wieder auf.

Kein Popover nötig.

Das beantwortet tatsächlich eine typische Frage:

> Woran arbeitet Chris in diesem Projekt?

Bei ausreichend realer Menge können Search und erweiterte Filter später hinzukommen.

Ich würde **keine künstliche 30-Item-Grenze in Code schreiben**. Das ist nur das Entscheidungskriterium für uns: Erst bauen, wenn reale Nutzung zeigt, dass es gebraucht wird.

---

# 4. Overview wird Project Brief

Die Overview würde ich jetzt auf drei Bereiche reduzieren:

```text
Overview


About
────────────────────────────────────────

Research paper on XYZ.

                                         Edit


Milestones
────────────────────────────────────────

First draft
In progress                         Aug 30

Internal review
To do                              Sep 14


Needs attention
────────────────────────────────────────

BLOCKED
MVP Chris Task
Chris

UNASSIGNED
Finalize figures
No assignee

OVERDUE
First Draft Complete
Alex                               Aug 17
```

Das ist bereits ein echtes Overview.

Nicht enthalten:

* Activity
* Filter
* Charts
* Fortschritts-KPIs
* Health
* Project Update
* Mini-Board
* Work-Item-Suche

---

# 5. Harte Regel für Milestones und Needs Attention

Das löst den von dir beschriebenen Widerspruch:

> **Jeder Work-Item-Eintrag außerhalb von Work Items öffnet immer dasselbe Work-Item-Overlay.**

Also:

```text
Overview
→ Needs attention
→ "Finalize figures"
→ click
```

öffnet:

```text
Overview                         Work item
                                 ───────────────
                                 Finalize figures
                                 ...
```

Nicht:

```text
→ /work-items?filter=unassigned
```

Nicht:

```text
→ neue Detailseite
```

Nicht:

```text
→ eigener Overview-Editor
```

Dasselbe gilt für einen Milestone.

Damit haben wir:

**mehrere Einstiegspunkte, aber nur einen Bearbeitungsmechanismus.**

Das ist die entscheidende Unterscheidung.

---

# 6. Needs Attention bekommt drei objektive Regeln

Für v1:

```text
Blocked
blockedReason != null
AND status != done
```

```text
Overdue
dueDate < today
AND status != done
```

```text
Unassigned
assigneeIds.length === 0
AND status != done
```

`Unassigned` halte ich inzwischen ebenfalls für mindestens so wichtig wie Overdue.

Gerade weil:

```text
unassigned
→ erscheint nicht in My Work
→ braucht keine dueDate
→ kann sonst unbegrenzt verschwinden
```

Das ist ein sehr guter systemischer Kontrollpunkt.

### Priorität

Wenn ein Item mehrere Kriterien erfüllt, würde ich es **nur einmal** anzeigen.

Reihenfolge:

```text
Blocked
Overdue
Unassigned
```

Ein blockierter und überfälliger Task erscheint also als `Blocked`, nicht doppelt.

Das reduziert Lärm.

---

# 7. Milestone-Sortierung wird definiert

Keine implizite Datenbank-Reihenfolge.

Für:

```text
type === 'milestone'
```

gilt:

1. nicht erledigte zuerst,
2. danach `dueDate` aufsteigend,
3. Milestones ohne `dueDate` ans Ende,
4. abgeschlossene anschließend,
5. als stabiler Tie-Breaker z. B. `createdAt` oder ID.

Für die erste Implementierung kann es sogar einfacher sein:

```text
dueDate ASC NULLS LAST
```

mit Done visuell zurückgenommen.

Wichtig ist nur: **Die Reihenfolge ist Produktentscheidung und nicht Zufall.**

---

# 8. Members gehört in Settings

Auf Projektebene würde ich jetzt tatsächlich:

```text
Settings

General
────────────────────
Name
Description
Status


Access
────────────────────
Alex                Owner
Chris               Member
Laura               Viewer

                        + Add member
```

bauen.

Damit wird auch semantisch klar:

> Project Membership ist Zugriffskontrolle.

Nicht ein eigenständiger Arbeitsbereich.

Die Personen im Shell beantworten dagegen lediglich:

> Wer gehört zu diesem Projekt?

Das ist eine sinnvolle Trennung.

---

# 9. Was passiert mit `Data`?

Ausblenden.

Nicht disabled anzeigen.

Nicht:

```text
Data   Coming soon
```

Wenn noch kein echter Arbeitsablauf dahinter liegt, existiert der Tab aus Nutzersicht nicht.

Sobald Data eine relevante Funktion bekommt, können wir neu entscheiden, ob es wieder ein Haupttab sein soll.

---

# 10. Project Goal: bewusst noch nicht als neues Feld

Hier würde ich als einzigen Punkt etwas vorsichtiger sein als die Anmerkungen.

**Konzeptionell** ist ein Project Goal/Forschungsfrage wertvoll.

Aber ich würde es nicht mit diesem reinen IA-/Design-Slice vermischen.

Aktuell haben wir bereits:

```text
description
```

Damit können wir in `About` bereits beantworten:

> Worum geht es?

Ein neues Feld:

```text
goal
description
```

erzeugt sofort eine neue semantische Entscheidung:

> Was gehört in Goal und was in Description?

Wenn wir dafür noch keine klare Nutzersemantik haben, haben wir nur zwei ähnliche Textfelder geschaffen.

Deshalb würde ich festhalten:

> **Project Goal ist ein bewusst zurückgestelltes Domain-Feld, nicht versehentlich vergessen.**

Wenn wir später merken, dass Forschungsfrage/Ziel und Projektbeschreibung tatsächlich zwei unterschiedliche Dinge sind, können wir es sauber ergänzen.

---

# Damit ist Punkt 1 für mich jetzt klar definiert

Die endgültigen Regeln wären:

1. **Project Shell:** Back, Status, Name, Personen, Rolle, Tabs. Keine Beschreibung.
2. **Nur drei sichtbare Tabs:** Work Items, Overview, Settings.
3. **`/projects/:id` redirectet zu `/projects/:id/work-items`.**
4. **Work Items ist Default und primärer Arbeitsort.**
5. **Leeres Projekt zeigt einen gezielten Empty State statt eines leeren Boards.**
6. **Keine Search-/Filter-Toolbar, solange der reale Bedarf nicht existiert.**
7. **Shell-Avatare können als leichter Assignee-Filter dienen.**
8. **Overview = About + Milestones + Needs Attention.**
9. **Needs Attention = Blocked + Overdue + Unassigned.**
10. **Milestones werden deterministisch nach Fälligkeit sortiert.**
11. **Overview-Einträge öffnen immer das kanonische Work-Item-Overlay.**
12. **Members wird `Settings → Access`.**
13. **Data bleibt unsichtbar, bis es tatsächlich funktioniert.**
14. **Keine Activity, Charts, Health oder Project Updates in diesem Slice.**
15. **Project Goal bleibt bewusst ein späterer Domainentscheid.**

Damit ist die Informationsarchitektur wesentlich kohärenter als die jetzige Oberfläche.

Und ich würde die Umsetzung auch nicht mit der Overview beginnen. Reihenfolge:

```text
1. Project Shell + Routing + Tabs
2. Work-Items Empty State
3. Members → Settings
4. Overview vereinfachen
5. Needs Attention + Milestones
6. Overlay-Verknüpfung
7. Avatar-Assignee-Filter
```

So entsteht bereits nach den ersten zwei Schritten ein deutlich ruhigeres Produkt, bevor wir überhaupt neue Overview-Inhalte bauen.
