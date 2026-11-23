"use strict";

const DB_NAME = "roadster-karosserieprojekt";
const DB_VERSION = 1;
const STORE_NAMES = ["project", "parts", "prints", "assemblies", "files", "journal", "changes"];
const CLOUD_META_KEY = "roadster-cloud-sync-meta";
const LAST_VIEW_KEY = "roadster-last-view";
const LOCAL_CHANGE_KEY = "roadster-local-change-id";
const CLOUD_TABLE = "roadster_project_state";
const CLOUD_BUCKET = "roadster-files";
const CLOUD_POLL_INTERVAL = 15000;
const SUPABASE_CONFIG = Object.freeze({
  url: "https://gzgtgcgakqujmukpznzg.supabase.co",
  key: "sb_publishable_24AxpWWrE0kRFfrhe2YQOA_X5rIGvYr"
});
const UNASSIGNED_AREA_ID = "__unassigned__";
const DEFAULT_AREAS = [
  { id: "front", name: "Front", order: 1 },
  { id: "hood", name: "Haube", order: 2 },
  { id: "side-skirts", name: "Seitenschweller", order: 3 },
  { id: "interior", name: "Interieur", order: 4 },
  { id: "rear", name: "Heck", order: 5 }
];
const STATUS_LABELS = {
  concept: "Entwurf",
  planned: "Geplant",
  "in-progress": "In Bearbeitung",
  review: "Zur Prüfung",
  complete: "Abgeschlossen"
};
const VIEW_TITLES = {
  ueberblick: "Projektüberblick",
  bereiche: "Karosseriebereiche",
  teile: "Teileverwaltung",
  druckqueue: "Druckqueue",
  journal: "Druckjournal",
  baugruppen: "Baugruppen & Montage",
  dateien: "Dateien & Versionen",
  aenderungen: "Änderungsprotokoll",
  sicherung: "JSON-Sicherung"
};

let db;
let projectData;
let cached = { parts: [], prints: [], assemblies: [], files: [], journal: [], changes: [] };
let cloudClient = null;
let cloudUser = null;
let cloudChannel = null;
let cloudRemoteUpdatedAt = null;
let cloudRemoteFileIds = new Set();
let cloudSyncTimer = null;
let cloudPollTimer = null;
let cloudSyncRunning = false;
let cloudSyncAgain = false;
let cloudApplyingRemote = false;
let cloudConflictOpen = false;
let currentView = "ueberblick";
const $ = (id) => document.getElementById(id);

function makeId(prefix) {
  const token = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${token}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(value, includeTime) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unbekannt";
  return new Intl.DateTimeFormat("de-DE", includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Größe unbekannt";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusPill(status) {
  const label = STATUS_LABELS[status] || "Unbekannt";
  return `<span class="status-pill status-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function printStatusLabel(status) {
  return ({ planned: "Geplant", printing: "Lauf dokumentiert gestartet", complete: "Journalisiert" })[status] || "Unbekannt";
}

function showAlert(message, success) {
  const alert = $("app-alert");
  alert.textContent = message;
  alert.classList.toggle("success", Boolean(success));
  alert.hidden = false;
  window.clearTimeout(showAlert.timer);
  showAlert.timer = window.setTimeout(() => { alert.hidden = true; }, 8000);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Dieser Browser unterstützt IndexedDB nicht. Die App kann Daten nicht dauerhaft speichern."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of STORE_NAMES) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => {
      db = request.result;
      db.onversionchange = () => {
        db.close();
        showAlert("Die Datenbank wurde in einem anderen Tab aktualisiert. Lade diese Seite neu, um weiterzuarbeiten.");
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Die lokale Projektdatenbank konnte nicht geöffnet werden."));
    request.onblocked = () => reject(new Error("Ein anderer App-Tab blockiert die Datenbankaktualisierung. Schließe ihn und lade die Seite neu."));
  });
}

function transaction(storeNames, mode, action) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    try {
      result = action(tx);
    } catch (error) {
      try { tx.abort(); } catch (_) { /* Transaction may already be inactive. */ }
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      resolve(result);
      if (mode === "readwrite" && !cloudApplyingRemote) markCloudDirty();
    };
    tx.onerror = () => reject(tx.error || new Error("Die lokale Datenänderung ist fehlgeschlagen."));
    tx.onabort = () => reject(tx.error || new Error("Die lokale Datenänderung wurde abgebrochen."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Lokale Daten konnten nicht gelesen werden."));
  });
}

async function getAll(storeName) {
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).getAll());
}

async function loadData() {
  const snapshot = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAMES, "readonly");
    const records = {};
    for (const name of STORE_NAMES) {
      records[name] = null;
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => { records[name] = request.result; };
      request.onerror = () => reject(request.error || new Error(`Lokale Daten in „${name}“ konnten nicht gelesen werden.`));
    }
    tx.oncomplete = () => resolve(records);
    tx.onerror = () => reject(tx.error || new Error("Der lokale Datenstand konnte nicht konsistent gelesen werden."));
    tx.onabort = () => reject(tx.error || new Error("Das Lesen des lokalen Datenstands wurde abgebrochen."));
  });
  projectData = snapshot.project[0];
  cached = {
    parts: snapshot.parts, prints: snapshot.prints, assemblies: snapshot.assemblies,
    files: snapshot.files, journal: snapshot.journal, changes: snapshot.changes
  };
}

function getCloudMeta() {
  const raw = localStorage.getItem(CLOUD_META_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveCloudMeta(values) {
  localStorage.setItem(CLOUD_META_KEY, JSON.stringify({ ...getCloudMeta(), ...values }));
}

function updateCloudStatus(message, state) {
  $("cloud-status").textContent = message;
  $("cloud-status").dataset.state = state || "local";
  $("cloud-status-dot").dataset.state = state || "local";
  $("cloud-status-short").textContent = state === "synced" ? "Cloud gespeichert"
    : state === "saving" ? "Synchronisierung läuft"
      : state === "error" ? "Cloud-Sync Fehler"
        : cloudUser ? "Cloud angemeldet" : "Nur lokal";
}

function renderCloudControls() {
  $("cloud-auth-form").hidden = !cloudClient;
  $("cloud-login-button").hidden = Boolean(cloudUser);
  $("cloud-signup-button").hidden = Boolean(cloudUser);
  $("cloud-sync-button").hidden = !cloudUser;
  $("cloud-logout-button").hidden = !cloudUser;
  $("cloud-account-label").textContent = cloudUser ? `Angemeldet als ${cloudUser.email}` : "";
  $("cloud-email").value = cloudUser?.email || "";
  $("cloud-password").value = "";
}

function markCloudDirty() {
  if (cloudApplyingRemote) return;
  try {
    const changeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(LOCAL_CHANGE_KEY, changeId);
    if (cloudUser) {
      saveCloudMeta({ userId: cloudUser.id, dirty: true });
      updateCloudStatus("Lokal gespeichert; Cloud-Synchronisierung wird ausgeführt.", "saving");
      scheduleCloudSync();
    }
  } catch (error) {
    updateCloudStatus(`Lokal gespeichert, Cloud-Status konnte nicht gesichert werden: ${error.message}`, "error");
  }
}

function scheduleCloudSync() {
  if (!cloudUser || !cloudClient) return;
  window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(() => {
    syncLocalToCloud().catch((error) => {
      updateCloudStatus(`Lokal gespeichert, Cloud-Sync fehlgeschlagen: ${error.message}`, "error");
      showAlert(`Die lokale Änderung ist gespeichert, aber die Cloud-Synchronisierung ist fehlgeschlagen: ${error.message}`);
    });
  }, 500);
}

async function readDatabaseSnapshot() {
  const entries = await Promise.all(STORE_NAMES.map(async (name) => [name, await getAll(name)]));
  return Object.fromEntries(entries);
}

function hasRealProjectData(snapshot) {
  return snapshot.parts.some((item) => !item.isExample)
    || snapshot.prints.some((item) => !item.isExample)
    || snapshot.assemblies.some((item) => !item.isExample)
    || snapshot.files.some((item) => !item.isExample)
    || snapshot.journal.length > 0;
}

function makeCloudPayload(snapshot) {
  const project = snapshot.project[0];
  if (!project) throw new Error("Projektstammdaten fehlen; Cloud-Sync wurde abgebrochen.");
  return {
    version: 1,
    project,
    parts: snapshot.parts,
    prints: snapshot.prints,
    assemblies: snapshot.assemblies,
    files: snapshot.files.map((file) => {
      const { blob, ...metadata } = file;
      return { ...metadata, storagePath: `${cloudUser.id}/${file.id}` };
    }),
    journal: snapshot.journal,
    changes: snapshot.changes,
    lastView: VIEW_TITLES[currentView] ? currentView : "ueberblick"
  };
}

function validateCloudPayload(payload) {
  const requiredArrays = ["parts", "prints", "assemblies", "files", "journal", "changes"];
  if (!payload || payload.version !== 1 || !payload.project || payload.project.id !== "main"
      || requiredArrays.some((name) => !Array.isArray(payload[name]))) {
    throw new Error("Der Cloud-Datensatz hat ein unbekanntes oder unvollständiges Format.");
  }
  if (payload.lastView && !VIEW_TITLES[payload.lastView]) {
    throw new Error("Der gespeicherte App-Bereich in der Cloud ist ungültig.");
  }
  for (const file of payload.files) {
    if (!file || typeof file.id !== "string" || typeof file.name !== "string"
        || !Number.isInteger(file.size) || file.size < 0
        || file.storagePath !== `${cloudUser.id}/${file.id}`) {
      throw new Error("Eine Datei in der Cloud-Sicherung hat ungültige Metadaten.");
    }
  }
}

async function fetchCloudRow() {
  const { data, error } = await cloudClient.from(CLOUD_TABLE)
    .select("payload,updated_at")
    .eq("user_id", cloudUser.id)
    .maybeSingle();
  if (error) throw new Error(`Cloud-Daten konnten nicht gelesen werden: ${error.message}`);
  return data;
}

async function restoreCloudRow(row) {
  validateCloudPayload(row.payload);
  const files = [];
  for (const file of row.payload.files) {
    const { data, error } = await cloudClient.storage.from(CLOUD_BUCKET).download(file.storagePath);
    if (error) throw new Error(`Cloud-Datei ${file.name} konnte nicht geladen werden: ${error.message}`);
    if (!(data instanceof Blob) || data.size !== file.size) {
      throw new Error(`Die Größe der Cloud-Datei ${file.name} stimmt nicht mit den Metadaten überein.`);
    }
    const { storagePath, ...metadata } = file;
    files.push({ ...metadata, blob: data });
  }
  const records = {
    project: [row.payload.project],
    parts: row.payload.parts,
    prints: row.payload.prints,
    assemblies: row.payload.assemblies,
    files,
    journal: row.payload.journal,
    changes: row.payload.changes
  };
  cloudApplyingRemote = true;
  try {
    await transaction(STORE_NAMES, "readwrite", (tx) => {
      STORE_NAMES.forEach((name) => tx.objectStore(name).clear());
      STORE_NAMES.forEach((name) => records[name].forEach((record) => tx.objectStore(name).put(record)));
    });
  } finally {
    cloudApplyingRemote = false;
  }
  cloudRemoteUpdatedAt = row.updated_at;
  cloudRemoteFileIds = new Set(row.payload.files.map((file) => file.id));
  saveCloudMeta({
    userId: cloudUser.id,
    remoteUpdatedAt: row.updated_at,
    dirty: false,
    lastLocalChangeId: localStorage.getItem(LOCAL_CHANGE_KEY)
  });
  localStorage.setItem(LAST_VIEW_KEY, row.payload.lastView || "ueberblick");
  await refresh();
  navigate(row.payload.lastView || "ueberblick", false);
  updateCloudStatus(`Cloud-Stand übernommen · ${formatDate(row.updated_at, true)}`, "synced");
}

async function connectCloudAccount(user) {
  cloudUser = user;
  renderCloudControls();
  updateCloudStatus("Cloud-Konto wird abgeglichen …", "saving");
  stopCloudUpdates();
  const snapshot = await readDatabaseSnapshot();
  let meta = getCloudMeta();
  const localChangeId = localStorage.getItem(LOCAL_CHANGE_KEY);
  if (meta.userId === user.id && (meta.dirty || meta.lastLocalChangeId !== localChangeId)) {
    meta = { ...meta, dirty: true };
    saveCloudMeta({ userId: user.id, dirty: true });
  }
  const row = await fetchCloudRow();
  if (!row) {
    cloudRemoteUpdatedAt = null;
    cloudRemoteFileIds = new Set();
    saveCloudMeta({
      userId: user.id,
      remoteUpdatedAt: null,
      dirty: true,
      lastLocalChangeId: localChangeId
    });
    await syncLocalToCloud();
  } else if (meta.userId !== user.id && hasRealProjectData(snapshot)) {
    const confirmed = window.confirm("Für dieses Konto gibt es bereits einen Cloud-Stand. Soll dieser Stand die vorhandenen lokalen Projektdaten ersetzen? Exportiere lokale Daten vorher über JSON-Sicherung.");
    if (!confirmed) {
      await cloudClient.auth.signOut();
      cloudUser = null;
      renderCloudControls();
      updateCloudStatus("Cloud-Anmeldung abgebrochen; lokale Daten bleiben erhalten.", "local");
      return;
    }
    await restoreCloudRow(row);
  } else if (meta.userId === user.id && meta.dirty && meta.remoteUpdatedAt
      && meta.remoteUpdatedAt !== row.updated_at) {
    const useCloud = window.confirm("Ein anderes Gerät hat neuere Cloud-Daten gespeichert. OK übernimmt den Cloud-Stand und ersetzt ungesicherte lokale Änderungen; Abbrechen behält dieses Gerät und schreibt dessen Stand in die Cloud.");
    if (useCloud) await restoreCloudRow(row);
    else {
      cloudRemoteUpdatedAt = row.updated_at;
      cloudRemoteFileIds = new Set(row.payload.files.map((file) => file.id));
      saveCloudMeta({ userId: user.id, remoteUpdatedAt: row.updated_at, dirty: true });
      await syncLocalToCloud();
    }
  } else if (meta.userId !== user.id || meta.remoteUpdatedAt !== row.updated_at) {
    await restoreCloudRow(row);
  } else {
    cloudRemoteUpdatedAt = row.updated_at;
    cloudRemoteFileIds = new Set(row.payload.files.map((file) => file.id));
    updateCloudStatus(`Cloud synchronisiert · ${formatDate(row.updated_at, true)}`, "synced");
    if (meta.dirty) await syncLocalToCloud();
  }
  startCloudUpdates();
}

function stopCloudUpdates() {
  window.clearInterval(cloudPollTimer);
  cloudPollTimer = null;
  if (cloudChannel && cloudClient) {
    cloudClient.removeChannel(cloudChannel).catch((error) => console.error("Cloud-Updates konnten nicht getrennt werden:", error));
  }
  cloudChannel = null;
}

function startCloudUpdates() {
  stopCloudUpdates();
  cloudPollTimer = window.setInterval(() => {
    checkCloudForUpdates().catch((error) => updateCloudStatus(`Cloud-Abgleich fehlgeschlagen: ${error.message}`, "error"));
  }, CLOUD_POLL_INTERVAL);
  cloudChannel = cloudClient.channel(`roadster-sync-${cloudUser.id}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: CLOUD_TABLE,
      filter: `user_id=eq.${cloudUser.id}`
    }, () => {
      checkCloudForUpdates().catch((error) => updateCloudStatus(`Cloud-Abgleich fehlgeschlagen: ${error.message}`, "error"));
    })
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        updateCloudStatus("Live-Updates nicht verfügbar; regelmäßiger Cloud-Abgleich bleibt aktiv.", "saving");
      }
    });
}

