# Roadster-Karosserieprojektverwaltung

Eine deutschsprachige, statische Browser-App zur Verwaltung eines Smart-Roadster-Karosserieprojekts mit gestalterischer Orientierung am Ferrari Dino 246 GTS. Die Oberfläche unterstützt Teileverwaltung, Baugruppen, Druckplanung, Druckjournal, Dateiversionen, Änderungsprotokoll und manuelle JSON-Sicherungen. Sie enthält keine technischen Teilefreigaben, CAD-Aussagen oder Druckersteuerung.

## Lokal starten

1. Lade das Repository herunter oder klone es.
2. Öffne `index.html` in einem aktuellen Browser. Für zuverlässige IndexedDB-Unterstützung empfiehlt sich ein lokaler Webserver oder GitHub Pages:

   ```powershell
   python -m http.server 8000
   ```

3. Rufe `http://localhost:8000` auf.

Die App verwendet ausschließlich HTML, CSS und JavaScript ohne Build-Schritt oder Paketinstallation. Projektdaten und Dateiinhalte werden in der IndexedDB dieses Browserprofils gespeichert. Browser mit deaktiviertem Speicher oder ohne IndexedDB können die App nicht verwenden.

## Bereiche

- **Überblick:** Projektkennzahlen, nächste dokumentarische Queue-Aktion und jüngste Änderungen.
- **Karosseriebereiche:** In Front, Haube, Seitenschweller, Interieur, Heck und eigene Bereiche wechseln; „Noch zugeordnet“ hält ungeklärte Dateien und Teile zurück. Der gewählte Arbeitsbereich bleibt gespeichert. Ordner zeigen bestätigte manuelle Zuordnungen und den passenden nächsten Queue-Schritt.
- **Teile:** Teile anlegen und bearbeiten, Bestand erfassen, einen Karosseriebereich manuell zuordnen, nach Text/Status/Bereich suchen und filtern sowie Tabellen- oder Kartenansicht wählen.
- **Druckqueue:** hochgeladene Dateien werden einzeln unter ihrem tatsächlichen Dateinamen als Druckkandidaten vorgemerkt. Die nächste Empfehlung folgt der Upload-Reihenfolge sowie ausdrücklich erfassten Abhängigkeiten. Die geplante Stückzahl bleibt offen, bis du sie einträgst.
- **Bambu Studio:** Lade den nächsten Queue-Dateieintrag oder eine konkrete Version im Dateiarchiv herunter. Öffne den Download anschließend per Doppelklick oder in Bambu Studio über **Datei → Öffnen**. Der Browser kann das Desktop-Programm nicht direkt starten; Slicen und Drucken erfolgen in Bambu Studio. Kehre danach zur Queue zurück, um Start und Ergebnis manuell zu protokollieren.
- **Druckjournal:** produzierte und qualitätsbestätigte Gutmenge protokollieren. Nur bei expliziter Qualitätsbestätigung, optionaler Zuordnung zu einem Projektteil und bereits erfasstem Ausgangsbestand wird die Gutmenge automatisch addiert.
- **Baugruppen:** eigene Teilezuordnungen und Montagehinweise sichtbar gruppieren.
- **Dateien & Versionen:** mehrere Dateien gesammelt unter ihren tatsächlichen Dateinamen erfassen, Folgestände desselben Namens versionieren und ältere Versionen herunterladen. Dateien bleiben zunächst „Noch zugeordnet“, sofern kein früher bestätigter Bereich übernommen wird. Weise Bereich und Projektteil manuell zu, wenn Funktion und Einbauort bekannt sind. Nach einem abgeschlossenen Lauf wird der konkrete Dateistand als „Druck fertig“ gespeichert; der Qualitätsstatus bleibt separat sichtbar.
- **Änderungsprotokoll:** lokale, nicht personenbezogen verifizierte Ereignishistorie.
- **JSON-Sicherung:** vollständige Projektdaten exportieren oder eine geprüfte Sicherung wiederherstellen.

## Beispieldaten und fachliche Grenzen

Beim ersten Start werden Beispielteile, eine Beispielbaugruppe und ein Beispieldrucklauf angelegt. Sie sind in Oberfläche und Datensatz als **BEISPIEL** markiert und enthalten keine realen Teilebezeichnungen, Geometrien, Maße, Werkstoffe, Druckparameter oder Montagefreigaben. Bearbeite oder entferne sie nicht als Tatsachenquelle; lege echte Projektdaten selbst an.

Die App leitet keine technischen Werte, Bauteilfunktionen, Einbauorte oder Bauteilbeziehungen aus Dateinamen oder Dateiinhalt ab und prüft keine Konstruktion, Druckbarkeit, Materialeignung, Bauteilpassung, Sicherheit oder Qualität. Bereiche wie Front und Heck sind Ordner zur manuellen Organisation, keine automatisch erkannten Fahrzeugkomponenten. Der Upload-Dateiname identifiziert die Datei; Stückzahl und technische Abhängigkeiten bleiben offen, bis sie manuell eingetragen werden. Die Vorschlagsreihenfolge ist keine technische Fertigungsreihenfolge. Angaben in Notiz- und Materialfeldern stammen ausschließlich von der nutzenden Person. Der Download übergibt die Datei nicht automatisch an Bambu Studio und prüft das Dateiformat nicht; Öffnen und Drucken erfolgen außerhalb der App. „Start dokumentieren“ steuert keinen Drucker; Qualitätsbestätigung ist eine protokollierte Eingabe und keine unabhängige Messung oder Freigabe. Unbekannte Bestände bleiben unbekannt. Eine Gutmenge wird nicht zum Bestand addiert, wenn der Ausgangsbestand nicht erfasst ist.

## Daten speichern und sichern

- IndexedDB hält strukturierte Projektdaten und Datei-`Blob`s im aktuellen Browserprofil. Es gibt keine Anmeldung, Cloud-Synchronisierung, Mehrbenutzerfunktion oder serverseitige Sicherung.
- Browserdaten können gelöscht werden; Speicherquoten und Speicherbereinigung sind browserabhängig. Verwende die JSON-Sicherung regelmäßig und bewahre sie getrennt vom Browserprofil auf.
- Der JSON-Export enthält alle Tabellen und Dateiinhalte Base64-kodiert. Dadurch kann die Sicherungsdatei deutlich größer als die Originaldateien werden.
- Der Import **ersetzt den gesamten lokalen Datenbestand**. Exportiere bestehende Daten vorher. Die App prüft das Format, eindeutige Datensatz-IDs und grundlegende Dateiinformationen, bevor sie die Wiederherstellung transaktional schreibt.
- Es gibt keine Verschlüsselung der Exportdatei. Bewahre Projektdaten und Sicherungen entsprechend ihrem Inhalt geschützt auf.

## Dateien

- `index.html` – deutsche Navigation und Anwendungsbereiche
- `style.css` – responsive Gestaltung und barrierebewusste Bedienelemente
- `script.js` – IndexedDB, Projektabläufe, Druckjournal und Sicherung/Wiederherstellung

## Auf GitHub Pages veröffentlichen

1. Öffne das Repository auf GitHub und gehe zu **Settings → Pages**.
2. Wähle **Deploy from a branch**, den Branch `pinskemark08-roadster-project-app` und `/(root)`.
3. Speichere die Einstellung und öffne die angezeigte Pages-Adresse.

Auf Pages bleiben die Daten im jeweiligen Browserprofil der Person, die die Seite nutzt. Eine Veröffentlichung stellt keine gemeinsame Projektdatenbank bereit.
