const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { createPairCode, buildRemoteUrl, createQrDataUrl } = require("./qr_utils");
const { execFileSync } = require("node:child_process");
const LAN_ADDRESS = getLanAddress();

const CONFIG = {
  HOST: process.env.HOST || "0.0.0.0",
  PORT: Number(process.env.PORT || 8099),
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000),
  HEARTBEAT_MS: Number(process.env.HEARTBEAT_MS || 20 * 1000),
  PUBLIC_HTTP_ORIGIN: process.env.PUBLIC_HTTP_ORIGIN || "",
  DEBUG: process.env.DEBUG === "1" || process.env.DEBUG === "true",
  DEBUG_CONSOLE: process.env.DEBUG_CONSOLE === "1" || process.env.DEBUG_CONSOLE === "true"
};


const sessions = new Map();


const appDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const logFile = path.join(appDir, "server.log");

function log(message) {
  if (!CONFIG.DEBUG) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;

  if (CONFIG.DEBUG_CONSOLE) {
    console.log(line.trim());
  }

  try {
    fs.appendFileSync(logFile, line);
  } catch (e) {
    console.error("Log write failed:", e);
  }
}


function normalizeOrigin(origin) {
  return String(origin || "").replace(/\/+$/, "");
}

function getLanAddress() {
  const windowsAddress = getWindowsPhysicalLanAddress();
  if (windowsAddress) return windowsAddress;

  const networks = os.networkInterfaces();
  const vpnLike = /(vpn|tap|tun|wireguard|tailscale|zerotier|openvpn|wintun|hyper-v|virtual|vmware|vbox)/i;
  const candidates = [];

  for (const [name, entries] of Object.entries(networks)) {
    if (vpnLike.test(name)) continue;

    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      candidates.push(entry.address);
    }
  }

  return (
    candidates.find((address) => address.startsWith("192.168.")) ||
    candidates.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) ||
    candidates.find((address) => address.startsWith("10.")) ||
    "127.0.0.1"
  );
}

function getWindowsPhysicalLanAddress() {
  if (process.platform !== "win32") return null;

  const script = `
    $config = Get-NetIPConfiguration |
      Where-Object {
        $_.IPv4Address.IPAddress -and
        $_.IPv4DefaultGateway.NextHop -and
        $_.NetAdapter.Status -eq "Up" -and
        $_.NetAdapter.HardwareInterface
      } |
      Sort-Object { $_.NetIPv4Interface.InterfaceMetric } |
      Select-Object -First 1

    if ($config) {
      $config.IPv4Address |
        Select-Object -First 1 -ExpandProperty IPAddress
    }
  `;

  try {
    const address = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 2000 }
    ).trim();

    return address || null;
  } catch {
    return null;
  }
}