async function syncLocalToCloud() {
  if (!cloudUser || !cloudClient) return;
  if (cloudSyncRunning) {
    cloudSyncAgain = true;
    return;
  }
  cloudSyncRunning = true;
  try {
    do {
      cloudSyncAgain = false;
      await syncLocalSnapshotOnce();
    } while (cloudSyncAgain && cloudUser);
  } finally {
    cloudSyncRunning = false;
  }
}

async function syncLocalSnapshotOnce() {
  if (!navigator.onLine) {
    updateCloudStatus("Offline: Änderungen bleiben lokal und werden bei Verbindung übertragen.", "saving");
    return;
  }
  let row = await fetchCloudRow();
  const meta = getCloudMeta();
  if (row && row.updated_at !== meta.remoteUpdatedAt) {
    if (!meta.dirty) {
      await restoreCloudRow(row);
      return;
    }
    if (cloudConflictOpen) return;
    cloudConflictOpen = true;
    const useCloud = window.confirm("Ein anderes Gerät hat neuere Cloud-Daten gespeichert. OK übernimmt den Cloud-Stand und ersetzt ungesicherte lokale Änderungen; Abbrechen behält dieses Gerät und schreibt dessen Stand in die Cloud.");
    cloudConflictOpen = false;
    if (useCloud) {
      await restoreCloudRow(row);
      return;
    }
    cloudRemoteUpdatedAt = row.updated_at;
    cloudRemoteFileIds = new Set(row.payload.files.map((file) => file.id));
    saveCloudMeta({ userId: cloudUser.id, remoteUpdatedAt: row.updated_at, dirty: true });
  }

  const snapshot = await readDatabaseSnapshot();
  const payload = makeCloudPayload(snapshot);
  const existingFileIds = new Set((row?.payload?.files || []).map((file) => file.id));
  const uploadedPaths = [];
  try {
    for (const file of snapshot.files) {
      if (existingFileIds.has(file.id)) continue;
      if (!(file.blob instanceof Blob)) throw new Error(`Dateiinhalt fehlt bei ${file.name}; Cloud-Sync abgebrochen.`);
      const path = `${cloudUser.id}/${file.id}`;
      const { error } = await cloudClient.storage.from(CLOUD_BUCKET)
        .upload(path, file.blob, { upsert: true, contentType: file.mimeType || "application/octet-stream" });
      if (error) throw new Error(`Datei ${file.name} konnte nicht in die Cloud geladen werden: ${error.message}`);
      uploadedPaths.push(path);
    }
    const values = { user_id: cloudUser.id, payload, updated_at: new Date().toISOString() };
    let saved;
    if (row) {
      const { data, error } = await cloudClient.from(CLOUD_TABLE).update(values)
        .eq("user_id", cloudUser.id).eq("updated_at", row.updated_at)
        .select("updated_at").maybeSingle();
      if (error) throw new Error(`Cloud-Stand konnte nicht gespeichert werden: ${error.message}`);
      saved = data;
      if (!saved) {
        row = await fetchCloudRow();
        if (!row) throw new Error("Der Cloud-Datensatz wurde während der Synchronisierung entfernt.");
        const useCloud = window.confirm("Ein anderes Gerät hat gleichzeitig gespeichert. OK übernimmt dessen Cloud-Stand; Abbrechen überschreibt ihn mit diesem Gerät.");
        if (useCloud) {
          await restoreCloudRow(row);
          return;
        }
        const retry = await cloudClient.from(CLOUD_TABLE).update(values)
          .eq("user_id", cloudUser.id).eq("updated_at", row.updated_at)
          .select("updated_at").maybeSingle();
        if (retry.error) throw new Error(`Cloud-Stand konnte nach dem Konflikt nicht gespeichert werden: ${retry.error.message}`);
        saved = retry.data;
        if (!saved) throw new Error("Es gab erneut eine gleichzeitige Cloud-Änderung. Bitte synchronisiere noch einmal.");
      }
    } else {
      const { data, error } = await cloudClient.from(CLOUD_TABLE).insert(values)
        .select("updated_at").single();
      if (error) throw new Error(`Erster Cloud-Stand konnte nicht angelegt werden: ${error.message}`);
      saved = data;
    }
    cloudRemoteUpdatedAt = saved.updated_at;
    cloudRemoteFileIds = new Set(payload.files.map((file) => file.id));
    saveCloudMeta({
      userId: cloudUser.id,
      remoteUpdatedAt: saved.updated_at,
      dirty: false,
      lastLocalChangeId: localStorage.getItem(LOCAL_CHANGE_KEY)
    });
    updateCloudStatus(`Cloud gespeichert · ${formatDate(saved.updated_at, true)}`, "synced");
  } catch (error) {
    if (uploadedPaths.length) {
      const { error: cleanupError } = await cloudClient.storage.from(CLOUD_BUCKET).remove(uploadedPaths);
      if (cleanupError) console.error("Temporary cloud files could not be cleaned up:", cleanupError);
    }
    throw error;
  }
}

async function checkCloudForUpdates() {
  if (!cloudUser || !cloudClient || cloudSyncRunning || !navigator.onLine) return;
  const row = await fetchCloudRow();
  if (!row) {
    if (cloudRemoteUpdatedAt) throw new Error("Der Cloud-Datensatz fehlt. Lokale Daten wurden nicht gelöscht.");
    return;
  }
  if (row.updated_at === cloudRemoteUpdatedAt) return;
  const meta = getCloudMeta();
  if (!meta.dirty) {
    await restoreCloudRow(row);
    return;
  }
  if (cloudConflictOpen) return;
  cloudConflictOpen = true;
  const useCloud = window.confirm("Ein anderes Gerät hat neuere Cloud-Daten gespeichert. OK übernimmt den Cloud-Stand und ersetzt ungesicherte lokale Änderungen; Abbrechen behält dieses Gerät und schreibt dessen Stand in die Cloud.");
  cloudConflictOpen = false;
  if (useCloud) await restoreCloudRow(row);
  else {
    cloudRemoteUpdatedAt = row.updated_at;
    cloudRemoteFileIds = new Set(row.payload.files.map((file) => file.id));
    saveCloudMeta({ userId: cloudUser.id, remoteUpdatedAt: row.updated_at, dirty: true });
    await syncLocalToCloud();
  }
}

async function initializeCloud() {
  renderCloudControls();
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    updateCloudStatus("Supabase-Client konnte nicht geladen werden. Prüfe Internetverbindung oder CDN-Zugriff.", "error");
    return;
  }
  cloudClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  renderCloudControls();
  const { data, error } = await cloudClient.auth.getSession();
  if (error) throw new Error(`Supabase-Sitzung konnte nicht gelesen werden: ${error.message}`);
  if (data.session?.user) await connectCloudAccount(data.session.user);
  else updateCloudStatus("Cloud-Verbindung bereit. Melde dich an oder lege ein Konto an.", "local");
}

