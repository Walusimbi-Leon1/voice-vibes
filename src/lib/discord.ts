// Optional Discord Embedded App SDK integration.
// Works when the app is embedded as a Discord Activity in a voice channel.
// Falls back gracefully (returns null) when opened as a regular web page.

let sdkPromise: Promise<{ instanceId: string; username?: string } | null> | null = null;

export function initDiscord(): Promise<{ instanceId: string; username?: string } | null> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    if (typeof window === "undefined") return null;
    // Only attempt when running inside Discord (has frame_id in URL)
    const params = new URLSearchParams(window.location.search);
    if (!params.get("frame_id")) return null;

    const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
    if (!clientId) {
      console.warn("VITE_DISCORD_CLIENT_ID not set — running in standalone mode.");
      return { instanceId: params.get("instance_id") || "discord" };
    }

    try {
      const { DiscordSDK } = await import("@discord/embedded-app-sdk");
      const sdk = new DiscordSDK(clientId);
      await sdk.ready();
      return { instanceId: sdk.instanceId };
    } catch (e) {
      console.warn("Discord SDK init failed:", e);
      return null;
    }
  })();
  return sdkPromise;
}
