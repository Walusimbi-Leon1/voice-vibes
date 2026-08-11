/**
 * Voice Vibes — Support Developer external link opener (bible-game pattern).
 *
 * In Discord's Activity sandbox, external navigation is blocked — the ONLY
 * sanctioned API is discordSdk.commands.openExternalLink({url}), which shows
 * a one-time "Trust this domain" prompt and opens the user's real browser.
 * In a plain browser the native target="_blank" link just works.
 */

import { discordSdk, inDiscordFrame } from "./discord.js";

const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";

function openExternalUrl(url) {
  // Plain browser: native target="_blank" behavior is exactly right.
  if (!inDiscordFrame) return;
  // Discord sandbox: external navigation is blocked — use the SDK.
  if (discordSdk && typeof discordSdk.commands.openExternalLink === "function") {
    discordSdk.commands.openExternalLink({ url }).catch((err) => {
      console.error("[support] openExternalLink failed:", err);
      window.open(url, "_blank");
    });
  } else {
    window.open(url, "_blank");
  }
}

function wireLinks() {
  document.querySelectorAll("a.support-link, a.support-chip").forEach((a) => {
    a.addEventListener("click", (e) => {
      if (!inDiscordFrame) return;
      e.preventDefault();
      openExternalUrl(SUPPORT_URL);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLinks);
} else {
  wireLinks();
}