async function signInToCloud(event) {
  event.preventDefault();
  if (!cloudClient) throw new Error("Die Cloud-Verbindung konnte nicht initialisiert werden. Bitte lade die Seite erneut.");
  const { data, error } = await cloudClient.auth.signInWithPassword({
    email: $("cloud-email").value.trim(),
    password: $("cloud-password").value
  });
  if (error) throw new Error(`Anmeldung fehlgeschlagen: ${error.message}`);
  await connectCloudAccount(data.user);
  $("cloud-password").value = "";
}

async function createCloudAccount() {
  if (!cloudClient) throw new Error("Die Cloud-Verbindung konnte nicht initialisiert werden. Bitte lade die Seite erneut.");
  if (!$("cloud-auth-form").reportValidity()) return;
  const { data, error } = await cloudClient.auth.signUp({
    email: $("cloud-email").value.trim(),
    password: $("cloud-password").value
  });
  if (error) throw new Error(`Konto konnte nicht angelegt werden: ${error.message}`);
  $("cloud-password").value = "";
  if (data.session?.user) await connectCloudAccount(data.session.user);
  else showAlert("Konto angelegt. Bestätige zuerst die E-Mail-Adresse und melde dich danach an.", true);
}

async function signOutFromCloud() {
  if (cloudClient) {
    const { error } = await cloudClient.auth.signOut();
    if (error) throw new Error(`Abmeldung fehlgeschlagen: ${error.message}`);
  }
  cloudUser = null;
  cloudRemoteUpdatedAt = null;
  stopCloudUpdates();
  renderCloudControls();
  updateCloudStatus("Abgemeldet. Die lokale Kopie bleibt auf diesem Gerät erhalten.", "local");
}

async function synchronizeNow() {
  if (!cloudUser) throw new Error("Bitte zuerst anmelden.");
  await checkCloudForUpdates();
  if (getCloudMeta().dirty) await syncLocalToCloud();
  else updateCloudStatus("Cloud und dieses Gerät sind synchron.", "synced");
}

function seedRecords() {
  const now = new Date().toISOString();
  const partA = {
    id: "example-part-a", name: "Beispielteil A · Platzhalter", code: "", status: "concept",
    stock: null, material: "", notes: "Nur Beispieldatensatz. Keine reale Bauteilbezeichnung, Geometrie oder technische Angabe.",
    isExample: true, createdAt: now, updatedAt: now
  };
  const partB = {
    id: "example-part-b", name: "Beispielteil B · Platzhalter", code: "", status: "planned",
    stock: null, material: "", notes: "Nur Beispieldatensatz. Keine reale Bauteilbezeichnung, Geometrie oder technische Angabe.",
    isExample: true, createdAt: now, updatedAt: now
  };
  return {
    project: {
      id: "main", name: "Smart Roadster", description: "Karosserieprojekt · gestalterische Orientierung am Ferrari Dino 246 GTS",
      areas: DEFAULT_AREAS.map((area) => ({ ...area })),
      activeAreaId: "front",
      createdAt: now, updatedAt: now
    },
    parts: [partA, partB],
    prints: [{
      id: "example-print-a", partId: partA.id, quantity: 1, dependencies: [], notes: "Nur Demo; technische Angaben und Druckfreigabe fehlen.",
      status: "planned", queueOrder: 1, isExample: true, createdAt: now, startedAt: null, completedAt: null
    }],
    assemblies: [{
      id: "example-assembly", name: "Beispielbaugruppe · Platzhalter", partIds: [partA.id, partB.id],
      notes: "Nur Demo-Zuordnung; keine bestätigte Montagebeziehung.", isExample: true, createdAt: now
    }]
  };
}

async function initializeData() {
  const projectRecords = await getAll("project");
  if (projectRecords.length) return;
  const seed = seedRecords();
  const now = new Date().toISOString();
  await transaction(["project", "parts", "prints", "assemblies", "changes"], "readwrite", (tx) => {
    tx.objectStore("project").put(seed.project);
    seed.parts.forEach((item) => tx.objectStore("parts").put(item));
    seed.prints.forEach((item) => tx.objectStore("prints").put(item));
    seed.assemblies.forEach((item) => tx.objectStore("assemblies").put(item));
    tx.objectStore("changes").put({
      id: makeId("change"), title: "Beispieldaten angelegt",
      detail: "Deutlich gekennzeichnete Platzhalter; keine realen Teile oder technischen Werte.",
      at: now, isExample: true
    });
  });
}

async function ensureProjectAreas() {
  const project = (await getAll("project"))[0];
  if (!project) throw new Error("Projektstammdaten fehlen.");
  const areas = Array.isArray(project.areas) ? [...project.areas] : [];
  DEFAULT_AREAS.forEach((defaultArea) => {
    if (!areas.some((area) => area.id === defaultArea.id)) areas.push({ ...defaultArea });
  });
  const activeAreaId = Object.prototype.hasOwnProperty.call(project, "activeAreaId")
    && (project.activeAreaId === null || areas.some((area) => area.id === project.activeAreaId))
    ? project.activeAreaId
    : "front";
  if (!Array.isArray(project.areas) || areas.length !== project.areas.length || project.activeAreaId !== activeAreaId) {
    await transaction("project", "readwrite", (tx) => {
      tx.objectStore("project").put({ ...project, areas, activeAreaId });
    });
  }
}

function changeRecord(title, detail, isExample) {
  return { id: makeId("change"), title, detail, at: new Date().toISOString(), isExample: Boolean(isExample) };
}

async function refresh() {
  await loadData();
  if (!projectData) throw new Error("Projektstammdaten fehlen. Stelle eine gültige JSON-Sicherung wieder her.");
  $("project-name").textContent = projectData.name || "Roadster-Projekt";
  renderAreaControls();
  renderDashboard();
  renderAreaFolders();
  renderAreaWorkspace();
  renderParts();
  renderQueue();
  renderJournal();
  renderAssemblies();
  renderFiles();
  renderChanges();
}

function areaName(areaId) {
  if (!areaId) return "Noch zugeordnet";
  return projectData.areas.find((area) => area.id === areaId)?.name || "Unbekannter Bereich";
}

function parseAreaValue(value) {
  if (value === UNASSIGNED_AREA_ID) return null;
  return projectData.areas.some((area) => area.id === value) ? value : null;
}

function makeAreaOptions(selectedAreaId, includeAll) {
  const options = [];
  if (includeAll) options.push(`<option value=""${selectedAreaId === "all" ? " selected" : ""}>Alle Bereiche</option>`);
  options.push(`<option value="${UNASSIGNED_AREA_ID}"${selectedAreaId === null ? " selected" : ""}>Noch zugeordnet</option>`);
  [...projectData.areas].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "de")).forEach((area) => {
    options.push(`<option value="${escapeHtml(area.id)}"${area.id === selectedAreaId ? " selected" : ""}>${escapeHtml(area.name)}</option>`);
  });
  return options.join("");
}

function renderAreaControls() {
  const activeAreaId = projectData.activeAreaId ?? null;
  $("overview-area-select").innerHTML = makeAreaOptions(activeAreaId, false);
  $("area-start-select").innerHTML = makeAreaOptions(activeAreaId, false);
  const partArea = $("part-area");
  const partAreaValue = partArea.value === UNASSIGNED_AREA_ID ? null : partArea.value || null;
  partArea.innerHTML = makeAreaOptions(partAreaValue, false);
  const filter = $("part-area-filter");
  const filterValue = filter.value;
  const selectedFilter = !filterValue ? "all" : filterValue === UNASSIGNED_AREA_ID ? null : filterValue;
  filter.innerHTML = makeAreaOptions(selectedFilter, true);
}

function renderDashboard() {
  $("stat-parts").textContent = String(cached.parts.length);
  $("stat-queue").textContent = String(cached.prints.filter((item) => !item.isExample && item.status !== "complete").length);
  $("stat-assemblies").textContent = String(cached.assemblies.length);
  $("stat-files").textContent = String(cached.files.length);
  $("queue-nav-count").textContent = String(cached.prints.filter((item) => !item.isExample && item.status !== "complete").length);

  const nextPrint = recommendedPrint();
  const next = $("next-action-card");
  if (!nextPrint) {
    next.innerHTML = `<strong>Keine offenen Druckläufe in „${escapeHtml(areaName(projectData.activeAreaId))}“</strong><p>Wähle einen anderen Karosseriebereich oder ordne dort Dateien zu. Lege bei Bedarf einen Queue-Eintrag an.</p>`;
  } else {
    const item = nextPrint;
    const guidance = getQueueGuidance(item);
    const file = getFile(item.fileId);
    const subject = file?.name || getPart(item.partId)?.name;
    next.innerHTML = `<strong>${escapeHtml(guidance.title)}${subject ? ` · ${escapeHtml(subject)}` : ""}${item.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</strong><p>${escapeHtml(guidance.message)}</p>`;
  }
  const recent = [...cached.changes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  const recentContainer = $("recent-changes");
  if (!recent.length) {
    recentContainer.innerHTML = '<div class="empty-state"><strong>Noch keine Änderungen</strong><p>Neue Projekteinträge erscheinen hier.</p></div>';
    return;
  }
  recentContainer.innerHTML = recent.map((item) => `
    <div class="recent-row"><span class="timeline-dot" aria-hidden="true"></span>
      <div><strong>${escapeHtml(item.title)}${item.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</strong><small>${escapeHtml(item.detail || "")}</small></div>
      <time datetime="${escapeHtml(item.at)}">${escapeHtml(formatDate(item.at, false))}</time>
    </div>`).join("");
}

function renderAreaFolders() {
  const folders = [
    { id: UNASSIGNED_AREA_ID, name: "Noch zugeordnet", order: 0 },
    ...projectData.areas
  ].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "de"));
  $("area-folder-grid").innerHTML = folders.map((area) => {
    const areaId = area.id === UNASSIGNED_AREA_ID ? null : area.id;
    const files = cached.files.filter((file) => !file.isExample && (file.areaId || null) === areaId);
    const parts = cached.parts.filter((part) => !part.isExample && (part.areaId || null) === areaId);
    const active = projectData.activeAreaId === areaId;
    return `<article class="area-folder ${active ? "active" : ""}">
      <div class="folder-icon" aria-hidden="true">${areaId ? "▤" : "?"}</div>
      <div class="folder-label">KAROSSERIE / ${areaId ? "BEREICH" : "EINGANG"}</div>
      <h3>${escapeHtml(area.name)}</h3>
      <p>${files.length} Datei-Version(en) · ${parts.length} Teil(e)</p>
      <button type="button" class="small-button" data-open-area="${escapeHtml(area.id)}">${active ? "Aktiver Bereich" : "Hier starten →"}</button>
    </article>`;
  }).join("");
}

