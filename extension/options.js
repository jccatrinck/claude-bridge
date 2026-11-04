const $ = (id) => document.getElementById(id);
const FIELDS = ["profileName", "token", "port", "blockedSites", "uploadRoots"];
const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

async function load() {
  const s = await chrome.storage.local.get(null);
  $("profileName").value = s.profileName ?? "";
  $("token").value = s.token ?? "";
  $("port").value = s.port ?? 47811;
  $("blockedSites").value = (s.blockedSites ?? []).join("\n");
  $("uploadRoots").value = (s.uploadRoots ?? []).join("\n");
  $("profileId").textContent = s.profileId ?? "(created on first connect)";
}

function collect() {
  return {
    profileName: $("profileName").value.trim(),
    token: $("token").value.trim(),
    port: Number($("port").value) || 47811,
    blockedSites: lines($("blockedSites").value),
    uploadRoots: lines($("uploadRoots").value),
  };
}

function flashSaved(text = "Saved") {
  const el = $("saved");
  el.textContent = text;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2000);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set(collect());
  flashSaved();
});

$("reconnect").addEventListener("click", () => chrome.runtime.sendMessage({ type: "reconnect" }));

$("export").addEventListener("click", async () => {
  const s = await chrome.storage.local.get(FIELDS);
  const blob = new Blob([JSON.stringify({ claudeBridge: 1, ...s }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `claude-bridge-${s.profileName || "settings"}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async () => {
  const f = $("importFile").files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const next = {};
    for (const k of FIELDS) if (k in data) next[k] = data[k];
    if (next.blockedSites && !Array.isArray(next.blockedSites)) throw new Error("blockedSites must be a list");
    if (next.uploadRoots && !Array.isArray(next.uploadRoots)) throw new Error("uploadRoots must be a list");
    await chrome.storage.local.set(next);
    await load();
    flashSaved("Imported");
  } catch (e) {
    flashSaved(`Import failed: ${e.message}`);
  }
  $("importFile").value = "";
});

function showStatus(st) {
  const state = st?.state ?? "offline";
  $("dot").className = `dot ${state}`;
  $("state").textContent = state;
  $("detail").textContent = st?.detail ?? "";
}

chrome.storage.session.get("status").then(({ status }) => showStatus(status));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.status) showStatus(changes.status.newValue);
  if (area === "local" && changes.profileId) $("profileId").textContent = changes.profileId.newValue;
});

load();
