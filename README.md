# Roadster-Karosserieprojektverwaltung

Eine deutschsprachige, statische Browser-App zur Verwaltung eines Smart-Roadster-Karosserieprojekts mit gestalterischer Orientierung am Ferrari Dino 246 GTS. Die Oberfläche unterstützt Teileverwaltung, Baugruppen, Druckplanung, Druckjournal, Dateiversionen, Änderungsprotokoll und manuelle JSON-Sicherungen. Sie enthält keine technischen Teilefreigaben, CAD-Aussagen oder Druckersteuerung.

## Lokal starten

1. Lade das Repository herunter oder klone es.
2. Öffne `index.html` in einem aktuellen Browser. Für zuverlässige IndexedDB-Unterstützung empfiehlt sich ein lokaler Webserver oder GitHub Pages:

   ```powershell
   python -m http.server 8000
   ```

3. Rufe `http://localhost:8000` auf.

Die App verwendet HTML, CSS und JavaScript ohne Build-Schritt oder Paketinstallation. Eine lokale IndexedDB hält den sofort gespeicherten Arbeitsstand. Für geräteübergreifende Synchronisierung kann ein privates Supabase-Projekt verbunden werden; der Supabase-JavaScript-Client wird dafür über ein CDN geladen.

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

## Geräteübergreifende Cloud-Synchronisierung

Die lokale Speicherung funktioniert ohne Cloud-Konto. Für denselben Projektstand auf mehreren Geräten:

1. Erstelle ein Supabase-Projekt.
2. Öffne in Supabase den **SQL Editor**, kopiere den Inhalt von `supabase-setup.sql` hinein und führe ihn aus. Er legt eine nutzergebundene Datentabelle, einen privaten Dateispeicher, Zugriffsschutz (RLS) und Live-Updates an.
3. Öffne in der App **JSON-Sicherung → Private Cloud-Synchronisierung** und lege ein Konto an. Bestätige gegebenenfalls deine E-Mail-Adresse.
4. Melde dich auf jedem weiteren Gerät mit demselben Konto an. Die veröffentlichte App ist zentral mit der Projekt-URL und dem öffentlichen anon/publishable key vorkonfiguriert; diese müssen nicht pro Gerät eingegeben werden.

Änderungen werden lokal sofort gesichert und im verbundenen Konto automatisch in die Cloud übertragen. Dateien liegen in einem privaten Supabase-Storage-Bucket; Bereiche, Queue-Status, letzter App-Bereich, Teile und Journal werden in der geschützten Projekttabelle gespeichert. Realtime-Updates übertragen Änderungen anderer Geräte; ein regelmäßiger Abruf dient als Rückfall. Bei konkurrierenden Offline-Änderungen fragt die App, ob der Cloud-Stand oder dieses Gerät Vorrang hat. Offline bleibt der lokale Stand erhalten und wird bei Wiederverbindung synchronisiert. Der öffentliche anon/publishable key ist für Browser-Apps vorgesehen und liegt im App-Code; verwende niemals einen `service_role`- oder `sb_secret_`-Schlüssel. Cloud-Speicher- und Dateigrößenlimits hängen vom Supabase-Tarif ab.

Die Website ist öffentlich erreichbar, Projektdaten sind aber durch Anmeldung und Row-Level-Security auf das jeweilige Supabase-Konto beschränkt. Zugangstoken bleiben im Browserprofil. Verwende ein eigenes Konto und teile es nicht mit anderen Personen.

## Beispieldaten und fachliche Grenzen

Beim ersten Start werden Beispielteile, eine Beispielbaugruppe und ein Beispieldrucklauf angelegt. Sie sind in Oberfläche und Datensatz als **BEISPIEL** markiert und enthalten keine realen Teilebezeichnungen, Geometrien, Maße, Werkstoffe, Druckparameter oder Montagefreigaben. Bearbeite oder entferne sie nicht als Tatsachenquelle; lege echte Projektdaten selbst an.

Die App leitet keine technischen Werte, Bauteilfunktionen, Einbauorte oder Bauteilbeziehungen aus Dateinamen oder Dateiinhalt ab und prüft keine Konstruktion, Druckbarkeit, Materialeignung, Bauteilpassung, Sicherheit oder Qualität. Bereiche wie Front und Heck sind Ordner zur manuellen Organisation, keine automatisch erkannten Fahrzeugkomponenten. Der Upload-Dateiname identifiziert die Datei; Stückzahl und technische Abhängigkeiten bleiben offen, bis sie manuell eingetragen werden. Die Vorschlagsreihenfolge ist keine technische Fertigungsreihenfolge. Angaben in Notiz- und Materialfeldern stammen ausschließlich von der nutzenden Person. Der Download übergibt die Datei nicht automatisch an Bambu Studio und prüft das Dateiformat nicht; Öffnen und Drucken erfolgen außerhalb der App. „Start dokumentieren“ steuert keinen Drucker; Qualitätsbestätigung ist eine protokollierte Eingabe und keine unabhängige Messung oder Freigabe. Unbekannte Bestände bleiben unbekannt. Eine Gutmenge wird nicht zum Bestand addiert, wenn der Ausgangsbestand nicht erfasst ist.

## Daten speichern und sichern

- Ohne Cloud-Anmeldung hält IndexedDB strukturierte Projektdaten und Datei-`Blob`s nur im aktuellen Browserprofil. Browserdaten können gelöscht werden und Speicherquoten sind browserabhängig.
- Mit Cloud-Anmeldung werden Änderungen zusätzlich in das persönliche Supabase-Konto synchronisiert. Offline vorgenommene Änderungen bleiben lokal und werden nach Wiederverbindung übertragen.
- Der JSON-Export enthält alle Tabellen und Dateiinhalte Base64-kodiert. Dadurch kann die Sicherungsdatei deutlich größer als die Originaldateien werden.
- Der Import **ersetzt den gesamten lokalen Datenbestand**. Exportiere bestehende Daten vorher. Die App prüft das Format, eindeutige Datensatz-IDs und grundlegende Dateiinformationen, bevor sie die Wiederherstellung transaktional schreibt.
- Die exportierte JSON-Datei ist nicht verschlüsselt. Bewahre sie entsprechend ihrem Inhalt geschützt auf; für unabhängige Sicherungen zusätzlich regelmäßig einen JSON-Export erstellen.

## Dateien

- `index.html` – deutsche Navigation und Anwendungsbereiche
- `style.css` – responsive Gestaltung und barrierebewusste Bedienelemente
- `script.js` – IndexedDB, Projektabläufe, Druckjournal, Cloud-Synchronisierung und Sicherung/Wiederherstellung
- `supabase-setup.sql` – Supabase-Tabellen, private Dateispeicherung und Zugriffsschutz

## Auf GitHub Pages veröffentlichen

1. Öffne das Repository auf GitHub und gehe zu **Settings → Pages**.
2. Wähle **Deploy from a branch**, den Branch `main` und `/(root)`.
3. Speichere die Einstellung und öffne die angezeigte Pages-Adresse.

Ohne Supabase-Anmeldung bleiben Daten im jeweiligen Browserprofil. Mit konfiguriertem Supabase-Konto werden Projektdaten über die geschützte Cloud synchronisiert.