function renderAreaWorkspace() {
  const activeAreaId = projectData.activeAreaId ?? null;
  const title = areaName(activeAreaId);
  $("active-area-title").textContent = title;
  $("area-files-title").textContent = title;
  $("area-hint").textContent = activeAreaId
    ? `Arbeitsbereich Karosserie / ${title}. Unbestätigte Zuordnungen bleiben in „Noch zugeordnet“.`
    : "Ordne Dateien erst einem Bereich zu, wenn ihre Funktion und Einbaulage geklärt sind.";
  $("area-files-description").textContent = "Dateien nach Upload-Reihenfolge; die Reihenfolge ist kein technischer Montage- oder Drucknachweis.";

  const files = cached.files.filter((file) => (file.areaId || null) === activeAreaId)
    .sort((a, b) => (Number(a.queueOrder) || Date.parse(a.createdAt) || 0) - (Number(b.queueOrder) || Date.parse(b.createdAt) || 0));
  const parts = cached.parts.filter((part) => !part.isExample && (part.areaId || null) === activeAreaId);
  const next = recommendedPrint();
  const items = [
    ...files.map((file) => {
      const print = cached.prints.find((candidate) => candidate.fileId === file.id);
      const isNext = next?.fileId === file.id;
      const status = print ? printStatusLabel(print.status) : "Noch nicht vorgemerkt";
      return `<article class="area-item ${isNext ? "recommended" : ""}">
        <span class="area-item-icon" aria-hidden="true">▧</span>
        <div class="area-item-main"><strong>${escapeHtml(file.name)}${isNext ? ' <span class="dependency-pill">Nächste Empfehlung</span>' : ""}</strong>
          <small>Datei-Version ${escapeHtml(file.version)} · ${escapeHtml(status)} · ${escapeHtml(getPart(file.partId)?.name || "Keinem Teil zugeordnet")}</small></div>
        <button type="button" class="small-button" data-view="dateien">Datei öffnen</button>
      </article>`;
    }),
    ...parts.map((part) => `<article class="area-item">
      <span class="area-item-icon" aria-hidden="true">▦</span>
      <div class="area-item-main"><strong>${escapeHtml(part.name)}${part.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</strong>
        <small>${escapeHtml(STATUS_LABELS[part.status] || "Unbekannt")} · ${escapeHtml(part.code || "Keine Kennung")}</small></div>
      <button type="button" class="small-button" data-view="teile">Teil öffnen</button>
    </article>`)
  ];
  $("area-work-items").innerHTML = items.length
    ? items.join("")
    : emptyHtml("Dieser Ordner ist noch leer", activeAreaId
      ? "Lade Dateien hoch und ordne sie hier zu, sobald der Einbauort bestätigt ist."
      : "Neue Dateien und Teile erscheinen hier, bis du ihren Bereich festlegst.");
}

