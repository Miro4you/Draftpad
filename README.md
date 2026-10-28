# Draftpad

Technische Skizzen im Browser – schnell wie auf Papier, sauber wie CAD.
Primär für das iPad mit Apple Pencil gebaut, funktioniert auch mit Maus und Tastatur.
Das vollständige Konzept und der Phasenplan stehen in [CONCEPT.md](CONCEPT.md).

## Stand: Phase 1 – 4

- Unendlicher Canvas in Millimetern: Verschieben, Zoomen, Drehen (rastet bei 0°/45°/90° ein)
- Bleistift 0,3 · 0,5 · 0,7 · 0,9 mm und Tusche 0,18 · 0,25 · 0,35 · 0,5 · 0,7 mm
- Graphit mit Papierkorn, das fest auf dem Papier sitzt (kein Flimmern beim Zoomen); bei starkem Zoom leicht ausgefranste Ränder
- Linienarten nach ISO 128: Voll, Strich, Strich-Punkt, Strich-Zweipunkt – Strichmuster skalieren mit der Stiftstärke
- Freihand-Werkzeug mit einstellbarer Glättung („Schnur“ wie in Sketchbook)
- Heller und dunkler Modus (oder wie das System)
- Linien-Werkzeug nach Sketchbook-Vorbild: gestrichelte Vorschau bis zum Absetzen, Live-Anzeige von Länge und Winkel
- Fang an Endpunkten, Mitten und Schnittpunkten (Radius in Bildschirm-Pixeln → beim Reinzoomen feiner)
- Winkelfang in 5°-, 10°- oder 15°-Schritten mit drei Zuständen: Fang / nur Anzeige / aus – auch ohne Winkelfang rasten Linien innerhalb von 1° sanft auf 0°/45°/90° ein
- Korrekturgriffe an der zuletzt gezeichneten Linie (im Menü einschaltbar)
- Ebenen: anlegen, umbenennen, sortieren, ausblenden, sperren, blass anzeigen
- Rückgängig / Wiederholen (auch per Zwei- bzw. Drei-Finger-Tipp)
- Automatisches Speichern im Browser, Datei herunterladen und wieder öffnen
- Schwebende, verschiebbare Werkzeugleiste (dockt an Seitenrändern hochkant an)
- Als App installierbar (PWA, offlinefähig)

**Phase 2**

- Kreis: Mittelpunkt setzen, Radius aufziehen (Anzeige R und Ø), Mittellinienkreuz nach ISO, Griffe zum Verschieben und für den Radius
- Bogen: am Startpunkt in die gewünschte Startrichtung losziehen, dann zum Endpunkt – auf Linien, Bögen und Kreisen (Ende, Mitte oder irgendwo darauf) tangential vor- oder rückwärts, im freien Raum in Zugrichtung (rastet wie Linien); zurück zum Start wählt die Richtung neu; Variante „Bogen um Mittelpunkt“: Mittelpunkt → Radius → Winkel
- Fang zusätzlich an Kreismittelpunkten, Quadrantenpunkten, Bogenenden und Schnittpunkten mit Kreisen/Bögen
- Symmetrieachsen: jede Strich-Punkt-Linie wird automatisch Achse, eigenes Achsenkreuz-Werkzeug, oder Linie auswählen → „Symmetrieachse“; alles Neue wird live gespiegelt, bei zwei Achsen in alle vier Quadranten; Knopf an der Achse schaltet das Spiegeln an/aus
- Löschen: ganze Objekte (antippen oder drüberwischen), Trimmen bis zum nächsten Schnittpunkt (antippen oder quer drüberwischen), Radierer, der Linien, Kreise und Striche zerteilt; Objekt löschen und Trimmen wirken bei aktiver Spiegelung auch auf die Spiegelbilder
- Auswahl: antippen (mehrere nacheinander), Schlinge, Verschieben mit Fang, Drehknopf, Griffe an Linien, Kreisen und Bögen; Leiste mit Duplizieren, 90° drehen, Spiegeln, Ebene wechseln, Achse, Mittellinien, Löschen
- Stift, Linienart und Farbe wirken auch auf die Auswahl
- Farben: Standard (Graphit/Schwarz), zehn Farben oder eigene Farbe
- Trimmen erkennt auch Stoßstellen (Linie endet auf einer Linie)

