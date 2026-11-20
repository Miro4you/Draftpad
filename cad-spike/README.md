# CAD-Machbarkeitstest

Ein Wegwerf-Prototyp, der eine Frage beantworten soll: Taugt ein echter CAD-Geometriekern (OpenCASCADE als
WebAssembly, über *replicad*) im Browser auf dem iPad für ein eigenes, stiftbedientes CAD-Modul mit FEM- und
3D-Druck-Anbindung?

Liegt vorerst hier im Draftpad-Repo. Wird daraus etwas, bekommt es ein eigenes Repo.

## Starten

```bash
cd cad-spike
npm install
npm run dev        # http://<rechner>:5173 – auch vom iPad im Heimnetz
# oder fürs iPad schneller:
npm run build && npm run preview   # http://<rechner>:4173
```

Messung ohne Browser: `npx tsx bench/bench.ts`

## Was der Test kann

- **Skizze mit Stift** (links): Linienzug mit Fang an Endpunkten, 15°-Winkelraster und 0,5-mm-Längenraster
  (Shift = frei), Rechteck, Kreis. Ein Linienzug, der an seinem Anfang endet, wird zum geschlossenen Profil.
  Finger verschieben/zoomen, sobald einmal der Stift benutzt wurde. Innere Profile werden zu Löchern.
- **Evolventen-Stirnrad** (DIN 867): Modul, Zähnezahl, Eingriffswinkel, Profilverschiebung, Flankenspiel, Bohrung.
  Anzeige Teil-/Kopf-/Fuß-/Grundkreis, Zahndicke am Kopf, Hinweis auf Unterschnitt.
  Flanken sind echte Evolventen (B-Spline, Abweichung < 0,1 µm), der Zahnfuß ist vereinfacht radial + Fußkreis
  (die echte Fußtrochoide kommt später).
- **Zykloidenscheibe** für Zykloidgetriebe: Bolzenzahl N, Bolzenkreis R, Bolzenradius, Exzentrizität E,
  Lagerbohrung, Abtriebsbohrungen. Prüft, ob sich die Kurve selbst schneidet. Geprüft: Die Scheibe berührt in
  Grundstellung alle N Bolzen mit 0,000 mm Abstand.
- **Formelkurve** x(t), y(t) mit eigenen Variablen, mit Vorlagen (Epi-/Hypozykloide, Rosette/Kurvenscheibe,
  Ellipse, Spirale/Nocke). Damit lässt sich jede Kurve bauen, für die es kein eigenes Werkzeug gibt.
- **Körper**: Extrudieren, Deck-/Bodenkanten verrunden. Geht das Verrunden nicht, erscheint der Körper ohne Rundung
  mit Hinweis.
- **Ausgabe**: STEP (für Projekt-FEM und jedes CAD), STL, 3MF (öffnet in Bambu Studio / Orca).
- **An Projekt-FEM senden**: schickt das STEP über die Heimnetz-Freigabe an `/api/cad/open` – gleicher Name =
  neue Version, Lager und Lasten werden übertragen. Funktioniert nur, wenn diese Seite über http läuft
  (Pi/Vite), nicht von einer https-Seite aus.
- **Messung**: Zeiten für Kern laden, Profil, Verrunden, Netz, Export; Volumen, Masse in PLA.

## Ergebnisse (gemessen hier im Container, Chromium/Node – auf dem iPad noch zu messen)

| Fall | Körper | Anzeige-Netz | STEP |
|---|---|---|---|
| Kern laden (Start ohne Download) | 0,2–0,3 s | | |
| Platte mit 2 Bohrungen, r = 1 verrundet | 170 ms | 110 ms | 60 ms |
| Zahnrad m1 z20 / z80 | 90 / 150–185 ms | 70–110 ms | 70–160 ms |
| Zahnrad m1 z24, alle Kopf-/Fußkanten r = 0,2 verrundet | **10–11 s** | 0,6 s | 0,2 s |
| Zykloidenscheibe N = 12 mit 7 Bohrungen | 20–35 ms | 55–85 ms | 15–25 ms |
| Zykloidenscheibe, r = 0,5 verrundet | 0,4 s | | |
| Formelkurve (Rosette), r = 0,5 verrundet | 0,35–0,6 s | 0,4–0,6 s | 50–90 ms |

- **Download:** Der Kern ist 23 MB groß (gzip 7,3 MB). Einmal geladen, kann ihn der Browser bzw. die PWA cachen.
- **Teuer ist das Verrunden vieler gekrümmter Kanten** (Zahnrad: ~240 Kanten → 10 s). Alles andere ist interaktiv.
  Folgerung: Verrundungen als eigener, gezielter Schritt (nur ausgewählte Kanten), immer im Hintergrund-Worker,
  mit Fortschrittsanzeige. Bei Zahnrädern lieber Fase/Verrundung schon im 2D-Profil.
- **Gefundene Stolperfalle:** Löcher brauchen die umgekehrte Umlaufrichtung, sonst entstehen kaputte Körper
  (falsches Volumen, Verrunden scheitert). Ist gelöst (`orientLoop`).
- **Grenzen, die echt sind:** Spitzen (Epizykloide) und zu schmale Stege lassen sich nicht verrunden – das sagt der
  Test jetzt auch so.

## Noch offen (bewusst nicht im Test)

- Messung auf dem echten iPad (Speicher, Ladezeit über WLAN vom Pi, Zeichengefühl mit Pencil)
- Constraint-Solver für Skizzen (Maße ändern → Geometrie folgt), Feature-Historie, Skizze auf Körperfläche,
  Tasche/Drehen/Bohrung als Features, Gegenrad + Achsabstand automatisch, echte Fußtrochoide
- Stabile Flächennamen für Projekt-FEM (Lasten bleiben bei Änderungen an der richtigen Fläche)
- Bambu A1 mini direkt drucken (siehe Analyse im Chat): braucht Slicer + LAN-/Entwicklermodus