function httpToWsOrigin(httpOrigin) {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

function getServerOrigins() {
  const localHttpOrigin = `http://127.0.0.1:${CONFIG.PORT}`;
  const publicHttpOrigin = normalizeOrigin(
    CONFIG.PUBLIC_HTTP_ORIGIN || `http://${LAN_ADDRESS}:${CONFIG.PORT}`
  );

  return {
    localHttpOrigin,
    publicHttpOrigin,
    publicWsOrigin: httpToWsOrigin(publicHttpOrigin)
  };
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  applyCors(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  applyCors(res);
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isExpired(session) {
  return session.expiresAt <= Date.now();
}

function touchSession(session) {
  session.updatedAt = Date.now();
  session.expiresAt = Date.now() + CONFIG.SESSION_TTL_MS;
}

function createSession(meta = {}) {
  const session = {
    sessionId: crypto.randomUUID(),
    pairCode: createPairCode(8),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + CONFIG.SESSION_TTL_MS,
    meta,
    extension: null,
    phone: null,
    lastState: null
  };

  sessions.set(session.sessionId, session);
  log(`New session created: ${session.sessionId}, pairCode: ${session.pairCode}`);
  return session;
}

function getSessionByPairCode(pairCode) {
  for (const session of sessions.values()) {
    if (session.pairCode === pairCode) return session;
  }
  return null;
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    pairCode: session.pairCode,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    connected: {
      extension: Boolean(session.extension),
      phone: Boolean(session.phone)
    }
  };
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function sendError(ws, code, message) {
  safeSend(ws, { type: "error", code, message });
}

function bindSocket(session, role, ws) {
  const previousSocket = session[role];
  if (previousSocket && previousSocket !== ws) {
    try {
      previousSocket.close(4000, "Replaced by a new connection");
    } catch {}
  }

  session[role] = ws;
  log(`Socket bound: role=${role}, sessionId=${session.sessionId}`);
  ws.sessionId = session.sessionId;
  ws.role = role;
  ws.isAlive = true;
  touchSession(session);
}

function clearSocket(ws) {
  const sessionId = ws.sessionId;
  const role = ws.role;
  if (!sessionId || !role) return;

  const session = sessions.get(sessionId);
  if (!session) return;

  if (session[role] === ws) {
    session[role] = null;
    log(`Socket cleared: role=${role}, sessionId=${sessionId}`);
  }

  const peerRole = role === "extension" ? "phone" : "extension";

  safeSend(session[peerRole], {
    type: "peer/disconnected",
    sessionId,
    role,
    at: new Date().toISOString()
  });

  if (!session.extension && !session.phone && isExpired(session)) {
    sessions.delete(sessionId);
    log(`Session deleted due to expiration: ${sessionId}`);
  }
}

function socketSession(ws) {
  if (!ws.sessionId) return null;
  return sessions.get(ws.sessionId) || null;
}

function handleHello(ws, message) {
  log(`handleHello from ${message.role}: sessionId=${message.sessionId || 'new session'}`);

  if (message.role !== "extension" && message.role !== "phone") {
    sendError(ws, "INVALID_ROLE", "role must be extension or phone");
    return;
  }

  let session = null;

  if (message.role === "extension") {
    session = sessions.get(message.sessionId);

    if (!session || isExpired(session)) {
      sendError(ws, "SESSION_NOT_FOUND", "Pairing session not found or expired");
      ws.close(4404, "Session not found");
      return;
    }

    if (message.pairCode && message.pairCode !== session.pairCode) {
      sendError(ws, "PAIR_CODE_MISMATCH", "pairCode does not match session");
      ws.close(4401, "Pair code mismatch");
      return;
    }

    bindSocket(session, "extension", ws);

    safeSend(ws, {
      type: "hello/ack",
      role: "extension",
      session: publicSession(session),
      lastState: session.lastState
    });

    if (session.phone) {
      safeSend(ws, {
        type: "auth/paired",
        sessionId: session.sessionId,
        pairCode: session.pairCode
      });
    }

    return;
  }

  session = message.sessionId
    ? sessions.get(message.sessionId)
    : getSessionByPairCode(message.pairCode);

  if (!session || isExpired(session)) {
    sendError(ws, "PAIRING_NOT_FOUND", "Pairing session not found or expired");
    ws.close(4404, "Pairing not found");
    return;
  }

  if (message.pairCode && message.pairCode !== session.pairCode) {
    sendError(ws, "PAIR_CODE_MISMATCH", "pairCode does not match session");
    ws.close(4401, "Pair code mismatch");
    return;
  }

  bindSocket(session, "phone", ws);

  safeSend(ws, {
    type: "hello/ack",
    role: "phone",
    session: publicSession(session),
    lastState: session.lastState
  });

  safeSend(ws, {
    type: "auth/paired",
    sessionId: session.sessionId,
    pairCode: session.pairCode
  });

  safeSend(session.extension, {
    type: "auth/paired",
    sessionId: session.sessionId,
    pairCode: session.pairCode
  });

  if (session.lastState) {
    safeSend(ws, {
      type: "state/update",
      sessionId: session.sessionId,
      state: session.lastState
    });
  }
}

function handleCommand(ws, message) {
  log(`handleCommand from ${ws.role}: action=${message.action}, payload=${JSON.stringify(message.payload)}`);  
  if (ws.role !== "phone") {
    sendError(ws, "FORBIDDEN", "Only phone clients can send commands");
    return;
  }

  const session = socketSession(ws);
  if (!session) {
    sendError(ws, "SESSION_NOT_FOUND", "Session is not attached to this socket");
    return;
  }

  touchSession(session);

  if (!session.extension) {
    sendError(ws, "EXTENSION_OFFLINE", "Desktop extension is offline");
    return;
  }

  safeSend(session.extension, {
    type: "command",
    sessionId: session.sessionId,
    requestId: message.requestId || crypto.randomUUID(),
    action: message.action,
    payload: message.payload || {},
    sentAt: new Date().toISOString()
  });
}

function handleStateUpdate(ws, message) {
  log(`handleStateUpdate from ${ws.role}: event=${message.state?.event || "unknown"}`); 
  if (ws.role !== "extension") {
    sendError(ws, "FORBIDDEN", "Only extension clients can push state");
    return;
  }

  const session = socketSession(ws);
  if (!session) {
    sendError(ws, "SESSION_NOT_FOUND", "Session is not attached to this socket");
    return;
  }

  touchSession(session);

  session.lastState = {
    ...message.state,
    updatedAt: new Date().toISOString()
  };

  safeSend(session.phone, {
    type: "state/update",
    sessionId: session.sessionId,
    state: session.lastState
  });
}

function handleCommandResult(ws, message) {
  log(`handleCommandResult from ${ws.role}: ok=${message.ok}, requestId=${message.requestId}`);
  if (ws.role !== "extension") {
    sendError(ws, "FORBIDDEN", "Only extension clients can push command results");
    return;
  }

  const session = socketSession(ws);
  if (!session) {
    sendError(ws, "SESSION_NOT_FOUND", "Session is not attached to this socket");
    return;
  }

  touchSession(session);

  safeSend(session.phone, {
    type: "command/result",
    sessionId: session.sessionId,
    requestId: message.requestId,
    ok: Boolean(message.ok),
    result: message.result ?? null,
    error: message.error || null,
    state: message.state || null
  });
}

function handleWsMessage(ws, message) {
  //log(`Unknown message type from ${ws.role}: ${message.type}`);  
  switch (message.type) {
    case "hello":
      handleHello(ws, message);
      return;
    case "command":
      handleCommand(ws, message);
      return;
    case "state/update":
      handleStateUpdate(ws, message);
      return;
    case "command/result":
      handleCommandResult(ws, message);
      return;
    case "server/pong": {
      const session = socketSession(ws);
      if (session) touchSession(session);
      return;
    }
    default:
      sendError(ws, "UNKNOWN_MESSAGE", `Unknown message type: ${message.type}`);
  }
}

function cleanupSessions() {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.extension || session.phone) continue;
    if (!isExpired(session)) continue;
    sessions.delete(sessionId);
  }
}

function renderRemoteHtml({ publicWsOrigin, pairCode = "", sessionId = "" }) {
  const bootstrapJson = JSON.stringify({
    wsOrigin: publicWsOrigin,
    pairCode,
    sessionId
  });

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MusicYM Control</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #111827; color: #f9fafb; }
    main { max-width: 720px; margin: 0 auto; padding: 20px; }
    .card { background: #1f2937; border-radius: 16px; padding: 16px; margin-bottom: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    button { flex: 1 1 30%; min-height: 56px; border: 0; border-radius: 14px; font-size: 18px; font-weight: 600; background: #2563eb; color: white; transition: background-color .15s ease, color .15s ease; -webkit-appearance: none; -moz-appearance: none; appearance: none; outline: none; -webkit-tap-highlight-color: transparent; display: inline-flex; align-items: center; justify-content: center; }
    button.secondary { background: #374151; }
    button.favorite { display: inline-flex; align-items: center; justify-content: center; font-size: 0; line-height: 1; }
    .icon-sprite { display: none; }
    .control-icon { width: 30px; height: 30px; display: block; fill: currentColor; color: white; }
    button.favorite.is-liked .control-icon { color: #ef4444; }
    button.is-disliked .control-icon { color: #9ca3af; }
    button:disabled, button.is-disabled { opacity: .45; cursor: not-allowed; }
    button:active, button.secondary:active, button.favorite:active { filter: brightness(.85); }
    .status { font-size: 14px; opacity: .85; }
    .track { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    .meta { font-size: 14px; opacity: .8; }
    .time-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }
    details.card > summary { cursor: pointer; list-style: none; font-weight: 700; }
    details.card > summary::-webkit-details-marker { display: none; }
    details.card > summary::after { content: "⌄"; float: right; opacity: .75; }
    details.card[open] > summary::after { content: "⌃"; }
    .queue-list { display: grid; gap: 8px; margin-top: 12px; }
    .vibe-list { display: grid; gap: 8px; margin-top: 12px; }
    .vibe-preset { width: 100%; min-height: 52px; flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: #111827; color: #f9fafb; text-align: left; }
    .vibe-preset:active { background: #2563eb; }
    .vibe-preset.is-active { outline: 2px solid #facc15; color: #facc15; }
    .vibe-preset.is-accent { color: #facc15; }
    .vibe-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 700; }
    .vibe-mark { font-size: 12px; opacity: .8; }

    .queue-track { width: 100%; min-height: 58px; flex: 0 0 auto; display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; background: #111827; color: #f9fafb; text-align: left; }
    .queue-track:active { background: #2563eb; }
    .queue-cover { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: #374151; }
    .queue-info { min-width: 0; }
    .queue-title, .queue-artists { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-title { font-size: 15px; font-weight: 700; }
    .queue-artists { font-size: 13px; opacity: .75; }
    .queue-side { display: grid; justify-items: end; gap: 3px; font-size: 12px; font-variant-numeric: tabular-nums; }
    .queue-like { color: #9ca3af; font-size: 18px; line-height: 1; }
    .empty { margin-top: 12px; color: #9ca3af; font-size: 14px; }
    input[type=range] { width: 100%; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; padding: 12px; border-radius: 12px; }
  </style>
</head>
<body>
  <svg class="icon-sprite" aria-hidden="true" focusable="false">
    <symbol id="icon-skip-previous" viewBox="0 0 24 24"><path d="M6 5h2v14H6V5zm3 7 9 7V5l-9 7z"/></symbol>
    <symbol id="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z"/></symbol>
    <symbol id="icon-pause" viewBox="0 0 24 24"><path d="M7 5h4v14H7V5zm6 0h4v14h-4V5z"/></symbol>
    <symbol id="icon-skip-next" viewBox="0 0 24 24"><path d="M16 5h2v14h-2V5zM6 5v14l9-7-9-7z"/></symbol>
    <symbol id="icon-heart-border" viewBox="0 0 24 24"><path d="m12 21.35-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.53L12 21.35zM7.5 5C5.53 5 4 6.53 4 8.5c0 2.91 2.88 5.54 7.9 10.1l.1.1.1-.1C17.12 14.04 20 11.41 20 8.5 20 6.53 18.47 5 16.5 5c-1.52 0-3.01.96-3.56 2.36h-1.87C10.51 5.96 9.02 5 7.5 5z"/></symbol>
    <symbol id="icon-heart" viewBox="0 0 24 24"><path d="m12 21.35-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.53L12 21.35z"/></symbol>
    <symbol id="icon-thumb-down" viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></symbol>
    <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h8V3l-3.35 3.35z"/></symbol>
  </svg>
  <main>
    <section class="card">
      <div class="track" id="track">Ожидание подключения…</div>
      <div class="meta" id="artist">Откройте QR из popup расширения и дождитесь pairing.</div>
      <div class="status" id="status">Состояние: инициализация</div>
    </section>

    <section class="card">
      <div class="row">
        <button class="secondary" id="prev"><svg class="control-icon" aria-hidden="true"><use href="#icon-skip-previous"></use></svg></button>
        <button class="secondary" id="toggle" aria-label="Play"><svg class="control-icon" aria-hidden="true"><use href="#icon-play"></use></svg></button>
        <button class="secondary" id="next"><svg class="control-icon" aria-hidden="true"><use href="#icon-skip-next"></use></svg></button>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="secondary favorite" id="like" aria-pressed="false"><svg class="control-icon" aria-hidden="true"><use href="#icon-heart-border"></use></svg></button>
        <button class="secondary" id="dislike"><svg class="control-icon" aria-hidden="true"><use href="#icon-thumb-down"></use></svg></button>
        <button class="secondary" id="refresh"><svg class="control-icon" aria-hidden="true"><use href="#icon-refresh"></use></svg></button>
      </div>
    </section>

    <section class="card">
      <label for="position">Позиция</label>
      <div class="time-row">
        <span id="positionCurrent">0:00</span>
        <span id="positionDuration">0:00</span>
      </div>
      <input id="position" type="range" min="0" max="0" step="0.1" value="0" disabled />
    </section>

    <section class="card">
      <label for="volume">Громкость</label>
      <input id="volume" type="range" min="0" max="100" value="50" />
    </section>

    <details class="card queue-card" open>
      <summary>Следующие треки <span class="status" id="queueCount"></span></summary>
      <div class="queue-list" id="queueList"></div>
    </details>
       
    <details class="card vibe-card">
      <summary>Моя волна <span class="status" id="vibeCurrent"></span></summary>
      <div class="vibe-list" id="vibeList"></div>
    </details>

    <details class="card">
      <summary>Pair code: <strong id="pairCode"></strong></summary>
      <pre id="debug"></pre>
    </details>
  </main>

  <script>
    (() => {
      const bootstrap = ${bootstrapJson};
      const statusEl = document.getElementById("status");
      const trackEl = document.getElementById("track");
      const artistEl = document.getElementById("artist");
      const debugEl = document.getElementById("debug");
      const pairCodeEl = document.getElementById("pairCode");
      const volumeEl = document.getElementById("volume");
      const positionEl = document.getElementById("position");
      const positionCurrentEl = document.getElementById("positionCurrent");
      const positionDurationEl = document.getElementById("positionDuration");
      const toggleEl = document.getElementById("toggle");
      const nextEl = document.getElementById("next");
      const likeEl = document.getElementById("like");
      const dislikeEl = document.getElementById("dislike");
      const queueListEl = document.getElementById("queueList");
      const queueCountEl = document.getElementById("queueCount");
      const vibeListEl = document.getElementById("vibeList");
      const vibeCurrentEl = document.getElementById("vibeCurrent");


      let socket = null;
      let reconnectTimer = null;
      let requestStateAfterConnect = false;
      let isSeeking = false;
      let lastSeekKey = "";
      let lastSeekAt = 0;
      let isChangingVolume = false;
      let isVolumeDragAllowed = false;
      let lastVolumeUiValue = "50";
      let lastVolumeKey = "";
      let lastVolumeAt = 0;
      let volumeHoldUntil = 0;

      function requestId() {
        return self.crypto?.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(16).slice(2);
      }

      function setStatus(text) {
        statusEl.textContent = "Состояние: " + text;
      }

      function setDebug(value) {
        debugEl.textContent = JSON.stringify(value, null, 2);
      }

      function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
      }

      function formatTime(value) {
        if (!Number.isFinite(value) || value < 0) return "0:00";

        const totalSeconds = Math.floor(value);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = String(totalSeconds % 60).padStart(2, "0");

        if (hours > 0) {
          return hours + ":" + String(minutes).padStart(2, "0") + ":" + seconds;
        }

        return minutes + ":" + seconds;
      }

      function setLikeState(liked) {
        const likeIconUse = likeEl.querySelector("use");
        likeEl.classList.toggle("is-liked", liked);
        likeEl.setAttribute("aria-pressed", String(liked));
        if (likeIconUse) likeIconUse.setAttribute("href", liked ? "#icon-heart" : "#icon-heart-border");
      }

      function applyReactions(track) {
        const liked = Boolean(track?.liked);
        const disliked = Boolean(track?.disliked);

        setLikeState(liked);
        dislikeEl.classList.toggle("is-disliked", disliked);
        dislikeEl.setAttribute("aria-pressed", String(disliked));
      }

      function getCoverUrl(cover) {
        const value = String(cover || "").trim();
        if (!value) return "";

        const sized = value.replace("%%", "100x100");
        const lower = sized.toLowerCase();
        if (lower.indexOf("http://") === 0 || lower.indexOf("https://") === 0) return sized;
        if (sized.indexOf("//") === 0) return "https:" + sized;
        return "https://" + sized;
      }

      function getArtistsText(track) {
        if (!Array.isArray(track?.artists)) return "—";
        return track.artists.join(", ") || "—";
      }

      function renderVibe(vibe) {
        const presets = Array.isArray(vibe?.presets) ? vibe.presets : [];
        const selectedId = vibe?.currentId || "";

        vibeListEl.textContent = "";
        vibeCurrentEl.textContent = vibe?.title ? "— " + vibe.title : "";

        if (presets.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Варианты пока не загружены";
          vibeListEl.appendChild(empty);
          return;
        }

        for (const preset of presets) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "vibe-preset";

          const isActive =
            preset.id === selectedId &&
            preset.style !== "CONTROL_ACCENT";
          const isAccent = preset.style === "CONTROL_ACCENT";

          item.classList.toggle("is-active", isActive);
          item.classList.toggle("is-accent", isAccent);

          const title = document.createElement("div");
          title.className = "vibe-title";
          title.textContent = preset.title || "Без названия";

          const mark = document.createElement("div");
          mark.className = "vibe-mark";
          mark.textContent = isActive ? "Выбрано" : "";

          item.appendChild(title);
          item.appendChild(mark);

          item.addEventListener("click", () => {
            sendCommand("selectVibePreset", { id: preset.id });
          });

          vibeListEl.appendChild(item);
        }
      }


      function renderQueue(tracks) {
        const list = Array.isArray(tracks) ? tracks : [];
        queueListEl.textContent = "";
        queueCountEl.textContent = list.length ? "(" + list.length + ")" : "";

        if (list.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Следующие треки пока не получены";
          queueListEl.appendChild(empty);
          return;
        }

        for (const track of list) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "queue-track";
          item.dataset.index = String(track.index);

          const coverUrl = getCoverUrl(track.cover);
          const cover = document.createElement(coverUrl ? "img" : "div");
          cover.className = "queue-cover";
          if (coverUrl) {
            cover.alt = "";
            cover.loading = "lazy";
            cover.src = coverUrl;
          }

          const info = document.createElement("div");
          info.className = "queue-info";

          const title = document.createElement("div");
          title.className = "queue-title";
          title.textContent = track.title || "Без названия";

          const artists = document.createElement("div");
          artists.className = "queue-artists";
          artists.textContent = getArtistsText(track);

          const side = document.createElement("div");
          side.className = "queue-side";

          const like = document.createElement("div");
          like.className = "queue-like";
          like.textContent = track.liked ? "\u2665" : "";

          const duration = document.createElement("div");
          duration.textContent = formatTime(Number(track.duration) || 0);

          info.appendChild(title);
          info.appendChild(artists);
          side.appendChild(like);
          side.appendChild(duration);
          item.appendChild(cover);
          item.appendChild(info);
          item.appendChild(side);
          item.addEventListener("click", () => {
            sendCommand("playIndex", { index: Number(item.dataset.index) });
          });

          queueListEl.appendChild(item);
        }
      }

      function send(message) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(message));
      }

      function sendCommand(action, payload = {}) {
        send({
          type: "command",
          requestId: requestId(),
          action,
          payload
        });
      }
      
      function isSocketOpen() {
        return socket && socket.readyState === WebSocket.OPEN;
      }

      function isSocketConnecting() {
        return socket && socket.readyState === WebSocket.CONNECTING;
      }

      function scheduleReconnect(delayMs = 2000) {
        if (reconnectTimer) return;

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delayMs);
      }

      function reconnectNow({ requestState = false } = {}) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        if (isSocketOpen()) {
          if (requestState) {
            sendCommand("requestState");
          }
          return;
        }

        if (requestState) {
          requestStateAfterConnect = true;
        }

        if (isSocketConnecting()) {
          return;
        }

        connect();
      }

      function refreshFromPhone() {
        if (!isSocketOpen()) {
          setStatus("переподключение по кнопке");
        }

        reconnectNow({ requestState: true });
      }
            

      function applyProgress(progress) {
        const duration = Number(progress?.duration) || 0;
        const position = clamp(Number(progress?.position) || 0, 0, duration);

        positionEl.disabled = duration <= 0;
        positionEl.max = String(duration);

        if (!isSeeking) {
          positionEl.value = String(position);
          positionCurrentEl.textContent = formatTime(position);
        }

        positionDurationEl.textContent = formatTime(duration);
      }

      function applyVolume(volume) {
        if (isChangingVolume || Date.now() < volumeHoldUntil) return;
        if (typeof volume !== "number" || !Number.isFinite(volume)) return;

        lastVolumeUiValue = String(Math.round(clamp(volume, 0, 1) * 100));
        volumeEl.value = lastVolumeUiValue;
      }

      function applyPlaybackState(state) {
        const isPlaying = Boolean(state?.isPlaying);
        const toggleIconUse = toggleEl.querySelector("use");
        if (toggleIconUse) toggleIconUse.setAttribute("href", isPlaying ? "#icon-pause" : "#icon-play");
        toggleEl.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
        toggleEl.setAttribute("aria-pressed", String(isPlaying));
      }

      function hasReadyNext(state) {
        return (
          Boolean(state?.nextTrack) ||
          Boolean(state?.controls?.next) ||
          (Array.isArray(state?.upcomingTracks) && state.upcomingTracks.length > 0)
        );
      }

      function applyNavigationState(state) {
        const nextReady = hasReadyNext(state);
        nextEl.classList.toggle("is-disabled", !nextReady);
        nextEl.setAttribute("aria-disabled", String(!nextReady));
        nextEl.title = nextReady ? "" : "Следующие треки еще не подгрузились";
      }

      function commitPosition() {
        const duration = Number(positionEl.max) || 0;
        if (duration <= 0) return;

        const value = clamp(Number(positionEl.value) || 0, 0, duration);
        const seekKey = String(duration) + ":" + String(value);
        const now = Date.now();

        if (seekKey === lastSeekKey && now - lastSeekAt < 300) return;

        lastSeekKey = seekKey;
        lastSeekAt = now;

        positionEl.value = String(value);
        positionCurrentEl.textContent = formatTime(value);
        sendCommand("setPosition", { value });
      }

      function commitVolume(options = {}) {
        const force = Boolean(options.force);
        const value = clamp(Number(volumeEl.value) || 0, 0, 100);
        const volumeKey = String(value);
        const now = Date.now();

        if (!force && now - lastVolumeAt < 150) return;
        if (!force && volumeKey === lastVolumeKey && now - lastVolumeAt < 500) return;

        lastVolumeKey = volumeKey;
        lastVolumeAt = now;
        volumeHoldUntil = now + 1000;

        volumeEl.value = String(value);
        lastVolumeUiValue = String(value);
        sendCommand("setVolume", { value: value / 100 });
      }

      function isPointerOnRangeThumb(input, event) {
        const rect = input.getBoundingClientRect();
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        const value = clamp(Number(input.value) || min, min, max);
        const ratio = max > min ? (value - min) / (max - min) : 0;
        const thumbX = rect.left + rect.width * ratio;
        const thumbY = rect.top + rect.height / 2;
        const hitRadius = Math.max(26, rect.height);

        return (
          Math.abs(event.clientX - thumbX) <= hitRadius &&
          Math.abs(event.clientY - thumbY) <= hitRadius
        );
      }

      function cancelVolumeDrag() {
        isVolumeDragAllowed = false;
        isChangingVolume = false;
        volumeEl.value = lastVolumeUiValue;
      }

      function applyState(state) {
        const track = state?.track || null;
        trackEl.textContent = track ? track.title : "Нет данных о треке";
        artistEl.textContent =
          track?.artists?.map((artist) => artist.name || artist.title).join(", ") || "—";

        applyVolume(state?.volume);
        applyPlaybackState(state);
        applyNavigationState(state);

        applyReactions(track);
        applyProgress(state?.progress);
        renderVibe(state?.vibe);
        renderQueue(state?.upcomingTracks);
        setDebug(state || { info: "Состояние ещё не получено" });
      }

      function connect() {
        if (isSocketOpen() || isSocketConnecting()) return;

        setStatus("подключение к серверу");
        socket = new WebSocket(bootstrap.wsOrigin + "/ws");

        socket.addEventListener("open", () => {
          setStatus("ожидание pairing");
          send({
            type: "hello",
            role: "phone",
            sessionId: bootstrap.sessionId,
            pairCode: bootstrap.pairCode,
            client: { userAgent: navigator.userAgent }
          });
        });

        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case "hello/ack":
              setStatus("WS подключён");
              pairCodeEl.textContent = message.session?.pairCode || bootstrap.pairCode || "—";
              if (message.lastState) applyState(message.lastState);

              if (requestStateAfterConnect) {
                requestStateAfterConnect = false;
                sendCommand("requestState");
              }

              break;
            case "auth/paired":
              setStatus("сопряжение выполнено");
              pairCodeEl.textContent = message.pairCode || bootstrap.pairCode || "—";
              break;

            case "state/update":
              applyState(message.state);
              break;

            case "command/result":
              if (!message.ok) {
                setStatus("ошибка команды: " + (message.error || "unknown"));
              }
              if (message.state) applyState(message.state);
              break;

            case "server/ping":
              send({ type: "server/pong" });
              break;

            case "peer/disconnected":
              if (message.role === "extension") {
                setStatus("расширение отключилось");
              }
              break;

            case "error":
              setStatus("ошибка: " + message.message);
              break;

            default:
              break;
          }
        });

        socket.addEventListener("close", () => {
          setStatus("соединение закрыто, переподключение через 2с");
          scheduleReconnect();
        });

        socket.addEventListener("error", () => {
          setStatus("ошибка сокета");
        });
      }
      
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          reconnectNow({ requestState: true });
        }
      });

      window.addEventListener("pageshow", () => {
        reconnectNow({ requestState: true });
      });

      window.addEventListener("online", () => {
        reconnectNow({ requestState: true });
      });


      document.getElementById("prev").addEventListener("click", () => sendCommand("prev"));
      toggleEl.addEventListener("click", () => sendCommand("playPause"));
      nextEl.addEventListener("click", () => {
        if (nextEl.classList.contains("is-disabled")) {
          sendCommand("requestState");
          return;
        }

        sendCommand("next");
      });
      likeEl.addEventListener("click", () => {
        setLikeState(!likeEl.classList.contains("is-liked"));
        sendCommand("like");
      });
      dislikeEl.addEventListener("click", () => {
        setLikeState(false);
        sendCommand("dislike");
      });
      document.getElementById("refresh").addEventListener("click", () => refreshFromPhone());

      volumeEl.addEventListener("pointerdown", (event) => {
        if (!isPointerOnRangeThumb(volumeEl, event)) {
          event.preventDefault();
          event.stopPropagation();
          cancelVolumeDrag();
          return;
        }

        isVolumeDragAllowed = true;
        isChangingVolume = true;
        try {
          volumeEl.setPointerCapture(event.pointerId);
        } catch {}
      });

      volumeEl.addEventListener("input", () => {
        if (!isVolumeDragAllowed) {
          volumeEl.value = lastVolumeUiValue;
          return;
        }

        isChangingVolume = true;
        commitVolume();
      });

      volumeEl.addEventListener("change", () => {
        if (!isVolumeDragAllowed) {
          volumeEl.value = lastVolumeUiValue;
          return;
        }

        commitVolume({ force: true });
        cancelVolumeDrag();
      });

      volumeEl.addEventListener("pointerup", () => {
        if (!isVolumeDragAllowed) return;

        commitVolume({ force: true });
        cancelVolumeDrag();
      });

      volumeEl.addEventListener("pointercancel", () => {
        cancelVolumeDrag();
      });

      positionEl.addEventListener("pointerdown", () => {
        isSeeking = true;
      });

      positionEl.addEventListener("input", () => {
        positionCurrentEl.textContent = formatTime(Number(positionEl.value));
      });

      positionEl.addEventListener("change", () => {
        commitPosition();
        isSeeking = false;
      });

      positionEl.addEventListener("pointerup", () => {
        commitPosition();
        isSeeking = false;
      });

      positionEl.addEventListener("pointercancel", () => {
        isSeeking = false;
      });

      pairCodeEl.textContent = bootstrap.pairCode || "—";
      renderVibe(null);
      renderQueue([]);
      setDebug({ pairCode: bootstrap.pairCode, sessionId: bootstrap.sessionId });
      connect();
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/api/health")) {
  log(`HTTP request: ${req.method} ${req.url}`);
}

  applyCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const origins = getServerOrigins();

  try {
    if (requestUrl.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        ...origins
      });
      return;
    }

    if (
      requestUrl.pathname === "/api/pairing/session" &&
      (req.method === "POST" || req.method === "GET")
    ) {
      const requestMeta =
        req.method === "POST"
          ? safeParseJson(await readBody(req)) || {}
          : Object.fromEntries(requestUrl.searchParams.entries());

      const session = createSession(requestMeta);
      const remoteUrl = buildRemoteUrl({
        publicHttpOrigin: origins.publicHttpOrigin,
        pairCode: session.pairCode,
        sessionId: session.sessionId
      });

      const qrDataUrl = await createQrDataUrl(remoteUrl);

      sendJson(res, 200, {
        ok: true,
        sessionId: session.sessionId,
        pairCode: session.pairCode,
        expiresAt: new Date(session.expiresAt).toISOString(),
        localHttpOrigin: origins.localHttpOrigin,
        publicHttpOrigin: origins.publicHttpOrigin,
        publicWsOrigin: origins.publicWsOrigin,
        remoteUrl,
        qrDataUrl
      });
      return;
    }

    if (requestUrl.pathname === "/remote" && req.method === "GET") {
      const pairCode = requestUrl.searchParams.get("pair") || "";
      const sessionId = requestUrl.searchParams.get("sid") || "";

      sendHtml(
        res,
        200,
        renderRemoteHtml({
          publicWsOrigin: origins.publicWsOrigin,
          pairCode,
          sessionId
        })
      );
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    log(`HTTP server error: ${error.message}`);
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  log("New WebSocket connection established");  
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (buffer) => {
    //log(`Raw message: ${buffer}`);  
    const message = safeParseJson(String(buffer));
    if (!message || typeof message !== "object") {
      sendError(ws, "BAD_JSON", "Message must be valid JSON");
      return;
    }

    handleWsMessage(ws, message);
  });

  ws.on("close", (code, reason) => {  // <-- изменено
    log(`Client closed connection: code=${code}, reason=${reason}`);
    clearSocket(ws);
  });
  
  ws.on("error", (err) => {  // <-- изменено
    log(`WebSocket error: ${err.message || err}`);
    clearSocket(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch {}

    safeSend(ws, {
      type: "server/ping",
      at: new Date().toISOString()
    });
  }
}, CONFIG.HEARTBEAT_MS);

setInterval(cleanupSessions, 60 * 1000);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const origins = getServerOrigins();
  console.log("[server] started");
  console.log("[server] local:", origins.localHttpOrigin);
  console.log("[server] public:", origins.publicHttpOrigin);
  console.log("[server] ws:", origins.publicWsOrigin + "/ws");
});
// --- CLI для управления сервером ---
if (process.env.ENABLE_CLI === "1") {
  process.stdin.setEncoding("utf8");

  console.log("[CLI] Введите команду: help для списка");

  process.stdin.on("data", (input) => {
    const cmd = input.trim().toLowerCase();

    switch (cmd) {
      case "help":
        console.log("Доступные команды:");
        console.log("  stop          - остановка сервера");
        console.log("  debug on      - включить логирование");
        console.log("  debug off     - выключить логирование");
        console.log("  heartbeat     - показать количество подключенных клиентов");
        console.log("  ip <IP>       - сменить HOST (требует перезапуска)");
        console.log("  port <PORT>   - сменить PORT (требует перезапуска)");
        break;

      case "stop":
        log("Server stopped via CLI");
        console.log("Остановка сервера...");
        process.exit(0);
        break;

      case "debug on":
        CONFIG.DEBUG = true;
        log("Debug включен через CLI");
        break;

      case "debug off":
        CONFIG.DEBUG = false;
        log("Debug выключен через CLI");
        break;

      case "heartbeat":
        console.log(`Подключено клиентов: ${wss.clients.size}`);
        break;

      default:
        if (cmd.startsWith("ip ")) {
          const newIp = cmd.split(" ")[1];
          console.log(`Для смены IP на ${newIp} требуется перезапуск сервера.`);
        } else if (cmd.startsWith("port ")) {
          const newPort = cmd.split(" ")[1];
          console.log(`Для смены порта на ${newPort} требуется перезапуск сервера.`);
        } else {
          console.log("Неизвестная команда. help для списка команд.");
        }
        break;
    }
  });
}