**Phase 3**

- Schraffur: in eine geschlossene Fläche tippen; Lücken bis 0,5 oder 1 mm werden überbrückt; die Schraffur passt sich an, wenn danach Linien dazukommen oder sich ändern (neue Bohrungen werden ausgespart); ist die Fläche offen, werden die offenen Stellen kurz rot markiert, Inseln (z. B. Bohrungen) bleiben frei; Muster 45°, −45°, Kreuz, Doppellinie (Stahl), voll/gestrichelt (Kunststoff), Punkte; Abstand 1–5 mm; die Schraffurlinien bekommen den gewählten Stift (für ISO einen dünnen wählen). Antippen einer vorhandenen Schraffur übernimmt Muster und Abstand
- Bemaßung nach DIN 406: geschlossene Pfeile, Maßzahl über der Maßlinie, von unten oder rechts lesbar
  - Punkt zu Punkt ziehen, dann Maßlinie platzieren (waagerecht, senkrecht oder parallel – je nachdem, wohin man zieht)
  - Linie antippen und Maßlinie platzieren · Kreis antippen → Ø · Bogen antippen → R · zwei Linien antippen → Winkel (der Zeiger wählt den Quadranten)
  - Maßtext über die Auswahlleiste ändern (leer = gemessener Wert); Schraffur wird hinter Maßzahlen ausgespart
- ISO-GPS: Bezugsdreieck mit Buchstabenrahmen (A, B, … automatisch fortlaufend) und Toleranzrahmen mit allen 14 Symbolen nach ISO 1101, Toleranzwert, Ø und bis zu drei Bezügen
- Zeichnungsmaßstab (oben rechts, z. B. „1:10“): Längen bleiben echte Millimeter, Strichstärken, Maßzahlen, Pfeile, Texte und Schraffurabstände werden wie auf dem Papier im Maßstab vergrößert. Solange die Zeichnung leer ist, folgt er dem Zoom (kursiv), der erste Strich legt ihn fest; danach frei wählbar (2:1 bis 1:100, rückgängig machbar, wird live mit synchronisiert). Ein Blatt übernimmt den Maßstab und umgekehrt
- Zeitraffer-Video (Menü): „Ganzer Ablauf“ zeigt jeden Schritt, wie er passiert ist – Linien und Kreise wachsen, Maße und Schraffuren blenden ein, Gelöschtes verblasst, beim Trimmen verschwinden die abgeschnittenen Enden, Verschobenes blendet über, Ebenen blenden beim Ein-/Ausblenden (z. B. die Skizze am Schluss). Dafür schreibt die Zeichnung ihren Ablauf mit (wird mit gespeichert und live synchronisiert; Zeichnungen von vorher beginnen mit ihrem damaligen Stand). „Nur Ergebnis“ baut die fertige Zeichnung in Zeichenreihenfolge auf und blendet am Ende ausgeblendete Ebenen aus. Ausschnitt: alles, die aktuelle Ansicht, die Auswahl oder das Blatt; Auflösung 720p, 1080p, 1440p oder 4K. Schnellzugriff über die Kamera-Taste oben rechts. Das Video beginnt mit dem fertigen Ergebnis (Vorschaubild in Fotos/Bibliothek) und blendet dann zum leeren Blatt über. Quer, hoch oder quadratisch, 10–60 s, Vorschau im Dialog, Aufnahme als MP4 (Safari/iPad, Chrome) oder WebM, speichern oder teilen
- Export (Menü → Exportieren, ⇧⌘E): PDF und SVG als Vektor im Zeichnungsmaßstab, PNG und JPEG mit Bleistift-Struktur in 150/300/600 dpi, alles oder nur die Auswahl, PNG/SVG auch transparent

