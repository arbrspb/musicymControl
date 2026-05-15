const QRCode = require("qrcode");

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function createPairCode(length = 8) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * PAIR_ALPHABET.length);
    value += PAIR_ALPHABET[randomIndex];
  }
  return value;
}

function buildRemoteUrl({ publicHttpOrigin, pairCode, sessionId }) {
  const url = new URL("/remote", publicHttpOrigin);
  url.searchParams.set("pair", pairCode);
  url.searchParams.set("sid", sessionId);
  return url.toString();
}

async function createQrDataUrl(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320
  });
}

module.exports = {
  createPairCode,
  buildRemoteUrl,
  createQrDataUrl
};
