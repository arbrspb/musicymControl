const EXT_TO_PAGE_CHANNEL = "YR_EXT_TO_PAGE";
const PAGE_TO_EXT_CHANNEL = "YR_PAGE_TO_EXT";

function postToPage(message) {
  window.postMessage(
    {
      channel: EXT_TO_PAGE_CHANNEL,
      ...message
    },
    "*"
  );
}

async function sendToBackground(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (!String(error?.message || error).includes("Extension context invalidated")) {
      console.warn("[content -> background]", error);
    }

    return null;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const data = event.data || {};
  if (data.channel !== PAGE_TO_EXT_CHANNEL) return;

  if (data.type === "PLAYER_READY" || data.type === "PLAYER_SNAPSHOT") {
    void sendToBackground({
      type: "content/player-event",
      payload: data.payload
    });
    return;
  }

  if (data.type === "COMMAND_RESULT") {
    void sendToBackground({
      type: "content/command-result",
      payload: data.payload
    });
  }
  if (data.type === "PLAYER_DIAGNOSTIC") {
    void sendToBackground({
      type: "content/player-event",
      payload: {
        event: data.payload?.event || "diagnostic",
        ...data.payload?.state,
      },
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PLAYER_PING") {
    sendResponse({ ok: true, accepted: true });
    return;
  }

  if (message?.type === "PLAYER_COMMAND") {
    postToPage({
      type: "PLAYER_COMMAND",
      action: message.action,
      payload: message.payload || {},
      requestId: message.requestId
    });
    sendResponse({ ok: true, accepted: true });
    return;
  }

  if (message?.type === "PLAYER_REQUEST_STATE") {
    postToPage({
      type: "PLAYER_REQUEST_STATE",
      requestId: message.requestId
    });
    sendResponse({ ok: true, accepted: true });
  }
});


postToPage({
  type: "PLAYER_REQUEST_STATE",
  requestId: "content-bootstrap"
});

void sendToBackground({ type: "content/bridge-ready" });