function renderParts() {
  const search = $("part-search").value.trim().toLocaleLowerCase("de");
  const status = $("part-status-filter").value;
  const areaFilter = $("part-area-filter").value;
  const mode = $("part-view-mode").value;
  const parts = [...cached.parts]
    .filter((item) => !status || item.status === status)
    .filter((item) => !areaFilter
      || (areaFilter === UNASSIGNED_AREA_ID ? !item.areaId : item.areaId === areaFilter))
    .filter((item) => !search || [item.name, item.code, item.material, item.notes, areaName(item.areaId)].join(" ").toLocaleLowerCase("de").includes(search))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const host = $("parts-list");
  if (!parts.length) {
    host.innerHTML = emptyHtml(search ? "Keine passenden Teile" : "Noch keine Teile erfasst", search ? "Passe Suche oder Filter an." : "Erfasse ein Teil oder ändere deine Filter.");
    host.className = "panel table-panel";
    return;
  }
  if (mode === "cards") {
    host.className = "panel table-panel parts-cards";
    host.innerHTML = parts.map((part) => `
      <article class="part-card">
        <h3>${escapeHtml(part.name)}${part.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</h3>
        <div class="part-meta">${statusPill(part.status)}<span class="dependency-pill">${escapeHtml(areaName(part.areaId))}</span><span class="dependency-pill">Bestand: ${part.stock === null ? "nicht erfasst" : `${escapeHtml(part.stock)} Stk.`}</span></div>
        <p>${escapeHtml(part.notes || "Keine Notiz hinterlegt.")}</p>
        <div class="table-actions"><button class="small-button" type="button" data-edit-part="${escapeHtml(part.id)}">Bearbeiten</button><button class="small-button" type="button" data-queue-part="${escapeHtml(part.id)}">Druck planen</button></div>
      </article>`).join("");
    return;
  }
  host.className = "panel table-panel";
  host.innerHTML = `<table class="data-table"><thead><tr><th>Teil</th><th>Bereich</th><th>Status</th><th>Bestand</th><th>Material</th><th>Aktionen</th></tr></thead><tbody>${parts.map((part) => `
    <tr>
      <td><strong>${escapeHtml(part.name)}${part.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</strong><small>${escapeHtml(part.code || part.notes || "Keine ergänzenden Angaben")}</small></td>
      <td>${escapeHtml(areaName(part.areaId))}</td><td>${statusPill(part.status)}</td><td>${part.stock === null ? '<span class="muted">Nicht erfasst</span>' : `${escapeHtml(part.stock)} Stk.`}</td>
      <td>${escapeHtml(part.material || "—")}</td>
      <td><div class="table-actions"><button class="small-button" type="button" data-edit-part="${escapeHtml(part.id)}">Bearbeiten</button><button class="small-button" type="button" data-queue-part="${escapeHtml(part.id)}">Druck planen</button></div></td>
    </tr>`).join("")}</tbody></table>`;
}

function emptyHtml(title, message) {
  return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p></div>`;
}

function getPart(partId) {
  return cached.parts.find((part) => part.id === partId);
}

function getFile(fileId) {
  return cached.files.find((file) => file.id === fileId);
}

function getPrint(printId) {
  return cached.prints.find((item) => item.id === printId);
}

function nextQueueOrder(offset) {
  const maximum = cached.prints.reduce((max, item) => Math.max(max, Number(item.queueOrder) || 0), 0);
  return maximum + (offset || 1);
}

function dependencyBlockers(print) {
  return (print.dependencies || []).map((id) => {
    const dependency = getPrint(id);
    if (!dependency) return { id, name: "Fehlender Queue-Eintrag" };
    const journal = cached.journal.find((entry) => entry.printId === dependency.id);
    if (dependency.status !== "complete" || !journal || !journal.qualityConfirmed) {
      return { id, name: dependency.isExample ? "Beispiel-Drucklauf" : (getFile(dependency.fileId)?.name || getPart(dependency.partId)?.name || "Teil") };
    }
    return null;
  }).filter(Boolean);
}

function printAreaId(print) {
  const file = getFile(print.fileId);
  const part = getPart(print.partId);
  return print.areaId ?? file?.areaId ?? part?.areaId ?? null;
}

function getQueueGuidance(print) {
  const file = getFile(print.fileId);
  if (print.status === "complete") return { title: file ? "Datei fertig gespeichert" : "Abgeschlossen", message: "Der Lauf ist im Druckjournal dokumentiert." };
  if (print.status === "printing") return { title: "Drucklauf dokumentieren", message: "Erfasse das Ergebnis. Nur eine ausdrücklich bestätigte Gutmenge kann den erfassten Bestand erhöhen." };
  const blockers = dependencyBlockers(print);
  if (blockers.length) {
    return { title: "Abhängigkeiten klären", message: `Warte auf qualitätsbestätigte Abschlüsse: ${blockers.map((item) => item.name).join(", ")}.` };
  }
  if (print.quantity === null || print.quantity === undefined) {
    return { title: file ? "Nächste Datei: Stückzahl festlegen" : "Stückzahl festlegen", message: `Lege zuerst die geplante Stückzahl für ${file?.name || getPart(print.partId)?.name || "diesen Lauf"} fest. Die App leitet keine Menge aus Dateiinhalten ab.` };
  }
  return { title: "Extern prüfen, dann Start dokumentieren", message: "Validiere Druckdaten, Material und Freigaben außerhalb der App; danach kannst du den Start als Nutzereingabe festhalten." };
}

function recommendedPrint() {
  const activeAreaId = projectData.activeAreaId ?? null;
  const projectItems = cached.prints
    .filter((item) => !item.isExample && item.status !== "complete" && printAreaId(item) === activeAreaId)
    .sort(compareQueueOrder);
  return projectItems.find((item) => item.status === "printing" || !dependencyBlockers(item).length) || projectItems[0] || null;
}

function compareQueueOrder(first, second) {
  const firstOrder = Number(first.queueOrder) || Date.parse(first.createdAt) || 0;
  const secondOrder = Number(second.queueOrder) || Date.parse(second.createdAt) || 0;
  return firstOrder - secondOrder;
}

function renderQueueSelectors() {
  const selectedPart = $("queue-part").value;
  $("queue-part").innerHTML = `<option value="">Teil auswählen</option>${[...cached.parts].sort((a, b) => a.name.localeCompare(b.name, "de")).map((part) => `<option value="${escapeHtml(part.id)}">${escapeHtml(part.name)}${part.isExample ? " (Beispiel)" : ""}</option>`).join("")}`;
  if (cached.parts.some((part) => part.id === selectedPart)) $("queue-part").value = selectedPart;

  const dependencyHost = $("dependency-options");
  const eligible = cached.prints.filter((item) => item.status !== "complete");
  dependencyHost.innerHTML = eligible.length ? eligible.map((item) => {
    const name = getFile(item.fileId)?.name || getPart(item.partId)?.name || "Unbekanntes Teil";
    return `<label><input type="checkbox" name="queue-dependency" value="${escapeHtml(item.id)}"><span>${escapeHtml(name)}${item.isExample ? " · Beispiel" : ""} — ${escapeHtml(printStatusLabel(item.status))}</span></label>`;
  }).join("") : '<span class="muted">Keine offenen Druckläufe als Abhängigkeit vorhanden.</span>';
}

function renderQueue() {
  renderQueueSelectors();
  const host = $("queue-list");
  const queue = [...cached.prints].sort((a, b) => {
    const statusRank = (item) => item.status === "complete" ? 2 : item.status === "printing" ? 1 : 0;
    return statusRank(a) - statusRank(b) || compareQueueOrder(a, b);
  });
  if (!queue.length) {
    host.innerHTML = emptyHtml("Queue ist leer", "Plane einen Drucklauf für ein erfasstes Teil.");
    return;
  }
  host.innerHTML = queue.map((item) => {
    const file = getFile(item.fileId);
    const displayName = file?.name || getPart(item.partId)?.name || "Unbekanntes Teil";
    const guidance = getQueueGuidance(item);
    const blockers = dependencyBlockers(item);
    const label = item.status === "complete" ? (file ? "Datei fertig" : "Journalisiert") : item.status === "printing" ? "Lauf dokumentiert gestartet" : "Geplant";
    const stateClass = item.status === "complete" ? "done" : item.status === "printing" ? "printing" : "";
    let action = file
      ? `<button type="button" class="small-button" data-download-file="${escapeHtml(file.id)}">Datei herunterladen</button>`
      : "";
    if (item.status === "planned" && (item.quantity === null || item.quantity === undefined)) {
      action += `<label class="quantity-entry">Stückzahl <input data-quantity-for="${escapeHtml(item.id)}" type="number" min="1" step="1" aria-label="Geplante Stückzahl für ${escapeHtml(displayName)}"></label><button type="button" class="small-button" data-save-quantity="${escapeHtml(item.id)}">Stückzahl speichern</button>`;
    }
    if (item.status === "planned" && item.quantity !== null && item.quantity !== undefined && !blockers.length) action += `<button type="button" class="small-button" data-start-print="${escapeHtml(item.id)}">Start dokumentieren</button>`;
    if (item.status === "printing") action += `<button type="button" class="small-button" data-finish-print="${escapeHtml(item.id)}">Ergebnis erfassen</button>`;
    const depNames = (item.dependencies || []).map((id) => {
      const dependency = getPrint(id);
      return dependency ? (getFile(dependency.fileId)?.name || getPart(dependency.partId)?.name || "Teil") : "Fehlender Eintrag";
    });
    const dependencyEditor = item.status === "planned" ? `<details class="dependency-editor">
      <summary>Abhängigkeiten festlegen</summary>
      <label class="sr-only" for="dependencies-${escapeHtml(item.id)}">Vorgänger für ${escapeHtml(displayName)}</label>
      <select id="dependencies-${escapeHtml(item.id)}" data-dependencies-for="${escapeHtml(item.id)}" multiple size="4">${cached.prints.filter((candidate) => candidate.id !== item.id).map((candidate) => {
        const name = getFile(candidate.fileId)?.name || getPart(candidate.partId)?.name || "Teil";
        const selected = (item.dependencies || []).includes(candidate.id) ? " selected" : "";
        return `<option value="${escapeHtml(candidate.id)}"${selected}>${escapeHtml(name)} · ${escapeHtml(printStatusLabel(candidate.status))}</option>`;
      }).join("")}</select>
      <button type="button" class="small-button" data-save-dependencies="${escapeHtml(item.id)}">Vorgänger speichern</button>
    </details>` : "";
    return `<article class="queue-card">
      <div><div class="queue-meta"><span class="status-pill queue-state ${stateClass}">${label}</span>${blockers.length ? `<span class="dependency-pill">${blockers.length} Abhängigkeit(en) offen</span>` : ""}${item.isExample ? '<span class="sample-pill">BEISPIEL</span>' : ""}</div>
        <h3>${escapeHtml(displayName)}${file && item.quantity === null ? ' <span class="dependency-pill">Menge offen</span>' : ""}</h3>
        <p>${item.quantity === null || item.quantity === undefined ? "Stückzahl noch nicht erfasst" : `${escapeHtml(item.quantity)} Stück geplant`} · angelegt ${escapeHtml(formatDate(item.createdAt, false))}</p>
        ${depNames.length ? `<p>Abhängig von: ${escapeHtml(depNames.join(", "))}</p>` : ""}
        ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
        <p class="queue-next"><strong>Nächste Aktion:</strong> ${escapeHtml(guidance.message)}</p>
      </div>
      <div class="queue-actions">${action}${dependencyEditor}${item.status === "planned" ? `<button type="button" class="small-button" data-remove-queue="${escapeHtml(item.id)}">Aus Queue entfernen</button>` : ""}</div>
    </article>`;
  }).join("");
}

function renderJournal() {
  const host = $("journal-list");
  const entries = [...cached.journal].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  if (!entries.length) {
    host.innerHTML = emptyHtml("Noch keine Druckläufe im Journal", "Abgeschlossene Queue-Läufe werden mit Ergebnis und Qualitätsbestätigung dokumentiert.");
    return;
  }
  host.innerHTML = `<table class="data-table"><thead><tr><th>Datum / Teil</th><th>Ergebnis</th><th>Qualitätsbestätigung</th><th>Bestand</th><th>Notiz</th></tr></thead><tbody>${entries.map((entry) => {
    const part = getPart(entry.partId);
    const file = getFile(entry.fileId);
    const quality = entry.qualityConfirmed
      ? '<span class="status-pill status-complete">Gutmenge bestätigt</span>'
      : '<span class="dependency-pill">Nicht bestätigt</span>';
    let stock = "Nicht verändert";
    if (entry.qualityConfirmed && entry.stockUpdated) stock = `+${entry.goodQuantity} Stk. gebucht`;
    else if (entry.qualityConfirmed && entry.stockUnknown) stock = "Nicht gebucht · Ausgangsbestand unbekannt";
    return `<tr><td><strong>${escapeHtml(formatDate(entry.completedAt, true))}</strong><small>${escapeHtml(file?.name || part?.name || "Teil nicht vorhanden")}${entry.isExample ? " · Beispiel" : ""}</small></td>
      <td>${escapeHtml(entry.producedQuantity)} produziert${entry.goodQuantity === null ? "" : ` · ${escapeHtml(entry.goodQuantity)} gut`}</td><td>${quality}</td>
      <td>${escapeHtml(stock)}</td><td>${escapeHtml(entry.note || "—")}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderAssemblies() {
  const partHost = $("assembly-part-options");
  partHost.innerHTML = cached.parts.length ? [...cached.parts].sort((a, b) => a.name.localeCompare(b.name, "de")).map((part) =>
    `<label><input type="checkbox" name="assembly-part" value="${escapeHtml(part.id)}"><span>${escapeHtml(part.name)}${part.isExample ? " · Beispiel" : ""}</span></label>`
  ).join("") : '<span class="muted">Lege zuerst Teile an.</span>';
  const host = $("assemblies-list");
  if (!cached.assemblies.length) {
    host.innerHTML = emptyHtml("Noch keine Baugruppen", "Erfasse eine Montagegruppe und ordne ihr Teile zu.");
    return;
  }
  host.innerHTML = [...cached.assemblies].sort((a, b) => a.name.localeCompare(b.name, "de")).map((assembly) => {
    const members = (assembly.partIds || []).map((id) => getPart(id)).filter(Boolean);
    return `<article class="assembly-card"><div class="file-card-header"><h3>${escapeHtml(assembly.name)}</h3>${assembly.isExample ? '<span class="sample-pill">BEISPIEL</span>' : ""}</div>
      <p>${members.length} zugeordnete Teile · angelegt ${escapeHtml(formatDate(assembly.createdAt, false))}</p>
      ${assembly.notes ? `<p>${escapeHtml(assembly.notes)}</p>` : ""}
      <ul class="assembly-members">${members.length ? members.map((part) => `<li>${escapeHtml(part.name)}${part.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</li>`).join("") : "<li>Keine Teile zugeordnet</li>"}</ul></article>`;
  }).join("");
}

function renderFiles() {
  const documents = new Map();
  cached.files.forEach((file) => {
    const versions = documents.get(file.documentId) || [];
    versions.push(file);
    documents.set(file.documentId, versions);
  });
  const host = $("files-list");
  if (!documents.size) {
    host.innerHTML = emptyHtml("Noch keine Projektdateien", "Lade mehrere Dateien gesammelt hoch. Jede wird anhand ihres Upload-Dateinamens als eigener Druckkandidat registriert.");
    return;
  }
  host.innerHTML = Array.from(documents.entries()).sort((first, second) => {
    const firstLatest = first[1].reduce((max, file) => file.version > max.version ? file : max, first[1][0]);
    const secondLatest = second[1].reduce((max, file) => file.version > max.version ? file : max, second[1][0]);
    return (Number(firstLatest.queueOrder) || Date.parse(firstLatest.createdAt) || 0) - (Number(secondLatest.queueOrder) || Date.parse(secondLatest.createdAt) || 0);
  }).map(([documentId, versions]) => {
    versions.sort((a, b) => b.version - a.version);
    const latest = versions[0];
    const stateLabel = latest.printState === "complete"
      ? `Druck fertig · Qualität ${latest.lastPrintQualityConfirmed ? "bestätigt" : "offen"}`
      : ({ planned: "Vorgemerkt", printing: "Druck dokumentiert" })[latest.printState] || "Noch nicht gedruckt";
    const versionRows = versions.map((file) => {
      const versionState = file.printState === "complete"
        ? `Druck fertig · Qualität ${file.lastPrintQualityConfirmed ? "bestätigt" : "offen"}`
        : ({ planned: "Vorgemerkt", printing: "Druck dokumentiert" })[file.printState] || "Noch nicht gedruckt";
      return `<div class="file-version"><div><strong>Version ${escapeHtml(file.version)} · ${escapeHtml(formatBytes(file.size))} · ${escapeHtml(versionState)}</strong><small>${escapeHtml(formatDate(file.createdAt, true))}${file.note ? ` · ${escapeHtml(file.note)}` : ""}</small></div>
        <div class="version-actions"><button type="button" class="small-button" data-download-file="${escapeHtml(file.id)}">Herunterladen</button></div></div>`;
    }).join("");
    const partOptions = `<option value="">Kein Teil zugeordnet</option>${[...cached.parts].sort((a, b) => a.name.localeCompare(b.name, "de")).map((part) =>
      `<option value="${escapeHtml(part.id)}"${part.id === latest.partId ? " selected" : ""}>${escapeHtml(part.name)}${part.isExample ? " (Beispiel)" : ""}</option>`
    ).join("")}`;
    const fileAreaOptions = makeAreaOptions(latest.areaId || null, false);
    const associationLocked = cached.journal.some((entry) => entry.fileId === latest.id);
    return `<article class="file-card"><div class="file-card-header"><div><h3>${escapeHtml(latest.name)}</h3><p>${versions.length} Version${versions.length === 1 ? "" : "en"}${latest.isExample ? " · Beispiel" : ""} · ${escapeHtml(areaName(latest.areaId))}</p></div><span class="status-pill">${escapeHtml(stateLabel)} · V${escapeHtml(latest.version)}</span></div>
      <div class="file-part-link"><label>Karosseriebereich <select data-file-area-for="${escapeHtml(latest.id)}">${fileAreaOptions}</select></label><button type="button" class="small-button" data-save-file-area="${escapeHtml(latest.id)}">Bereich speichern</button></div>
      <div class="file-part-link"><label>Projektteil zuordnen <select data-file-part-for="${escapeHtml(latest.id)}"${associationLocked ? " disabled" : ""}>${partOptions}</select></label><button type="button" class="small-button" data-save-file-part="${escapeHtml(latest.id)}"${associationLocked ? " disabled" : ""}>Zuordnung speichern</button></div>
      ${associationLocked ? '<small class="muted">Druckjournal vorhanden: Zuordnungen werden nicht rückwirkend geändert.</small>' : ""}
      <div class="file-version-list">${versionRows}</div></article>`;
  }).join("");
}

function renderChanges() {
  const host = $("changes-list");
  const changes = [...cached.changes].sort((a, b) => b.at.localeCompare(a.at));
  if (!changes.length) {
    host.innerHTML = emptyHtml("Noch keine protokollierten Änderungen", "Änderungen an Projektobjekten werden hier lokal sichtbar.");
    return;
  }
  host.innerHTML = changes.map((item) => `<div class="timeline-row"><span class="timeline-dot" aria-hidden="true"></span><div>
    <strong>${escapeHtml(item.title)}${item.isExample ? ' <span class="sample-pill">BEISPIEL</span>' : ""}</strong><p>${escapeHtml(item.detail || "")}</p></div>
    <time datetime="${escapeHtml(item.at)}">${escapeHtml(formatDate(item.at, true))}</time></div>`).join("");
}

function navigate(viewName, persist) {
  if (!VIEW_TITLES[viewName]) return;
  const changedView = currentView !== viewName;
  currentView = viewName;
  document.querySelectorAll(".view").forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("page-title").textContent = VIEW_TITLES[viewName];
  window.history.replaceState(null, "", `#${viewName}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (persist !== false) {
    localStorage.setItem(LAST_VIEW_KEY, viewName);
    if (changedView) markCloudDirty();
  }
}

async function startArea(value) {
  const areaId = parseAreaValue(value);
  if (value !== UNASSIGNED_AREA_ID && areaId !== value) throw new Error("Bitte einen vorhandenen Karosseriebereich auswählen.");
  if (projectData.activeAreaId !== areaId) {
    const updatedProject = { ...projectData, activeAreaId: areaId, updatedAt: new Date().toISOString() };
    const change = changeRecord("Arbeitsbereich ausgewählt", areaName(areaId));
    await transaction(["project", "changes"], "readwrite", (tx) => {
      tx.objectStore("project").put(updatedProject);
      tx.objectStore("changes").put(change);
    });
    await refresh();
  }
  navigate("bereiche");
}

async function addArea(event) {
  event.preventDefault();
  const name = $("area-name").value.trim();
  if (!name) throw new Error("Bitte einen Bereichsnamen eingeben.");
  if (projectData.areas.some((area) => area.name.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) {
    throw new Error("Ein Bereich mit diesem Namen ist bereits vorhanden.");
  }
  const order = projectData.areas.reduce((maximum, area) => Math.max(maximum, Number(area.order) || 0), 0) + 1;
  const area = { id: makeId("area"), name, order, createdAt: new Date().toISOString() };
  const updatedProject = {
    ...projectData,
    areas: [...projectData.areas, area],
    activeAreaId: area.id,
    updatedAt: new Date().toISOString()
  };
  const change = changeRecord("Karosseriebereich angelegt", name);
  await transaction(["project", "changes"], "readwrite", (tx) => {
    tx.objectStore("project").put(updatedProject);
    tx.objectStore("changes").put(change);
  });
  $("area-form").reset();
  await refresh();
  navigate("bereiche");
  showAlert(`Bereich „${name}“ angelegt und als Arbeitsbereich geöffnet.`, true);
}

function setPartEditor(part) {
  $("part-editor-panel").hidden = false;
  $("part-form-title").textContent = part ? "Teil bearbeiten" : "Neues Teil";
  $("part-id").value = part?.id || "";
  $("part-name").value = part?.name || "";
  $("part-code").value = part?.code || "";
  $("part-status").value = part?.status || "concept";
  $("part-stock").value = part?.stock === null || part?.stock === undefined ? "" : part.stock;
  $("part-material").value = part?.material || "";
  $("part-area").value = part?.areaId || UNASSIGNED_AREA_ID;
  $("part-notes").value = part?.notes || "";
  $("part-name").focus();
}

function closePartEditor() {
  $("part-editor-panel").hidden = true;
  $("part-form").reset();
  $("part-id").value = "";
}

async function savePart(event) {
  event.preventDefault();
  const id = $("part-id").value;
  const existing = id ? getPart(id) : null;
  const stockRaw = $("part-stock").value.trim();
  const stock = stockRaw === "" ? null : Number(stockRaw);
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) throw new Error("Der Bestand muss eine nicht negative ganze Stückzahl sein.");
  const name = $("part-name").value.trim();
  if (!name) throw new Error("Bitte eine Bezeichnung eingeben.");
  const part = {
    id: existing?.id || makeId("part"),
    name,
    code: $("part-code").value.trim(),
    status: $("part-status").value,
    stock,
    material: $("part-material").value.trim(),
    areaId: parseAreaValue($("part-area").value),
    notes: $("part-notes").value.trim(),
    isExample: existing?.isExample || false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const stockChanged = existing && existing.stock !== stock;
  const change = changeRecord(existing ? "Teil aktualisiert" : "Teil angelegt",
    `${part.name}${stockChanged ? ` · Bestand manuell ${stock === null ? "als nicht erfasst markiert" : "erfasst/angepasst"}` : ""}`);
  await transaction(["parts", "changes"], "readwrite", (tx) => {
    tx.objectStore("parts").put(part);
    tx.objectStore("changes").put(change);
  });
  closePartEditor();
  await refresh();
  showAlert(existing ? "Teil aktualisiert." : "Teil gespeichert.", true);
}

function moveToQueue(partId) {
  navigate("druckqueue");
  $("queue-part").value = partId;
  $("queue-quantity").focus();
}

async function addQueueItem(event) {
  event.preventDefault();
  const partId = $("queue-part").value;
  const quantity = Number($("queue-quantity").value);
  const part = getPart(partId);
  if (!part) throw new Error("Bitte ein vorhandenes Teil auswählen.");
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Die geplante Stückzahl muss mindestens 1 sein.");
  const dependencies = Array.from(document.querySelectorAll('input[name="queue-dependency"]:checked')).map((input) => input.value);
  const item = {
    id: makeId("print"), partId, quantity, dependencies,
    notes: $("queue-notes").value.trim(), status: "planned", isExample: false,
    queueOrder: nextQueueOrder(),
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null
  };
  const change = changeRecord("Drucklauf eingeplant", `${part.name} · ${quantity} Stück`);
  await transaction(["prints", "changes"], "readwrite", (tx) => {
    tx.objectStore("prints").put(item);
    tx.objectStore("changes").put(change);
  });
  $("queue-form").reset();
  $("queue-quantity").value = "1";
  await refresh();
  showAlert("Drucklauf zur Queue hinzugefügt. Die App prüft keine technische Druckreife.", true);
}

async function savePrintQuantity(printId) {
  const item = getPrint(printId);
  if (!item || item.status !== "planned") throw new Error("Die Stückzahl kann nur für geplante Queue-Einträge festgelegt werden.");
  const field = Array.from(document.querySelectorAll("[data-quantity-for]"))
    .find((input) => input.dataset.quantityFor === printId);
  const quantity = Number(field?.value);
  if (!field || !Number.isInteger(quantity) || quantity < 1) throw new Error("Die geplante Stückzahl muss mindestens 1 sein.");
  const updated = { ...item, quantity };
  const change = changeRecord("Geplante Stückzahl eingetragen", `${getFile(item.fileId)?.name || getPart(item.partId)?.name || "Drucklauf"} · ${quantity} Stück`);
  await transaction(["prints", "changes"], "readwrite", (tx) => {
    tx.objectStore("prints").put(updated);
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert("Geplante Stückzahl gespeichert.", true);
}

function dependencyWouldCycle(printId, dependencyIds) {
  for (const dependencyId of dependencyIds) {
    const pending = [dependencyId];
    const visited = new Set();
    while (pending.length) {
      const currentId = pending.pop();
      if (currentId === printId) return true;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const current = getPrint(currentId);
      if (current) pending.push(...(current.dependencies || []));
    }
  }
  return false;
}

async function savePrintDependencies(printId) {
  const item = getPrint(printId);
  if (!item || item.status !== "planned") throw new Error("Abhängigkeiten können nur für geplante Queue-Einträge bearbeitet werden.");
  const picker = Array.from(document.querySelectorAll("[data-dependencies-for]"))
    .find((select) => select.dataset.dependenciesFor === printId);
  if (!picker) throw new Error("Die Abhängigkeitsauswahl ist nicht verfügbar.");
  const dependencies = Array.from(picker.selectedOptions).map((option) => option.value);
  if (dependencies.some((id) => !getPrint(id) || id === printId)) throw new Error("Eine ausgewählte Abhängigkeit ist ungültig.");
  if (dependencyWouldCycle(printId, dependencies)) throw new Error("Diese Verknüpfung würde einen Abhängigkeitskreis erzeugen.");
  const updated = { ...item, dependencies };
  const change = changeRecord("Druckabhängigkeiten aktualisiert",
    `${getFile(item.fileId)?.name || getPart(item.partId)?.name || "Drucklauf"} · ${dependencies.length} Vorgänger`);
  await transaction(["prints", "changes"], "readwrite", (tx) => {
    tx.objectStore("prints").put(updated);
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert("Abhängigkeiten gespeichert. Sie stellen keine automatisch erkannte technische Reihenfolge dar.", true);
}

async function startPrint(printId) {
  const item = getPrint(printId);
  if (!item || item.status !== "planned") throw new Error("Dieser Queue-Eintrag kann nicht gestartet werden.");
  if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error("Lege zuerst eine geplante Stückzahl fest.");
  const blockers = dependencyBlockers(item);
  if (blockers.length) throw new Error(`Noch offene Abhängigkeiten: ${blockers.map((entry) => entry.name).join(", ")}.`);
  const updated = { ...item, status: "printing", startedAt: new Date().toISOString() };
  const file = getFile(item.fileId);
  const updatedFile = file ? { ...file, printState: "printing", printStartedAt: updated.startedAt } : null;
  const change = changeRecord("Druckstart dokumentiert", `${file?.name || getPart(item.partId)?.name || "Teil"} · Nutzereingabe, keine Druckerbestätigung`, item.isExample);
  const stores = ["prints", "changes"];
  if (updatedFile) stores.push("files");
  await transaction(stores, "readwrite", (tx) => {
    tx.objectStore("prints").put(updated);
    if (updatedFile) tx.objectStore("files").put(updatedFile);
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert("Start als Nutzereingabe dokumentiert; es wurde kein Drucker angesteuert.", true);
}

async function removeQueueItem(printId) {
  const item = getPrint(printId);
  if (!item || item.status !== "planned") throw new Error("Nur geplante Queue-Einträge können entfernt werden.");
  if (cached.prints.some((candidate) => (candidate.dependencies || []).includes(printId))) {
    throw new Error("Dieser Eintrag ist als Abhängigkeit verknüpft und kann nicht entfernt werden.");
  }
  if (!window.confirm("Diesen noch nicht gestarteten Queue-Eintrag entfernen?")) return;
  const file = getFile(item.fileId);
  const change = changeRecord("Drucklauf aus Queue entfernt", file?.name || getPart(item.partId)?.name || "Teil", item.isExample);
  const stores = ["prints", "changes"];
  if (file) stores.push("files");
  await transaction(stores, "readwrite", (tx) => {
    tx.objectStore("prints").delete(printId);
    if (file) tx.objectStore("files").put({ ...file, printState: null, printStartedAt: null, printCompletedAt: null });
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert("Queue-Eintrag entfernt.", true);
}

function openJournalDialog(printId) {
  const print = getPrint(printId);
  if (!print || print.status !== "printing") throw new Error("Dieser Drucklauf ist nicht als gestartet dokumentiert.");
  const part = getPart(print.partId);
  $("journal-queue-id").value = print.id;
  $("journal-dialog-title").textContent = getFile(print.fileId)?.name || part?.name || "Drucklauf";
  $("journal-produced").value = String(print.quantity);
  $("journal-good").value = "";
  $("journal-quality-confirmed").checked = false;
  $("journal-note").value = "";
  const warning = $("journal-stock-warning");
  warning.hidden = part?.stock !== null && part?.stock !== undefined;
  warning.textContent = "Der Ausgangsbestand ist nicht erfasst. Auch bei bestätigter Gutmenge wird der Bestand nicht automatisch erhöht; erfasse den Ausgangsbestand im Teileformular.";
  $("journal-dialog").showModal();
  $("journal-produced").focus();
}

async function finishPrint(event) {
  event.preventDefault();
  const printId = $("journal-queue-id").value;
  const print = getPrint(printId);
  const part = print ? getPart(print.partId) : null;
  if (!print || print.status !== "printing") throw new Error("Der Drucklauf wurde zwischenzeitlich geändert. Lade die Seite neu.");
  const producedQuantity = Number($("journal-produced").value);
  const qualityConfirmed = $("journal-quality-confirmed").checked;
  const goodRaw = $("journal-good").value.trim();
  const goodQuantity = qualityConfirmed ? Number(goodRaw) : null;
  if (!Number.isInteger(producedQuantity) || producedQuantity < 1) throw new Error("Zum Abschließen muss mindestens ein tatsächlich produziertes Stück eingetragen werden.");
  if (qualityConfirmed && (goodRaw === "" || !Number.isInteger(goodQuantity) || goodQuantity < 0 || goodQuantity > producedQuantity)) {
    throw new Error("Bei bestätigter Qualitätsprüfung muss die Gutmenge zwischen 0 und der produzierten Stückzahl liegen.");
  }
  const stockUpdated = Boolean(qualityConfirmed && part && part.stock !== null);
  const stockUnknown = Boolean(qualityConfirmed && part && part.stock === null);
  const completedAt = new Date().toISOString();
  const file = getFile(print.fileId);
  const journal = {
    id: makeId("journal"), printId, partId: print.partId, fileId: print.fileId || null,
    producedQuantity, goodQuantity, qualityConfirmed,
    stockUpdated, stockUnknown, note: $("journal-note").value.trim(),
    completedAt, isExample: print.isExample
  };
  const updatedPrint = { ...print, status: "complete", completedAt };
  const change = changeRecord("Drucklauf im Journal abgeschlossen",
    `${file?.name || part?.name || "Teil"} · ${qualityConfirmed ? `${goodQuantity} Gutmenge bestätigt${stockUpdated ? " und Bestand aktualisiert" : stockUnknown ? " · Bestand mangels Ausgangswert unverändert" : ""}` : "Qualität nicht bestätigt; Bestand unverändert"}`,
    print.isExample);
  const stores = ["prints", "journal", "changes"];
  if (stockUpdated) stores.push("parts");
  if (file) stores.push("files");
  await transaction(stores, "readwrite", (tx) => {
    tx.objectStore("prints").put(updatedPrint);
    tx.objectStore("journal").put(journal);
    tx.objectStore("changes").put(change);
    if (file) {
      tx.objectStore("files").put({
        ...file,
        printState: "complete",
        printCompletedAt: completedAt,
        lastPrintQualityConfirmed: qualityConfirmed
      });
    }
    if (stockUpdated) {
      tx.objectStore("parts").put({
        ...part,
        stock: part.stock + goodQuantity,
        updatedAt: completedAt
      });
    }
  });
  $("journal-dialog").close();
  await refresh();
  const message = stockUpdated
    ? `Journal gespeichert; bestätigte Gutmenge (${goodQuantity}) zum erfassten Bestand addiert.`
    : qualityConfirmed && stockUnknown
      ? "Journal gespeichert; der Ausgangsbestand ist unbekannt, daher wurde der Bestand nicht verändert."
      : qualityConfirmed
        ? "Journal gespeichert; Datei als druckfertig markiert. Es ist kein Teilebestand verknüpft."
        : "Journal gespeichert; Druck als beendet markiert, aber ohne Qualitätsbestätigung bleibt der Bestand unverändert.";
  showAlert(message, true);
}

async function addAssembly(event) {
  event.preventDefault();
  const name = $("assembly-name").value.trim();
  if (!name) throw new Error("Bitte einen Baugruppennamen eingeben.");
  const partIds = Array.from(document.querySelectorAll('input[name="assembly-part"]:checked')).map((input) => input.value);
  const item = {
    id: makeId("assembly"), name, partIds, notes: $("assembly-notes").value.trim(),
    isExample: false, createdAt: new Date().toISOString()
  };
  const change = changeRecord("Baugruppe angelegt", `${name} · ${partIds.length} Teile zugeordnet`);
  await transaction(["assemblies", "changes"], "readwrite", (tx) => {
    tx.objectStore("assemblies").put(item);
    tx.objectStore("changes").put(change);
  });
  $("assembly-form").reset();
  await refresh();
  showAlert("Baugruppe gespeichert.", true);
}

async function addFileVersion(event) {
  event.preventDefault();
  const uploadedFiles = Array.from($("file-input").files);
  if (!uploadedFiles.length) throw new Error("Bitte mindestens eine Datei auswählen.");
  const note = $("file-note").value.trim();
  const latestByName = new Map();
  cached.files.forEach((record) => {
    const previous = latestByName.get(record.name);
    if (!previous || record.version > previous.version) latestByName.set(record.name, record);
  });
  const records = [];
  const candidates = [];
  const changes = [];
  const now = new Date().toISOString();
  let order = nextQueueOrder();
  uploadedFiles.forEach((uploadedFile) => {
    const previous = latestByName.get(uploadedFile.name);
    const fileId = makeId("file");
    const record = {
      id: fileId,
      documentId: previous?.documentId || fileId,
      name: uploadedFile.name,
      partId: previous?.partId || null,
      areaId: previous?.areaId || null,
      version: previous ? previous.version + 1 : 1,
      queueOrder: order,
      mimeType: uploadedFile.type || "application/octet-stream",
      size: uploadedFile.size,
      blob: uploadedFile,
      note,
      printState: "planned",
      printStartedAt: null,
      printCompletedAt: null,
      lastPrintQualityConfirmed: null,
      createdAt: now,
      isExample: false
    };
    const candidate = {
      id: makeId("print"),
      partId: record.partId,
      fileId,
      quantity: null,
      dependencies: [],
      notes: "Automatisch aus dem Upload vorgemerkt. Dateiname und Inhalt ersetzen keine technischen Daten oder Freigaben.",
      status: "planned",
      queueOrder: order,
      isExample: false,
      createdAt: now,
      startedAt: null,
      completedAt: null
    };
    records.push(record);
    candidates.push(candidate);
    changes.push(changeRecord(previous ? "Dateiversion hochgeladen" : "Datei erkannt und vorgemerkt",
      `${record.name} · Version ${record.version} · ${formatBytes(record.size)}`));
    latestByName.set(uploadedFile.name, record);
    order += 1;
  });
  await transaction(["files", "prints", "changes"], "readwrite", (tx) => {
    records.forEach((record) => tx.objectStore("files").put(record));
    candidates.forEach((candidate) => tx.objectStore("prints").put(candidate));
    changes.forEach((change) => tx.objectStore("changes").put(change));
  });
  $("file-form").reset();
  await refresh();
  showAlert(`${records.length} Datei(en) einzeln erkannt und als Druckkandidaten vorgemerkt. Trage je Datei die Stückzahl ein; technische Abhängigkeiten werden nicht erraten.`, true);
}

async function saveFileArea(fileId) {
  const file = getFile(fileId);
  const picker = Array.from(document.querySelectorAll("[data-file-area-for]"))
    .find((select) => select.dataset.fileAreaFor === fileId);
  if (!file || !picker) throw new Error("Datei oder Bereichsauswahl ist nicht verfügbar.");
  const areaId = parseAreaValue(picker.value);
  const updatedFile = { ...file, areaId };
  const relatedPrints = cached.prints.filter((print) => print.fileId === fileId).map((print) => ({ ...print, areaId }));
  const change = changeRecord("Datei einem Karosseriebereich zugeordnet", `${file.name} · ${areaName(areaId)}`);
  await transaction(["files", "prints", "changes"], "readwrite", (tx) => {
    tx.objectStore("files").put(updatedFile);
    relatedPrints.forEach((print) => tx.objectStore("prints").put(print));
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert(`Datei ${file.name} dem Bereich „${areaName(areaId)}“ zugeordnet.`, true);
}

async function saveFilePart(fileId) {
  const file = getFile(fileId);
  if (cached.journal.some((entry) => entry.fileId === fileId)) {
    throw new Error("Nach einem Druckjournaleintrag wird die Teilezuordnung nicht rückwirkend geändert.");
  }
  const picker = Array.from(document.querySelectorAll("[data-file-part-for]"))
    .find((select) => select.dataset.filePartFor === fileId);
  if (!file || !picker) throw new Error("Datei oder Teilezuordnung ist nicht verfügbar.");
  const partId = picker.value || null;
  if (partId && !getPart(partId)) throw new Error("Das ausgewählte Teil ist nicht mehr vorhanden.");
  const areaId = file.areaId || (partId ? getPart(partId).areaId : null);
  const updatedFile = { ...file, partId, areaId };
  const relatedPrints = cached.prints.filter((print) => print.fileId === fileId).map((print) => ({ ...print, partId, areaId }));
  const change = changeRecord("Datei einem Projektteil zugeordnet",
    `${file.name} · ${partId ? getPart(partId).name : "Zuordnung entfernt"}`);
  await transaction(["files", "prints", "changes"], "readwrite", (tx) => {
    tx.objectStore("files").put(updatedFile);
    relatedPrints.forEach((print) => tx.objectStore("prints").put(print));
    tx.objectStore("changes").put(change);
  });
  await refresh();
  showAlert(partId
    ? "Zuordnung gespeichert. Eine qualitätsbestätigte Gutmenge kann den erfassten Teilebestand aktualisieren."
    : "Teilezuordnung entfernt; der Dateidruck ändert keinen Teilebestand.", true);
}

function downloadFile(fileId) {
  const record = cached.files.find((item) => item.id === fileId);
  if (!record || !(record.blob instanceof Blob)) throw new Error("Die gespeicherte Datei ist nicht verfügbar.");
  const url = URL.createObjectURL(record.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = record.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showAlert(`${record.name} wurde heruntergeladen. Öffne die Datei im Download-Ordner oder über „Datei → Öffnen“ in Bambu Studio.`, true);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("Dateiinhalt konnte nicht für die Sicherung gelesen werden."));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Dateiinhalt konnte nicht gelesen werden."));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(value, mimeType) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Die Sicherung enthält einen ungültig kodierten Dateiinhalt.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

async function exportBackup() {
  await loadData();
  const files = await Promise.all(cached.files.map(async (file) => {
    if (!(file.blob instanceof Blob)) throw new Error(`Dateiinhalt fehlt bei Version ${file.name} V${file.version}; Export abgebrochen.`);
    const { blob, ...metadata } = file;
    return { ...metadata, contentBase64: await blobToBase64(blob) };
  }));
  const backup = {
    format: "roadster-karosserieprojekt-backup",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    project: projectData,
    parts: cached.parts,
    prints: cached.prints,
    assemblies: cached.assemblies,
    files,
    journal: cached.journal,
    changes: cached.changes
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `roadster-projekt-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showAlert(`JSON-Sicherung erstellt (${formatBytes(blob.size)}). Bewahre sie getrennt vom Browser auf.`, true);
}

function validateBackup(data) {
  const requiredArrays = ["parts", "prints", "assemblies", "files", "journal", "changes"];
  if (!data || data.format !== "roadster-karosserieprojekt-backup" || data.formatVersion !== 1
      || !data.project || data.project.id !== "main" || typeof data.project.name !== "string") {
    throw new Error("Unbekanntes Sicherungsformat oder fehlende Projektstammdaten.");
  }
  if (data.project.areas !== undefined && !Array.isArray(data.project.areas)) {
    throw new Error("Die Sicherung enthält keine gültige Liste der Karosseriebereiche.");
  }
  const projectAreas = data.project.areas || [];
  if (projectAreas.some((area) => !area || typeof area.id !== "string" || !area.id
      || area.id === UNASSIGNED_AREA_ID || typeof area.name !== "string" || !area.name.trim())) {
    throw new Error("Die Karosseriebereiche in der Sicherung benötigen eindeutige Kennungen und Namen.");
  }
  const areaIds = new Set(projectAreas.map((area) => area.id));
  if (areaIds.size !== projectAreas.length) throw new Error("Die Karosseriebereiche in der Sicherung haben doppelte Kennungen.");
  DEFAULT_AREAS.forEach((defaultArea) => {
    if (!areaIds.has(defaultArea.id)) {
      projectAreas.push({ ...defaultArea });
      areaIds.add(defaultArea.id);
    }
  });
  const areaNames = new Set();
  for (const area of projectAreas) {
    const normalizedName = area.name.trim().toLocaleLowerCase("de");
    if (areaNames.has(normalizedName)) throw new Error("Die Karosseriebereiche in der Sicherung haben doppelte Namen.");
    areaNames.add(normalizedName);
  }
  if (data.project.activeAreaId !== undefined && data.project.activeAreaId !== null
      && !areaIds.has(data.project.activeAreaId)) {
    throw new Error("Der ausgewählte Startbereich existiert in der Sicherung nicht.");
  }
  const idsByStore = {};
  for (const name of requiredArrays) {
    if (!Array.isArray(data[name])) throw new Error(`Die Sicherung enthält keine gültige Liste „${name}“.`);
    const ids = new Set();
    for (const record of data[name]) {
      if (!record || typeof record.id !== "string" || !record.id || ids.has(record.id)) {
        throw new Error(`Die Liste „${name}“ enthält einen Datensatz ohne eindeutige Kennung.`);
      }
      ids.add(record.id);
    }
    idsByStore[name] = ids;
  }
  for (const file of data.files) {
    if (typeof file.name !== "string" || !file.name || typeof file.documentId !== "string"
        || !Number.isInteger(file.version) || file.version < 1 || !Number.isInteger(file.size)
        || file.size < 0 || typeof file.contentBase64 !== "string"
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)
        || (file.partId && !idsByStore.parts.has(file.partId))
        || (file.areaId && !areaIds.has(file.areaId))) {
      throw new Error("Eine Dateiversion in der Sicherung ist unvollständig.");
    }
  }
  for (const part of data.parts) {
    if (typeof part.name !== "string" || !part.name
        || (part.stock !== null && (!Number.isInteger(part.stock) || part.stock < 0))
        || !Object.prototype.hasOwnProperty.call(STATUS_LABELS, part.status)
        || (part.areaId && !areaIds.has(part.areaId))) {
      throw new Error("Ein Teile-Datensatz enthält ungültige Kernwerte.");
    }
  }
  for (const print of data.prints) {
    if (!["planned", "printing", "complete"].includes(print.status)
        || (print.quantity !== null && (!Number.isInteger(print.quantity) || print.quantity < 1))
        || !Array.isArray(print.dependencies)
        || (print.partId !== null && !idsByStore.parts.has(print.partId))
        || (print.fileId && !idsByStore.files.has(print.fileId))
        || (print.areaId && !areaIds.has(print.areaId))
        || print.dependencies.some((id) => !idsByStore.prints.has(id))) {
      throw new Error("Ein Druckqueue-Datensatz enthält ungültige Werte oder Verweise.");
    }
  }
  const printById = new Map(data.prints.map((print) => [print.id, print]));
  const completed = new Set();
  const visiting = new Set();
  function checkDependencyCycle(id) {
    if (visiting.has(id)) throw new Error("Die Sicherung enthält einen Abhängigkeitskreis in der Druckqueue.");
    if (completed.has(id)) return;
    visiting.add(id);
    printById.get(id).dependencies.forEach(checkDependencyCycle);
    visiting.delete(id);
    completed.add(id);
  }
  data.prints.forEach((print) => checkDependencyCycle(print.id));
  for (const assembly of data.assemblies) {
    if (typeof assembly.name !== "string" || !assembly.name || !Array.isArray(assembly.partIds)
        || assembly.partIds.some((id) => !idsByStore.parts.has(id))) {
      throw new Error("Eine Baugruppe in der Sicherung enthält ungültige Teileverweise.");
    }
  }
  for (const entry of data.journal) {
    if (!idsByStore.prints.has(entry.printId) || typeof entry.qualityConfirmed !== "boolean"
        || !Number.isInteger(entry.producedQuantity) || entry.producedQuantity < 1
        || (entry.qualityConfirmed && entry.goodQuantity === null)
        || (!entry.qualityConfirmed && entry.goodQuantity !== null)
        || (entry.goodQuantity !== null
          && (!Number.isInteger(entry.goodQuantity) || entry.goodQuantity < 0 || entry.goodQuantity > entry.producedQuantity))
        || (entry.fileId && !idsByStore.files.has(entry.fileId))
        || (entry.partId !== null && !idsByStore.parts.has(entry.partId))) {
      throw new Error("Ein Druckjournaleintrag in der Sicherung enthält ungültige Werte oder Verweise.");
    }
  }
  if (data.changes.some((entry) => typeof entry.title !== "string" || !entry.title || typeof entry.at !== "string")) {
    throw new Error("Das Änderungsprotokoll in der Sicherung ist unvollständig.");
  }
}

async function importBackup(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`Die ausgewählte Datei ist kein lesbares JSON: ${error.message}`);
  }
  validateBackup(data);
  const confirmed = window.confirm("Diese Sicherung ersetzt alle lokalen Projekt-, Teile-, Druck-, Datei- und Verlaufsdaten. Vorhandene Daten vorher exportieren. Wirklich wiederherstellen?");
  if (!confirmed) return;
  const files = data.files.map((fileRecord) => {
    const { contentBase64, ...metadata } = fileRecord;
    const blob = base64ToBlob(contentBase64, fileRecord.mimeType);
    if (Number.isFinite(fileRecord.size) && fileRecord.size !== blob.size) {
      throw new Error(`Die Dateigröße stimmt bei ${fileRecord.name} V${fileRecord.version} nicht mit der Sicherung überein.`);
    }
    return { ...metadata, areaId: metadata.areaId || null, blob };
  });
  const areas = [...(data.project.areas || [])];
  DEFAULT_AREAS.forEach((defaultArea) => {
    if (!areas.some((area) => area.id === defaultArea.id)) areas.push({ ...defaultArea });
  });
  const project = {
    ...data.project,
    areas,
    activeAreaId: data.project.activeAreaId === null
      ? null
      : areas.some((area) => area.id === data.project.activeAreaId) ? data.project.activeAreaId : "front"
  };
  const records = {
    project: [project],
    parts: data.parts.map((part) => ({ ...part, areaId: part.areaId || null })),
    prints: data.prints.map((print) => ({ ...print, areaId: print.areaId || null })),
    assemblies: data.assemblies,
    files, journal: data.journal, changes: data.changes
  };
  await transaction(STORE_NAMES, "readwrite", (tx) => {
    STORE_NAMES.forEach((name) => tx.objectStore(name).clear());
    for (const storeName of STORE_NAMES) {
      for (const record of records[storeName]) tx.objectStore(storeName).put(record);
    }
    tx.objectStore("changes").put(changeRecord("Sicherung wiederhergestellt", `Importierte Sicherung vom ${data.exportedAt || "unbekannten Zeitpunkt"}`));
  });
  await refresh();
  showAlert("Sicherung validiert und vollständig wiederhergestellt.", true);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  $("new-part-button").addEventListener("click", () => setPartEditor(null));
  $("close-part-editor").addEventListener("click", closePartEditor);
  $("cancel-part-edit").addEventListener("click", closePartEditor);
  $("part-form").addEventListener("submit", (event) => runSafely(() => savePart(event)));
  $("part-search").addEventListener("input", renderParts);
  $("part-status-filter").addEventListener("change", renderParts);
  $("part-area-filter").addEventListener("change", renderParts);
  $("part-view-mode").addEventListener("change", renderParts);
  $("overview-area-open").addEventListener("click", () => runSafely(() => startArea($("overview-area-select").value)));
  $("area-start-button").addEventListener("click", () => runSafely(() => startArea($("area-start-select").value)));
  $("area-folder-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-area]");
    if (button) runSafely(() => startArea(button.dataset.openArea));
  });
  $("area-form").addEventListener("submit", (event) => runSafely(() => addArea(event)));
  $("area-work-items").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) navigate(button.dataset.view);
  });
  $("parts-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-part]");
    if (edit) setPartEditor(getPart(edit.dataset.editPart));
    const queue = event.target.closest("[data-queue-part]");
    if (queue) moveToQueue(queue.dataset.queuePart);
  });
  $("queue-form").addEventListener("submit", (event) => runSafely(() => addQueueItem(event)));
  $("queue-list").addEventListener("click", (event) => {
    const start = event.target.closest("[data-start-print]");
    const finish = event.target.closest("[data-finish-print]");
    const remove = event.target.closest("[data-remove-queue]");
    const saveQuantity = event.target.closest("[data-save-quantity]");
    const saveDependencies = event.target.closest("[data-save-dependencies]");
    const download = event.target.closest("[data-download-file]");
    if (start) runSafely(() => startPrint(start.dataset.startPrint));
    if (finish) runSafely(() => openJournalDialog(finish.dataset.finishPrint));
    if (remove) runSafely(() => removeQueueItem(remove.dataset.removeQueue));
    if (saveQuantity) runSafely(() => savePrintQuantity(saveQuantity.dataset.saveQuantity));
    if (saveDependencies) runSafely(() => savePrintDependencies(saveDependencies.dataset.saveDependencies));
    if (download) runSafely(() => downloadFile(download.dataset.downloadFile));
  });
  $("journal-form").addEventListener("submit", (event) => runSafely(() => finishPrint(event)));
  $("close-journal-dialog").addEventListener("click", () => $("journal-dialog").close());
  $("cancel-journal").addEventListener("click", () => $("journal-dialog").close());
  $("assembly-form").addEventListener("submit", (event) => runSafely(() => addAssembly(event)));
  $("file-form").addEventListener("submit", (event) => runSafely(() => addFileVersion(event)));
  $("files-list").addEventListener("click", (event) => {
    const download = event.target.closest("[data-download-file]");
    const savePart = event.target.closest("[data-save-file-part]");
    const saveArea = event.target.closest("[data-save-file-area]");
    if (download) runSafely(() => downloadFile(download.dataset.downloadFile));
    if (savePart) runSafely(() => saveFilePart(savePart.dataset.saveFilePart));
    if (saveArea) runSafely(() => saveFileArea(saveArea.dataset.saveFileArea));
  });
  $("cloud-auth-form").addEventListener("submit", (event) => runSafely(() => signInToCloud(event)));
  $("cloud-signup-button").addEventListener("click", () => runSafely(createCloudAccount));
  $("cloud-sync-button").addEventListener("click", () => runSafely(synchronizeNow));
  $("cloud-logout-button").addEventListener("click", () => runSafely(signOutFromCloud));
  $("export-button").addEventListener("click", () => runSafely(exportBackup));
  $("import-input").addEventListener("change", (event) => runSafely(async () => {
    const file = event.target.files[0];
    if (!file) return;
    $("import-filename").textContent = file.name;
    await importBackup(file);
    event.target.value = "";
  }));
  window.addEventListener("online", () => {
    if (cloudUser && getCloudMeta().dirty) scheduleCloudSync();
    else if (cloudUser) runSafely(checkCloudForUpdates);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && cloudUser) runSafely(checkCloudForUpdates);
  });
}

async function runSafely(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    showAlert(error.message || "Die Aktion ist fehlgeschlagen. Lokale Daten wurden nicht als gespeichert bestätigt.");
  }
}

async function startApp() {
  try {
    await openDatabase();
    await initializeData();
    await ensureProjectAreas();
    bindEvents();
    await refresh();
    const hashView = window.location.hash.slice(1);
    const savedView = localStorage.getItem(LAST_VIEW_KEY);
    navigate(VIEW_TITLES[hashView] ? hashView : VIEW_TITLES[savedView] ? savedView : "ueberblick");
    try {
      await initializeCloud();
    } catch (error) {
      updateCloudStatus(`Cloud-Sync nicht verfügbar: ${error.message}. Lokale Speicherung bleibt aktiv.`, "error");
    }
  } catch (error) {
    console.error(error);
    showAlert(`App konnte nicht initialisiert werden: ${error.message}`);
  }
}

document.addEventListener("DOMContentLoaded", startApp);