**Phase 4**

- Rechteck von Ecke zu Ecke (aus vier echten Linien, also trimm- und verrundbar)
- Ecken verrunden: an eine Ecke zweier Linien tippen (Radius 1/2/3/5/10 mm oder „Ecke“ = scharf schließen/verlängern) oder an der Ecke drücken und ziehen – der Radius folgt dem Stift; bei sich kreuzenden Linien gilt der angetippte Quadrant
- Text: Startpunkt antippen (oder ziehen für die Schreibrichtung), mehrzeilig, Schrifthöhe 2,5–10 mm; vorhandenen Text antippen zum Ändern
- Blatt & Schriftfeld (Menü): A4–A0, hoch/quer, Maßstab 2:1 bis 1:10, Rahmen nach ISO 5457 mit Mittenmarken, Schriftfeld (Benennung, Zeichnungsnummer, Werkstoff, Maßstab, Format, Gezeichnet, Datum, Firma) auf eigener Ebene „Blatt“; Export „Blatt“ gibt genau das Papierformat im Maßstab aus
- Graphit-Härten 2H / HB / 2B (hell bis dunkel) im Stift-Menü
- Online-Ablage auf dem eigenen Server (z. B. Raspberry Pi): Zeichnungen mit Vorschaubild speichern, öffnen, überschreiben, löschen; optional mit Passwort

**Feedback-Runde nach Phase 4**

- Schwebender Pencil zeigt einen kleinen Cursorpunkt; Zeichenwerkzeuge zeigen den Fangpunkt, den ein Aufsetzen träfe, und blass die Fangpunkte in der Nähe
- Linien- und Bogenmitten fangen schon aus 1,8-facher Entfernung entlang der Linie
- Bogen startet überall tangential (auch mitten auf Linien, vor- oder rückwärts) bzw. in Zugrichtung
- Bemaßung: Maßzahl ziehen (entlang, nach außen, Abstand der Maßlinie) – Bezugspunkte bleiben stehen; Doppeltippen bearbeitet den Text
- Nachzeichnen (N): Linien anderer Ebenen antippen oder überwischen → Kopie mit dem aktuellen Stift auf der aktiven Ebene
- Linienlängen, Radien und Rechteckseiten rasten in 0,5-mm-Schritten (Winkel-Menü: frei / 0,1 / 0,5 / 1 mm); Shift halten oder einen Finger auflegen zeichnet frei – Fangpunkte gehen immer vor
- Neues App-Icon – auf dem iPad das Home-Bildschirm-Symbol einmal entfernen und neu hinzufügen, damit es erscheint

**Technik (Taste M, Freikörperbild)**

- Festlager, Loslager, Einspannung, Gelenk: auf den Punkt tippen (Lager zeigen nach unten) oder drücken und Richtung Boden ziehen (15°-Schritte); eine Einspannung auf einem Linienende setzt die Linie in die Wand fort
- Einzelkraft: auf den Angriffspunkt drücken und zum Pfeilende ziehen – die Spitze bleibt am Punkt, Winkel und Länge rasten wie bei Linien; Tippen = Kraft von oben
- Moment: auf den Punkt drücken und wegziehen (Radius und Pfeilanfang), Drehsinn im Gruppenmenü; Spiegeln dreht ihn um
- Streckenlast: vom Anfang bis zum Ende der Last ziehen; die Pfeile kommen von oben, die Höhe lässt sich mit dem Griff ändern
- Beschriftungen werden automatisch nummeriert (F₁, M₁, q₁ …); doppelt antippen zum Ändern, z. B. „F_1 = 500 N“ – der Unterstrich setzt den Index
- Alles rastet an Endpunkten, Mitten und auf Linien ein, lässt sich auswählen, verschieben, drehen, spiegeln und exportieren

**Werkzeugleiste (neu sortiert)**

