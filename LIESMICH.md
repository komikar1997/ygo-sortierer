# YGO Karten-Sortierer

Web-App zum Scannen und Sortieren von Yu-Gi-Oh!-Karten – läuft komplett im Browser (Laptop oder Handy).

## Starten (Laptop)
```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Dann im Browser http://localhost:8765 öffnen. Beim ersten Start wird die Kartendatenbank (≈ 14.600 Karten, inkl. deutscher Namen) von YGOPRODeck geladen und im Browser gespeichert.

## Handy
Handy-Browser erlauben Live-Kamera nur über **HTTPS**. Möglichkeiten:
- Die 3 Dateien (`index.html`, `app.js`, `style.css`) kostenlos hosten, z. B. GitHub Pages oder Netlify Drop → HTTPS-Link am Handy öffnen.
- Ohne HTTPS funktioniert „Bild laden“ trotzdem (öffnet die Handykamera für ein Einzelfoto).

## So funktioniert's
- **Scannen nach:** Set-Code (z. B. `LOB-DE001`, am zuverlässigsten, liefert auch Set & Seltenheit) und/oder Kartenname.
- **Live-Scan:** Karte in den Rahmen halten → Stapel wird groß angezeigt, Ton/Ansage/Vibration. Karte kurz wegnehmen, bevor das nächste identische Exemplar kommt (oder „＋1“ drücken).
- **Regeln:** von oben nach unten, die erste passende entscheidet Stapel, Farbe, Ton, Alarm. Platzhalter im Stapelnamen: `{attribut}`, `{archetyp}`, `{kategorie}`, `{stufe}`, `{set}`, `{anfangsbuchstabe}`, `{typ}`, `{monsterart}`, `{deck}`, `{banlist}` …
- **Sprache:** Deutsche und englische Karten werden erkannt. Die Sprache kommt aus dem Set-Code (`-DE`/`-EN`) bzw. dem erkannten Namen und lässt sich im Ergebnis korrigieren.
- **Erstveröffentlichung:** erstes Erscheinen im TCG (Europa/USA), zusätzlich OCG (Japan) – im Scanergebnis und als Tabellenspalte.
- **Spielformate** (Tab „Regeln“): Zeitraum je Format, z. B. GOAT 01.01.2002–05.08.2005. Eine Karte gehört dazu, wenn ihre TCG-Erstveröffentlichung im Zeitraum liegt. Vorlage „Nach Spielformat“ sortiert danach.
- **Sammlung:** Spalten frei wählbar und verschiebbar („Spalten anpassen“), bis zu 3 Sortierstufen, Gruppieren, CSV-Export (mit den angezeigten Spalten), JSON-Backup.
- **Erkennung klappt nicht?** Einstellungen → „OCR-Ausschnitte anzeigen“ zeigt, was die Kamera liest.
