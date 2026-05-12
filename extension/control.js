const el = {
  summary: document.getElementById("summary"),
  stateDump: document.getElementById("stateDump"),
  prevBtn: document.getElementById("prevBtn"),
  toggleBtn: document.getElementById("toggleBtn"),
  nextBtn: document.getElementById("nextBtn"),
  likeBtn: document.getElementById("likeBtn"),
  dislikeBtn: document.getElementById("dislikeBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  positionRange: document.getElementById("positionRange"),
  positionCurrent: document.getElementById("positionCurrent"),
  positionDuration: document.getElementById("positionDuration"),
  volumeRange: document.getElementById("volumeRange")
};

let isSeeking = false;
let lastSeekKey = "";
let lastSeekAt = 0;
let isChangingVolume = false;
let lastVolumeKey = "";
let lastVolumeAt = 0;
let volumeHoldUntil = 0;
let refreshTimer = null;

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 150);
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
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }

  return `${minutes}:${seconds}`;
}

function setLikeState(liked) {
  el.likeBtn.classList.toggle("is-liked", liked);
  el.likeBtn.setAttribute("aria-pressed", String(liked));
  el.likeBtn.textContent = `${liked ? "\u2665" : "\u2661"} Like`;
}

function updateReactionButtons(track) {
  const liked = Boolean(track?.liked);
  const disliked = Boolean(track?.disliked);

  setLikeState(liked);
  el.dislikeBtn.classList.toggle("is-disliked", disliked);
  el.dislikeBtn.setAttribute("aria-pressed", String(disliked));
}

function summarize(state) {
  const track = state?.lastPlayerState?.track;
  const title = track?.title || "—";
  const artists = (track?.artists || [])
    .map((artist) => artist.name || artist.title)
    .join(", ");

  return [
    `WS: ${state.wsConnected ? "подключён" : "отключён"}`,
    `Телефон: ${state.isPaired ? "подключён" : "нет"}`,
    `Pair code: ${state.lastPairing?.pairCode || "—"}`,
    `Трек: ${title}${artists ? " — " + artists : ""}`
  ].join(" | ");
}

async function getState() {
  return chrome.runtime.sendMessage({ type: "background/get-state" });
}

function updateProgress(progress) {
  const duration = Number(progress?.duration) || 0;
  const position = clamp(Number(progress?.position) || 0, 0, duration);

  el.positionRange.disabled = duration <= 0;
  el.positionRange.max = String(duration);

  if (!isSeeking) {
    el.positionRange.value = String(position);
    el.positionCurrent.textContent = formatTime(position);
  }

  el.positionDuration.textContent = formatTime(duration);
}

function updateVolume(volume) {
  if (isChangingVolume || Date.now() < volumeHoldUntil) return;
  if (typeof volume !== "number" || !Number.isFinite(volume)) return;

  el.volumeRange.value = String(Math.round(clamp(volume, 0, 1) * 100));
}

async function commitSeek() {
  const duration = Number(el.positionRange.max) || 0;
  if (duration <= 0) return;

  const value = clamp(Number(el.positionRange.value) || 0, 0, duration);
  const seekKey = `${duration}:${value}`;
  const now = Date.now();

  if (seekKey === lastSeekKey && now - lastSeekAt < 300) return;

  lastSeekKey = seekKey;
  lastSeekAt = now;

  el.positionRange.value = String(value);
  el.positionCurrent.textContent = formatTime(value);

  await send("setPosition", { value });
}

async function commitVolume({ force = false } = {}) {
  const value = clamp(Number(el.volumeRange.value) || 0, 0, 100);
  const volumeKey = String(value);
  const now = Date.now();

  if (!force && now - lastVolumeAt < 150) return;
  if (!force && volumeKey === lastVolumeKey && now - lastVolumeAt < 500) return;

  lastVolumeKey = volumeKey;
  lastVolumeAt = now;
  volumeHoldUntil = now + 1000;

  el.volumeRange.value = String(value);

  await send("setVolume", { value: value / 100 });
}

async function refresh() {
  const state = await getState();

  el.summary.textContent = summarize(state);
  el.stateDump.textContent = JSON.stringify(state, null, 2);
  updateReactionButtons(state?.lastPlayerState?.track);
  updateProgress(state?.lastPlayerState?.progress);

  updateVolume(state?.lastPlayerState?.volume);
}

async function send(action, payload = {}) {
  await chrome.runtime.sendMessage({
    type: "popup/player-command",
    action,
    payload
  });

  setTimeout(() => {
    void refresh();
  }, 300);
}

document.addEventListener("DOMContentLoaded", async () => {
  el.prevBtn.addEventListener("click", () => void send("prev"));
  el.toggleBtn.addEventListener("click", () => void send("playPause"));
  el.nextBtn.addEventListener("click", () => void send("next"));
  el.likeBtn.addEventListener("click", () => {
    setLikeState(!el.likeBtn.classList.contains("is-liked"));
    void send("like");
  });
  el.dislikeBtn.addEventListener("click", () => {
    setLikeState(false);
    void send("dislike");
  });
  el.refreshBtn.addEventListener("click", () => void refresh());

  el.positionRange.addEventListener("pointerdown", () => {
    isSeeking = true;
  });

  el.positionRange.addEventListener("input", () => {
    el.positionCurrent.textContent = formatTime(Number(el.positionRange.value));
  });

  el.positionRange.addEventListener("change", () => {
    void commitSeek().finally(() => {
      isSeeking = false;
    });
  });

  el.positionRange.addEventListener("pointerup", () => {
    void commitSeek().finally(() => {
      isSeeking = false;
    });
  });

  el.positionRange.addEventListener("pointercancel", () => {
    isSeeking = false;
  });

  el.volumeRange.addEventListener("pointerdown", () => {
    isChangingVolume = true;
  });

  el.volumeRange.addEventListener("input", () => {
    isChangingVolume = true;
    void commitVolume();
  });

  el.volumeRange.addEventListener("change", () => {
    void commitVolume({ force: true }).finally(() => {
      isChangingVolume = false;
    });
  });

  el.volumeRange.addEventListener("pointerup", () => {
    void commitVolume({ force: true }).finally(() => {
      isChangingVolume = false;
    });
  });

  el.volumeRange.addEventListener("pointercancel", () => {
    isChangingVolume = false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  scheduleRefresh();
  });


  await refresh();
});
