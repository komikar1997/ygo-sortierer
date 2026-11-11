# YGO Karten-Sortierer

Web-App zum Scannen und Sortieren von Yu-Gi-Oh!-Karten – läuft komplett im Browser (Handy oder Laptop).

**Online:** https://komikar1997.github.io/ygo-sortierer/

## Lokal starten (Laptop)
```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Dann im Browser http://localhost:8765 öffnen. Beim ersten Start wird die Kartendatenbank (≈ 14.600 Karten, inkl. deutscher Namen und Erscheinungsdaten) von YGOPRODeck geladen und im Browser gespeichert.
Handy-Browser erlauben die Kamera nur über **HTTPS** – am Handy daher den Online-Link nutzen.

## So funktioniert's
- **Kamera starten** → der Live-Scan läuft sofort. Mit „Pause“ anhalten.
- **Scannen nach:** Set-Code (z. B. `LOB-DE001`, am zuverlässigsten, liefert auch Set & Seltenheit) und/oder Kartenname.
- **🎯 Format-Suche:** Haken setzen und Format wählen (z. B. GOAT). Passt eine gescannte Karte ins Format, leuchtet alles grün und es kommt ein positiver Ton (plus Ansage/Vibration, falls eingeschaltet). Sonst nur ein kurzer leiser Ton.
- **Letzte Scans:** zeigen Kategorie, Format und Sprache; filterbar nach Kategorie und Format („Nur Format-Treffer“). Bleiben nach dem Neuladen erhalten.
- **Regeln:** von oben nach unten, die erste passende entscheidet Stapel, Farbe, Ton, Alarm. Platzhalter im Stapelnamen: `{attribut}`, `{archetyp}`, `{kategorie}`, `{stufe}`, `{set}`, `{format}`, `{jahr}`, `{sprache}` …
- **Sprache:** Deutsche und englische Karten werden erkannt (aus Set-Code `-DE`/`-EN` bzw. dem erkannten Namen), im Ergebnis korrigierbar.
- **Erstveröffentlichung:** erstes Erscheinen im TCG (Europa/USA), zusätzlich OCG (Japan).
- **Spielformate** (Tab „Regeln“): Zeitraum je Format, z. B. GOAT 01.01.2002–05.08.2005. Eine Karte gehört dazu, wenn ihre TCG-Erstveröffentlichung im Zeitraum liegt.
- **Sammlung:** Spalten frei wählbar, bis zu 3 Sortierstufen, Gruppieren, CSV-Export, JSON-Backup.
- **Lernt mit:** Nach jedem Scan „Richtig erkannt? 👍/👎“. Bestätigte Karten werden beim nächsten Mal sofort erkannt (ohne Zusatzprüfung, ohne zweite Bestätigung). Bei 👎 die richtige Karte wählen – sie wird gemerkt, die falsche abgestraft. Ohne Antwort zählt der Scan schwach als richtig (abschaltbar).
- **cardcluster-Link:** zu jeder Karte (Ergebnis, letzte Scans, Sammlungsspalte) – `https://cardcluster.de/card/<englischer-name>`.
- **Format-Suche:** Treffer leuchten grün mit positivem Ton, Nicht-Treffer rot mit „Nein“-Ton. Formate: GOAT (01.01.2002–05.08.2005), Edison (01.01.2002–21.04.2010), weitere im Tab „Regeln“.
- **Design:** Blau-Weiß Pastell, Hell/Dunkel per ☀️/🌙 oben rechts (oder automatisch wie das Gerät).
- **Abgesicherte Erkennung:** Gescannt wird nur, wenn eine Karte im Rahmen liegt (gleichfarbiger Kartenrahmen links/rechts + helle Textbox). Zusätzlich werden Rahmenfarbe (Normal/Effekt/Fusion/Zauber/Falle …), ATK/DEF und Stufen-Sterne mit dem Kandidaten verglichen. Ein Weißabgleich über die Textbox gleicht Raumlicht aus. Alles in den Einstellungen abschaltbar.
- **✎ Bereiche:** Rahmengröße und Lesebereiche (Name, Sterne, Set-Code, Pendel-Code, ATK/DEF) per Finger verschieben/vergrößern – am besten mit „Standbild“ einer echten Karte.
- **Erkennung klappt nicht?** Einstellungen → „OCR-Ausschnitte anzeigen“ zeigt Rahmenfarbe, gelesene Texte, ATK/DEF, Sterne und die Bewertung der Kandidaten.
