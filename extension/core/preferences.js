import { isSnowflake, validateDelays } from "./validation.js";

export function cleanPreferences(values = {}) {
  let minDelay = 1000;
  let maxDelay = 2000;
  try {
    ({ minDelay, maxDelay } = validateDelays(values.minDelay, values.maxDelay));
  } catch {}
  const rememberChannel = values.rememberChannel === true;
  return { minDelay, maxDelay, rememberChannel,
    channelId: rememberChannel && isSnowflake(values.channelId) ? values.channelId : "",
    theme: values.theme === "light" ? "light" : "dark" };
}

export async function loadPreferences(storage) {
  const result = await storage.get("wiperPreferences");
  return cleanPreferences(result.wiperPreferences);
}

export async function savePreferences(storage, values) {
  await storage.set({ wiperPreferences: cleanPreferences(values) });
}
