const BLOCKED_PROTOCOLS = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "view-source:",
  "moz-extension:"
];

const BLOCKED_HOSTS = [
  "chromewebstore.google.com",
  "chrome.google.com"
];

export function getTabSupport(url) {
  if (!url) {
    return { supported: false, reason: "タブ URL を取得できませんでした。" };
  }

  try {
    const parsed = new URL(url);

    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return { supported: false, reason: "このページ種別では拡張のオーバーレイを挿入できません。" };
    }

    if (BLOCKED_HOSTS.includes(parsed.hostname)) {
      return { supported: false, reason: "Chrome Web Store 上では開始できません。" };
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { supported: false, reason: "http/https ページのみ対応しています。" };
    }

    return { supported: true, reason: "" };
  } catch {
    return { supported: false, reason: "このページでは開始できません。" };
  }
}
