const YANDEX_URL_PATTERNS = [
  "*://music.yandex.ru/*",
  "*://music.yandex.by/*",
  "*://music.yandex.kz/*"
];

const DEFAULT_STATE = {
  serverHttpOrigin: "http://127.0.0.1:8099",
  sessionId: null,
  pairCode: null,
  isPaired: false,
  wsConnected: false,
  lastPairing: null,
  lastPlayerState: null
};

let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let wsUrl = null;

void initialize();

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize().then(connectWsIfNeeded);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isYandexMusicUrl(tab.url)) return;
  void requestPlayerState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "background/get-state":
        return getStateWithPlayerTab();

      case "background/update-server-origin": {
        const serverHttpOrigin = normalizeOrigin(message.serverHttpOrigin);
        await setState({ serverHttpOrigin });
        return { ok: true, serverHttpOrigin };
      }

      case "pairing/session-created": {
        const serverHttpOrigin = normalizeOrigin(message.serverHttpOrigin);
        const payload = message.payload;

        await setState({
          serverHttpOrigin,
          sessionId: payload.sessionId,
          pairCode: payload.pairCode,
          isPaired: false,
          lastPairing: payload
        });

        await connectWs(true);
        await requestPlayerState();
        return { ok: true };
      }

      case "popup/player-command": {
        const response = await forwardCommandToPlayer({
          action: message.action,
          payload: message.payload || {}
        });
        return { ok: true, response };
      }

      case "background/disconnect":
        disconnectWs();
        await setState({ wsConnected: false, isPaired: false });
        return { ok: true };

      case "background/ensure-player-tab":
        return ensurePlayerTab({ reload: Boolean(message.reload) });

      case "content/player-event": {
        await setState({ lastPlayerState: message.payload });
        const state = await getState();

        sendWs({
          type: "state/update",
          sessionId: state.sessionId,
          state: message.payload
        });

        return { ok: true };
      }

      case "content/command-result": {
        if (message.payload?.state) {
          await setState({ lastPlayerState: message.payload.state });
        }

        const state = await getState();

        sendWs({
          type: "command/result",
          sessionId: state.sessionId,
          requestId: message.payload?.requestId,
          ok: Boolean(message.payload?.ok),
          result: message.payload?.result ?? null,
          error: message.payload?.error ?? null,
          state: message.payload?.state ?? null
        });

        return { ok: true };
      }

      case "content/bridge-ready":
        await requestPlayerState();
        return { ok: true };

      default:
        return { ok: false, error: "Unknown message type" };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function initialize() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    if (current[key] === undefined) {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
}

async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  return {
    ...DEFAULT_STATE,
    ...stored,
    wsReadyState: ws?.readyState ?? null
  };
}

async function getStateWithPlayerTab() {
  const state = await getState();
  const playerTab = await checkPlayerTabStatus();
  return {
    ...state,
    playerTab
  };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

function normalizeOrigin(origin) {
  return String(origin || DEFAULT_STATE.serverHttpOrigin).trim().replace(/\/+$/, "");
}

function isYandexMusicUrl(url) {
  return /^https?:\/\/music\.yandex\.(ru|by|kz|ua)\//.test(String(url || ""));
}

function httpOriginToWsUrl(origin) {
  const url = new URL(normalizeOrigin(origin));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

async function getFirstYandexTab() {
  const tabs = await chrome.tabs.query({ url: YANDEX_URL_PATTERNS });
  return tabs[0] || null;
}

async function checkPlayerTabStatus() {
  const tab = await getFirstYandexTab();

  if (!tab?.id) {
    return {
      status: "missing",
      exists: false,
      ready: false,
      message: "Вкладка Яндекс Музыки не открыта"
    };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "PLAYER_REQUEST_STATE",
      requestId: crypto.randomUUID()
    });

    return {
      status: "ready",
      exists: true,
      ready: true,
      tabId: tab.id,
      url: tab.url || "",
      message: "Вкладка Яндекс Музыки подключена"
    };
  } catch {
    return {
      status: "needsReload",
      exists: true,
      ready: false,
      tabId: tab.id,
      url: tab.url || "",
      message: "Вкладку Яндекс Музыки нужно обновить"
    };
  }
}

