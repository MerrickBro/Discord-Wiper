export class WiperError extends Error {
  constructor(message) {
    super(message);
    this.name = "WiperError";
  }
}

export const discordOrigins = Object.freeze([
  "https://discord.com",
  "https://ptb.discord.com",
  "https://canary.discord.com"
]);

export function isSnowflake(value) {
  return typeof value === "string" && /^[1-9]\d{16,19}$/.test(value);
}

export function validateChannelId(value) {
  const channelId = typeof value === "string" ? value.trim() : "";
  if (!isSnowflake(channelId)) throw new WiperError("Enter a valid Discord channel ID (17–20 digits).");
  return channelId;
}

export function validateDelays(minDelay, maxDelay) {
  if (!Number.isInteger(minDelay) || !Number.isInteger(maxDelay) ||
      minDelay < 1000 || maxDelay > 60000 || minDelay > maxDelay) {
    throw new WiperError("Use whole-number delays from 1,000 to 60,000 ms, with minimum ≤ maximum.");
  }
  return { minDelay, maxDelay };
}

export function validateToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new WiperError("Enter a valid authorization token without spaces or an authorization prefix.");
  }
  return token;
}

export function channelFromPath(pathname) {
  const match = /^\/channels\/(?:@me|[1-9]\d{16,19})\/([1-9]\d{16,19})(?:\/|$)/.exec(pathname);
  return match?.[1] ?? "";
}

export function safeErrorMessage(error) {
  return error instanceof WiperError ? error.message : "An unexpected error occurred. The operation was stopped.";
}
