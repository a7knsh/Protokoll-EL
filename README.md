# Protokoll-EL

Ein Desktop-Programm für **Windows und Linux**, mit dem HTL-Schüler (Elektronik und Technische Informatik)
ihre Protokolle schneller schreiben: Vorlage wählen, Abschnitte ausfüllen, als PDF abgeben.

## Was es kann

- **10 Vorlagen** für alle üblichen Protokollarten:
  Laborprotokoll, KiCad / Leiterplattenentwurf, Fertigung / Werkstätte, Mikrocontroller / Embedded,
  Programmierübung, Netzwerktechnik, Digitaltechnik / FPGA, Schaltungssimulation,
  Projekt- / Arbeitsbericht und ein leeres Protokoll für jedes andere Fach.
- **Tipps in jedem Abschnitt** („Was gehört hier hinein?“) – sie erscheinen nur im Editor, nie im fertigen Protokoll.
- **Live-Vorschau** neben dem Editor, mit Deckblatt, Inhaltsverzeichnis und automatischer Nummerierung
  von Abschnitten, Abbildungen, Tabellen, Listings und Formeln.
- **Bausteine:** Text (Markdown), Bilder (auch per Strg+V oder Drag & Drop), Tabellen, Code, Formeln (LaTeX, mit kleiner Formelsammlung).
- **Messwerttabellen mit Diagramm:** Werte aus Excel/LibreOffice einfügen oder CSV importieren, Haken bei „Diagramm“ –
  die Kennlinie wird automatisch gezeichnet (auch logarithmisch, z. B. für Frequenzgänge).
- **KiCad-Import:** Schaltplan, Layout (Ober-/Unterseite) und Stückliste direkt aus einem KiCad-Projekt übernehmen
  (benötigt `kicad-cli`, das ab KiCad 7 mitinstalliert wird; Stückliste ab KiCad 8).
- **Profil:** Name, Klasse, Schule einmal eintragen – stehen dann auf jedem Deckblatt.
- **Vollständigkeits-Check:** zeigt fehlende Kopfdaten, leere Abschnitte, Bilder/Tabellen ohne Beschriftung.
- **Eigene Vorlagen:** ein fertiges Protokoll als Vorlage speichern, z. B. wenn ein Lehrer einen eigenen Aufbau verlangt.
- **Export** als PDF (A4, mit Kopfzeile und Seitenzahlen) oder als eigenständige HTML-Datei.
  Gespeichert wird in einer einzelnen `.protokoll`-Datei, Bilder inklusive.

## Starten (Entwicklung)

Voraussetzung: [Node.js](https://nodejs.org) 20 oder neuer.

```bash
npm install
npm start
```

## Installationsdateien bauen

```bash
npm run dist:win     # Windows: Installer und portable .exe  (auf Windows ausführen)
npm run dist:linux   # Linux: AppImage und tar.gz            (auf Linux ausführen)
```

Die Dateien liegen danach im Ordner `dist/`. Alternativ baut GitHub beide Varianten:
unter **Actions → Build → Run workflow** (oder automatisch bei einem Tag wie `v0.1.0`).

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Strg+N | Neues Protokoll aus Vorlage |
| Strg+O | Öffnen |
| Strg+S / Strg+Umschalt+S | Speichern / Speichern unter |
| Strg+P | PDF exportieren |
| Strg+V | Bild (Screenshot) in den aktiven Abschnitt einfügen |

## Aufbau des Projekts

| Datei | Inhalt |
| --- | --- |
| `main.js`, `preload.js` | Electron-Hauptprozess: Dateien, PDF-/HTML-Export, KiCad-Import |
| `src/js/templates.js` | Die Vorlagen und die Formelsammlung – hier lassen sich neue Vorlagen ergänzen |
| `src/js/render.js` | Protokoll → HTML, Diagramme, Vollständigkeits-Check |
| `src/js/app.js` | Editor, Vorschau, Dialoge |
| `src/styles/document.css` | Aussehen des fertigen Protokolls |
| `test/run.js` | End-to-End-Test der echten App (`npm test`, benötigt Playwright) |
