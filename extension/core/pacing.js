export const minRequestDelay = 250;
export const maxRequestDelay = 60000;

export const pacePresets = Object.freeze({
  balanced: Object.freeze({ minDelay: 1000, maxDelay: 2000 }),
  faster: Object.freeze({ minDelay: 500, maxDelay: 750 })
});

export function paceFromDelays(minDelay, maxDelay) {
  return Object.entries(pacePresets).find(([, preset]) =>
    preset.minDelay === minDelay && preset.maxDelay === maxDelay)?.[0] ?? "custom";
}
