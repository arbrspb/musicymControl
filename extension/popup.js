const defaultServerOrigin = "http://127.0.0.1:8099";

const ui = {
  serverOrigin: document.getElementById("serverOrigin"),
  saveServer: document.getElementById("saveServer"),
  createSession: document.getElementById("createSession"),
  serverHealth: document.getElementById("serverHealth"),
  wsStatus: document.getElementById("wsStatus"),
  pairStatus: document.getElementById("pairStatus"),
  trackTitle: document.getElementById("trackTitle"),
  playerTabStatus: document.getElementById("playerTabStatus"),
  fixPlayerTab: document.getElementById("fixPlayerTab"),
  pairCode: document.getElementById("pairCode"),
  remoteUrl: document.getElementById("remoteUrl"),
  qrImage: document.getElementById("qrImage"),
  prevBtn: document.getElementById("prevBtn"),
  toggleBtn: document.getElementById("toggleBtn"),
  nextBtn: document.getElementById("nextBtn"),
  openControl: document.getElementById("openControl")
};

function normalizeOrigin(origin) {
  return String(origin || defaultServerOrigin).trim().replace(/\/+$/, "");
}

function formatTrack(state) {
  const track = state?.track;
  if (!track) return "Трек: —";

  const artists = (track.artists || [])
    .map((artist) => artist.name || artist.title)
    .join(", ");

  return `Трек: ${track.title}${artists ? " — " + artists : ""}`;
}

function renderPlayerTabStatus(playerTab) {
  const status = playerTab?.status || "missing";

  if (status === "ready") {
    ui.playerTabStatus.textContent = "Яндекс Музыка: вкладка подключена";
    ui.fixPlayerTab.textContent = "Обновить вкладку";
    ui.fixPlayerTab.dataset.action = "reload";
    return;
  }

  if (status === "needsReload") {
    ui.playerTabStatus.textContent =
      "Яндекс Музыка: вкладка открыта, но её нужно обновить после перезагрузки расширения";
    ui.fixPlayerTab.textContent = "Обновить вкладку";
    ui.fixPlayerTab.dataset.action = "reload";
    return;
  }

  ui.playerTabStatus.textContent = "Яндекс Музыка: вкладка не открыта";
  ui.fixPlayerTab.textContent = "Открыть Яндекс Музыку";
  ui.fixPlayerTab.dataset.action = "open";
}

async function getBackgroundState() {
  return chrome.runtime.sendMessage({ type: "background/get-state" });
}

async function render() {
  const state = await getBackgroundState();
  const serverOrigin = normalizeOrigin(state.serverHttpOrigin || defaultServerOrigin);

  ui.serverOrigin.value = serverOrigin;
  ui.wsStatus.textContent = `WS: ${state.wsConnected ? "подключён" : "отключён"}`;
  ui.pairStatus.textContent = `Pairing: ${state.isPaired ? "телефон подключён" : "ожидание"}`;
  ui.trackTitle.textContent = formatTrack(state.lastPlayerState);
  renderPlayerTabStatus(state.playerTab);

  const pairing = state.lastPairing;
  if (pairing?.pairCode) {
    ui.pairCode.textContent = pairing.pairCode;
    ui.remoteUrl.textContent = pairing.remoteUrl || "—";

    if (pairing.qrDataUrl) {
      ui.qrImage.src = pairing.qrDataUrl;
      ui.qrImage.hidden = false;
    }
  } else {
    ui.pairCode.textContent = "—";
    ui.remoteUrl.textContent = "—";
    ui.qrImage.hidden = true;
    ui.qrImage.removeAttribute("src");
  }

  await renderServerHealth(serverOrigin);
}

async function renderServerHealth(serverOrigin) {
  try {
    const response = await fetch(`${serverOrigin}/api/health`);
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    ui.serverHealth.textContent =
      `Сервер доступен. Public origin: ${data.publicHttpOrigin}`;
  } catch (error) {
    ui.serverHealth.textContent = `Сервер недоступен: ${error.message}`;
  }
}

async function saveServerOrigin() {
  const serverHttpOrigin = normalizeOrigin(ui.serverOrigin.value || defaultServerOrigin);

  await chrome.runtime.sendMessage({
    type: "background/update-server-origin",
    serverHttpOrigin
  });

  await render();
}

async function createPairingSession() {
  const serverHttpOrigin = normalizeOrigin(ui.serverOrigin.value || defaultServerOrigin);

  ui.serverHealth.textContent = "Создаю pairing-сессию…";

  const response = await fetch(`${serverHttpOrigin}/api/pairing/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source: "chrome-extension",
      extensionVersion: chrome.runtime.getManifest().version
    })
  });

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  await chrome.runtime.sendMessage({
    type: "pairing/session-created",
    serverHttpOrigin,
    payload
  });

  await render();
}

async function sendPlayerCommand(action, payload = {}) {
  await chrome.runtime.sendMessage({
    type: "popup/player-command",
    action,
    payload
  });

  setTimeout(() => {
    void render();
  }, 300);
}

async function fixPlayerTab() {
  const reload = ui.fixPlayerTab.dataset.action === "reload";

  ui.playerTabStatus.textContent = reload
    ? "Обновляю вкладку Яндекс Музыки…"
    : "Открываю Яндекс Музыку…";

  await chrome.runtime.sendMessage({
    type: "background/ensure-player-tab",
    reload
  });

  setTimeout(() => {
    void render();
  }, reload ? 1200 : 600);
}

function openControlPanel() {
  chrome.windows.create({
    url: chrome.runtime.getURL("control.html"),
    type: "popup",
    width: 460,
    height: 720
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  ui.saveServer.addEventListener("click", () => {
    void saveServerOrigin();
  });

  ui.createSession.addEventListener("click", () => {
    void createPairingSession().catch((error) => {
      ui.serverHealth.textContent = `Ошибка pairing: ${error.message}`;
    });
  });

  ui.prevBtn.addEventListener("click", () => void sendPlayerCommand("prev"));
  ui.toggleBtn.addEventListener("click", () => void sendPlayerCommand("playPause"));
  ui.nextBtn.addEventListener("click", () => void sendPlayerCommand("next"));
  ui.openControl.addEventListener("click", (event) => {
    event.preventDefault();
    openControlPanel();
  });
  ui.fixPlayerTab.addEventListener("click", () => {
    void fixPlayerTab().catch((error) => {
      ui.playerTabStatus.textContent = `Ошибка вкладки: ${error.message}`;
    });
  });

  chrome.storage.onChanged.addListener(() => {
    void render();
  });

  await render();
});