Auswahl · Linie · Formen (Kreis, Rechteck, Bogen, Bogen um Mittelpunkt, Achsenkreuz, Freihand) · Schraffur · Beschriften (Maß, Bezug, Toleranzrahmen, Text) · Technik (Lager, Kraft, Moment, Streckenlast) · Löschen (Objekt, Trimmen, Radierer) · Sonderwerkzeuge (Verrunden, Nachzeichnen). Optionen eines Werkzeugs (Glättung, Schrifthöhe, Radius, Schraffurmuster) erscheinen im Gruppenmenü, solange es aktiv ist.

**Normteile (Taste I, Gruppe Sonderwerkzeuge)**

Durchgangsbohrung (ISO 273), Gewindebohrung, Zylinderschraube ISO 4762, Sechskantschraube ISO 4017, Sechskantmutter ISO 4032, Rillenkugellager DIN 625 (60xx/62xx), Nuten für Sicherungsringe DIN 471/472 – jeweils mit Größe, Ansicht (Seite/Schnitt oder Draufsicht) und Länge bzw. Tiefe. Das Teil folgt dem Stift und rastet an Mittelpunkten und Linien; Einfügewinkel 0°, 45°, 90°, 135°, 180° oder frei (im Katalog und in den Werkzeug-Optionen, die Vorschau dreht mit); antippen setzt das Teil, bei „frei“ dreht Drücken und Ziehen es vorher. Eingefügt werden normale Linien, Kreise und Bögen. Die Maße stammen aus den üblichen Normtabellen – für kritische Maße bitte das Normblatt prüfen.

**Live bearbeiten (PC und iPad gleichzeitig)**

In der Online-Ablage bei einer Zeichnung „Live“ wählen – auf jedem Gerät, das mitmachen soll. Jede fertige Aktion (Linie, Trimmen, Verschieben, Schraffur …) erscheint sofort auf den anderen Geräten, der Pi speichert laufend mit. Ansicht, Werkzeug, Stift und das Ein-/Ausblenden von Ebenen bleiben pro Gerät; Rückgängig betrifft die eigenen Schritte. Bricht die Verbindung ab, sammelt die App die Änderungen und schickt sie nach (auch nach einem Neuladen). Oben rechts zeigt ein Punkt den Zustand (grün = live, gelb = verbinde, rot = offline). Beide Geräte müssen die App über den Pi öffnen.

## Bedienung

| Eingabe | Aktion |
| --- | --- |
| Apple Pencil / linke Maustaste | Zeichnen |
| Ein Finger | Ansicht verschieben |
| Zwei Finger | Verschieben, Zoomen, Drehen |
| Zwei- / Drei-Finger-Tipp | Rückgängig / Wiederholen |
| Finger halten beim Zeichnen, oder Alt | Fang kurz aussetzen |
| Shift halten | Längen frei statt in Schritten |
| Mausrad | Zoomen |
| Leertaste + Ziehen, mittlere/rechte Maustaste | Verschieben |
| V · F · L · C · B | Auswahl · Freihand · Linie · Kreis · Bogen |
| K | Achsenkreuz |
| X · T · E | Objekt löschen · Trimmen · Radierer |
| H · D · P · M | Schraffur · Bemaßung · GPS-Symbol · Technik (Lager, Kräfte) |
| Q · U · W · N · I | Rechteck · Ecken verrunden · Text · Nachzeichnen · Normteil |
| Entf · ⌘D · ⌘A · Pfeile | Auswahl löschen · duplizieren · alles wählen · verschieben |
| 1–4 | Linienart (Voll, Strich, Strich-Punkt, Strich-Zweipunkt) |
| ⇧1–⇧4 / ⇧5–⇧9 | Bleistift- / Tuschestärken |
| S / A / G | Fang / Winkelmodus / Raster |
| 0 / R | Alles zeigen / Ansicht gerade |
| ⌘Z / ⇧⌘Z | Rückgängig / Wiederholen |
| ⌘S / ⌘O / ⇧⌘E | Herunterladen / Öffnen / Exportieren |