async function ensurePlayerTab({ reload = false } = {}) {
  const tab = await getFirstYandexTab();

  if (!tab?.id) {
    const created = await chrome.tabs.create({ url: "https://music.yandex.ru/" });
    return {
      ok: true,
      action: "opened",
      tabId: created.id
    };
  }

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  await chrome.tabs.update(tab.id, { active: true });

  if (reload) {
    await chrome.tabs.reload(tab.id);
  }

  return {
    ok: true,
    action: reload ? "reloaded" : "focused",
    tabId: tab.id
  };
}

async function requestPlayerState() {
  const tab = await getFirstYandexTab();
  if (!tab?.id) return null;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "PLAYER_REQUEST_STATE",
      requestId: crypto.randomUUID()
    });
  } catch {
    return null;
  }

  return true;
}

async function forwardCommandToPlayer({ action, payload }) {
  const tab = await getFirstYandexTab();
  if (!tab?.id) {
    throw new Error("Не найдена открытая вкладка Яндекс Музыки");
  }

  return chrome.tabs.sendMessage(tab.id, {
    type: "PLAYER_COMMAND",
    action,
    payload,
    requestId: crypto.randomUUID()
  });
}

async function connectWsIfNeeded() {
  const state = await getState();
  if (!state.sessionId) return;
  await connectWs(false);
}

async function connectWs(force = false) {
  const state = await getState();
  if (!state.sessionId) return;

  const nextWsUrl = httpOriginToWsUrl(state.serverHttpOrigin);

  if (!force && ws && ws.readyState === WebSocket.OPEN && wsUrl === nextWsUrl) {
    return;
  }

  disconnectWs();
  wsUrl = nextWsUrl;
  ws = new WebSocket(nextWsUrl);

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    void setState({ wsConnected: true });

    sendWs({
      type: "hello",
      role: "extension",
      sessionId: state.sessionId,
      pairCode: state.pairCode,
      client: {
        extensionVersion: chrome.runtime.getManifest().version
      }
    });
  });

  ws.addEventListener("message", (event) => {
    const message = safeParseJson(event.data);
    if (!message) return;
    void handleServerMessage(message);
  });

ws.addEventListener("close", (event) => {
  const sessionMissing = event.code === 4404;

  void setState({
    wsConnected: false,
    isPaired: false,
    ...(sessionMissing
      ? {
          sessionId: null,
          pairCode: null,
          lastPairing: null
        }
      : {})
  });

  if (!sessionMissing) {
    scheduleReconnect();
  }
});

  ws.addEventListener("error", () => {
    void setState({ wsConnected: false });
  });
}

function disconnectWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectAttempt += 1;
  const delayMs = Math.min(30000, 1000 * 2 ** reconnectAttempt);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWs(false);
  }, delayMs);
}

async function handleServerMessage(message) {
  switch (message.type) {
    case "hello/ack":
      if (message.lastState) {
        await setState({ lastPlayerState: message.lastState });
      }
      await requestPlayerState();
      return;

    case "auth/paired":
      await setState({ isPaired: true });
      return;

    case "peer/disconnected":
      if (message.role === "phone") {
        await setState({ isPaired: false });
      }
      return;

    case "state/update":
      if (message.state) {
        await setState({ lastPlayerState: message.state });
      }
      return;

    case "command": {
      try {
        await forwardCommandToPlayer({
          action: message.action,
          payload: message.payload || {}
        });
      } catch (error) {
        sendWs({
          type: "command/result",
          requestId: message.requestId,
          sessionId: message.sessionId,
          ok: false,
          error: error.message
        });
      }
      return;
    }

    case "server/ping":
      sendWs({ type: "server/pong" });
      return;

    case "error":
      console.warn("[server:error]", message.code, message.message);
      return;

    default:
      return;
  }
}

function sendWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
