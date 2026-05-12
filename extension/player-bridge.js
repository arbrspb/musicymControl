(() => {
  const EXT_TO_PAGE_CHANNEL = "YR_EXT_TO_PAGE";
  const PAGE_TO_EXT_CHANNEL = "YR_PAGE_TO_EXT";

  let subscriptionsInstalled = false;
  let lastNavigationAt = 0;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safe(fn, fallback = null) {
    try {
      const value = fn();
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function post(type, payload) {
    window.postMessage(
      {
        channel: PAGE_TO_EXT_CHANNEL,
        type,
        payload
      },
      "*"
    );
  }

  function hasApi(api) {
    return (
      api &&
      typeof api.on === "function" &&
      typeof api.getCurrentTrack === "function" &&
      typeof api.getControls === "function"
    );
  }

  function compactTrack(track, index) {
    if (!track || typeof track !== "object") return null;

    const artists = Array.isArray(track.artists)
      ? track.artists
          .map((artist) => artist?.name || artist?.title)
          .filter(Boolean)
      : [];

    return {
      index,
      title: track.title || "",
      artists,
      duration: Number(track.duration) || 0,
      cover: track.cover || "",
      liked: Boolean(track.liked),
      disliked: Boolean(track.disliked)
    };
  }

  function getUpcomingTracks(api, currentIndex, limit = 8) {
    const tracksList = safe(() => api.getTracksList(), []);
    if (!Array.isArray(tracksList) || currentIndex < 0) return [];

    const upcoming = [];

    for (
      let index = currentIndex + 1;
      index < tracksList.length && upcoming.length < limit;
      index += 1
    ) {
      const track = compactTrack(tracksList[index], index);
      if (track) upcoming.push(track);
    }

    return upcoming;
  }

  function normalizeVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return 0;

    return Math.min(Math.max(volume > 1 ? volume / 100 : volume, 0), 1);
  }

  function isTrackReady(track) {
    return Boolean(track && typeof track === "object" && (track.title || track.cover || track.duration));
  }

  function isNextReady(api) {
    const controls = safe(() => api.getControls(), null);
    if (controls?.next === false) return false;

    return isTrackReady(safe(() => api.getNextTrack(), null));
  }

  async function withTimeout(task, timeoutMs = 4000) {
    const timedOut = Symbol("timedOut");

    try {
      const promise = typeof task === "function" ? task() : task;
      const result = await Promise.race([
        Promise.resolve(promise),
        wait(timeoutMs).then(() => timedOut)
      ]);

      return result === timedOut ? { timedOut: true } : result;
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }

  async function runNavigation(api, action, run) {
    const now = Date.now();

    if (now - lastNavigationAt < 180) {
      return { ignored: true, reason: "navigation-cooldown" };
    }

    lastNavigationAt = now;

    return withTimeout(run, action === "playIndex" ? 3500 : 2500);
  }

  async function getApi(timeoutMs = 20000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (hasApi(window.externalAPI)) {
        return window.externalAPI;
      }
      await wait(250);
    }

    throw new Error("window.externalAPI не инициализировался");
  }

  function snapshot(event = "snapshot") {
    const api = window.externalAPI;
    const trackIndex = safe(() => api.getTrackIndex(), -1);

    return {
      event,
      capturedAt: new Date().toISOString(),
      trackIndex,
      track: safe(() => api.getCurrentTrack()),
      nextTrack: safe(() => api.getNextTrack()),
      prevTrack: safe(() => api.getPrevTrack()),
      upcomingTracks: safe(() => getUpcomingTracks(api, trackIndex), []),
      controls: safe(() => api.getControls()),
      sourceInfo: safe(() => api.getSourceInfo()),
      progress: safe(() => api.getProgress()),
      volume: safe(() => api.getVolume()),
      speed: safe(() => api.getSpeed()),
      shuffle: safe(() => api.getShuffle()),
      repeat: safe(() => api.getRepeat()),
      isPlaying: safe(() => api.isPlaying())
    };
  }

  async function installSubscriptions() {
    if (subscriptionsInstalled) return;

    const api = await getApi();
    const eventKeys = [
      "EVENT_READY",
      "EVENT_STATE",
      "EVENT_TRACK",
      "EVENT_CONTROLS",
      "EVENT_SOURCE_INFO",
      "EVENT_TRACKS_LIST",
      "EVENT_VOLUME",
      "EVENT_SPEED",
      "EVENT_PROGRESS"
    ];

    for (const key of eventKeys) {
      const eventName = api[key];
      if (!eventName) continue;

      api.on(eventName, () => {
        post("PLAYER_SNAPSHOT", snapshot(key));
      });
    }

    subscriptionsInstalled = true;
    post("PLAYER_READY", snapshot("bootstrap"));
  }

  async function execute(action, payload = {}) {
    const api = await getApi();

    switch (action) {
      case "requestState":
        return snapshot("requestState");

      case "playPause":
        return api.togglePause(payload.state);

      case "play":
        return api.togglePause(false);

      case "pause":
        return api.togglePause(true);

      case "next":
        if (!isNextReady(api)) {
          return { ignored: true, reason: "next-not-ready" };
        }
        return runNavigation(api, "next", () => api.next());

      case "prev":
        return runNavigation(api, "prev", () => api.prev());

      case "like":
        return api.toggleLike();

      case "dislike":
        return api.toggleDislike();

      case "setVolume":
        return api.setVolume(normalizeVolume(payload.value));

      case "setPosition":
        return api.setPosition(Number(payload.value));

      case "playIndex": {
        const index = Number(payload.index);
        return runNavigation(api, "playIndex", () => api.play(index));
      }

      case "toggleShuffle":
        return api.toggleShuffle(payload.state);

      case "toggleRepeat":
        return api.toggleRepeat(payload.state);

      default:
        throw new Error(`Неподдерживаемая команда: ${action}`);
    }
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;

    const data = event.data || {};
    if (data.channel !== EXT_TO_PAGE_CHANNEL) return;

    try {
      await installSubscriptions();

      if (data.type === "PLAYER_REQUEST_STATE") {
        const state = snapshot("requestState");
        post("COMMAND_RESULT", {
          requestId: data.requestId,
          ok: true,
          result: state,
          state
        });
        return;
      }

      if (data.type === "PLAYER_COMMAND") {
        const result = await Promise.resolve(
          execute(data.action, data.payload || {})
        );

        const state = snapshot(data.action);
        post("COMMAND_RESULT", {
          requestId: data.requestId,
          ok: true,
          result,
          state
        });
      }
    } catch (error) {
      post("COMMAND_RESULT", {
        requestId: data.requestId,
        ok: false,
        error: error.message
      });
    }
  });

  const bootstrap = () => {
    void installSubscriptions().catch((error) => {
      post("COMMAND_RESULT", {
        requestId: "bootstrap",
        ok: false,
        error: error.message
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