## In andere Apps einbetten (z. B. MathPad)

- `src/embed.ts` → `mountDraftpad(root, { drawing, onChange, onDone, labelResolver, theme })` startet den Editor in einer eigenen Seite (typisch: ein iframe derselben Herkunft, denn der Editor bringt seitenweite Styles und Tastenkürzel mit). Kompaktmodus (Standard): nur Tusche dünn/dick, keine Ebenen, kein Zeitraffer, keine Online-Ablage, kein Blatt; oben ein „Fertig“-Knopf. Änderungen gehen (ohne Zeitraffer-Verlauf) an `onChange` statt ins Browser-Autosave.
- `labelResolver` macht aus gespeicherten Beschriftungen (Kräfte, Momente, Streckenlasten und eingetippte Maßtexte) die Anzeige, z. B. `F_1` → `F_1 = 500 N` oder `l` → `l = 2 m` aus den Variablen des Gastgebers; `handle.refreshLabels()` zeichnet nach Wertänderungen neu.
- `src/export/drawing-svg.ts` → `drawingToSvg(drawing, { theme })` liefert die Zeichnung als SVG ohne Editor und ohne Styles – zum Anzeigen im Gastgeber.
- Demo: `npm run dev`, dann `/embed-demo.html`.

## Entwicklung

```bash
npm install
npm run dev        # Entwicklungsserver (auch im LAN erreichbar, z. B. vom iPad)
npm test           # Unit-Tests
npm run build      # Typecheck + Produktions-Build nach dist/
npm run preview    # Build lokal ansehen
```

### Auf dem Raspberry Pi betreiben (mit Online-Ablage)

```bash
git pull
npm install
npm start          # baut die App und startet den Server auf Port 8080
```

Dann auf dem iPad `http://<IP-des-Pi>:8080` öffnen und zum Home-Bildschirm hinzufügen. Der Server (`server/server.mjs`, nur Node.js, keine weiteren Pakete) liefert die App aus und legt Zeichnungen als JSON-Dateien in `data/` ab. Einstellungen über Umgebungsvariablen:

| Variable | Bedeutung |
| --- | --- |
| `PORT` | Port (Standard 8080) |
| `DATA_DIR` | Ablageordner (Standard `./data`) |
| `TOKEN` | Optionales Passwort für die Ablage – in der App unter Online-Ablage → Verbindung eintragen |

Dauerhaft laufen lassen, z. B. mit systemd (`/etc/systemd/system/skizzen-cad.service`):

```ini
[Unit]
Description=Draftpad
After=network.target

[Service]
WorkingDirectory=/home/pi/Miro4you
ExecStart=/usr/bin/node server/server.mjs
Environment=PORT=8080
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now skizzen-cad` – nach Updates `npm run build` und `sudo systemctl restart skizzen-cad`.

Technik: TypeScript, Vite, Canvas 2D, keine UI-Frameworks. Aufbau:

- `src/core` – Geometrie (Kurven, Schnittpunkte, Trimmen), Transformationen, Dokument mit Undo/Redo, Kamera, Fang, Stifte/Linienarten
- `src/render` – Szene (Papier, Raster, Objekte), Graphit-Textur, Overlay (Vorschau, Maße, Fangmarken)
- `src/tools` – Werkzeuge (Auswahl, Freihand, Linie, Rechteck, Kreis, Bogen, Achsenkreuz, Löschen, Trimmen, Radierer, Verrunden, Schraffur, Bemaßung, GPS, Text) und gemeinsame Griffe
- `src/export` – Vektor-Recorder, SVG- und PDF-Writer, Raster-Export
- `src/storage` – lokales Speichern und Online-Ablage
- `server/` – kleiner Node-Server für Pi/Heimnetz
- `src/input` – Pencil/Maus/Touch-Steuerung, Gesten, Tastatur
- `src/ui` – Werkzeugleiste, Ebenen, Menü
