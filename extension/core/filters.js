import { isSnowflake, WiperError } from "./validation.js";

const dateModes = new Set(["before", "after", "during", "except"]);
const wordModes = new Set(["containing", "excluding"]);
const discordEpoch = 1420070400000n;
export const maxWordQueryLength = 256;

function localDay(value) {
  const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) throw new WiperError("Choose a valid date for the date filter.");
  const [year, month, day] = parts.slice(1).map(Number);
  const start = new Date(0);
  start.setFullYear(year, month - 1, day);
  start.setHours(0, 0, 0, 0);
  if (year < 1 || start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new WiperError("Choose a valid calendar date for the date filter.");
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

export function compileFilters(values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      ["dateEnabled", "wordEnabled"].some(key => values[key] !== undefined && typeof values[key] !== "boolean")) {
    throw new WiperError("Choose valid date and word filter options.");
  }
  const dateEnabled = values.dateEnabled === true;
  const wordEnabled = values.wordEnabled === true;
  let dateMode = "before";
  let dateFrom = "";
  let dateTo = "";
  let startTime = 0;
  let endTime = 0;
  let timeZone = "";
  if (dateEnabled) {
    if (!dateModes.has(values.dateMode)) throw new WiperError("Choose Before, After, During, or Except for the date filter.");
    dateMode = values.dateMode;
    dateFrom = values.dateFrom;
    const firstDay = localDay(dateFrom);
    startTime = firstDay.start;
    endTime = firstDay.end;
    if (["during", "except"].includes(dateMode)) {
      dateTo = values.dateTo;
      const lastDay = localDay(dateTo);
      if (lastDay.start < startTime) throw new WiperError("The date filter's end date must be on or after its start date.");
      endTime = lastDay.end;
    }
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "device local time";
  }
  let wordMode = "containing";
  let wordQuery = "";
  if (wordEnabled) {
    if (!wordModes.has(values.wordMode)) throw new WiperError("Choose Containing or Excluding for the word filter.");
    wordMode = values.wordMode;
    wordQuery = typeof values.wordQuery === "string" ? values.wordQuery.trim() : "";
    if (!wordQuery || wordQuery.length > maxWordQueryLength) {
      throw new WiperError(`Enter a word or phrase of 1–${maxWordQueryLength} characters for the word filter.`);
    }
  }
  return Object.freeze({ dateEnabled, dateMode, dateFrom, dateTo, startTime, endTime, timeZone,
    wordEnabled, wordMode, wordQuery, foldedQuery: wordQuery.toLowerCase() });
}

export function describeFilters(filters) {
  const descriptions = [];
  if (filters.dateEnabled) {
    const range = filters.dateTo ? `${filters.dateFrom} through ${filters.dateTo}, inclusive` : `${filters.dateFrom}, selected day excluded`;
    descriptions.push(`Date: ${filters.dateMode} ${range} (${filters.timeZone})`);
  }
  if (filters.wordEnabled) descriptions.push(`Words: ${filters.wordMode}, case-insensitive literal text`);
  return descriptions.length ? descriptions.join(" · ") : "Date and word filters off.";
}

export function matchesFilters(message, filters) {
  if (filters.dateEnabled) {
    if (!isSnowflake(message?.id) || BigInt(message.id) > 18446744073709551615n) {
      throw new WiperError("Unable to verify a message's creation date. Stopped without offering a partial preview.");
    }
    const createdAt = Number((BigInt(message.id) >> 22n) + discordEpoch);
    const inside = createdAt >= filters.startTime && createdAt < filters.endTime;
    const matchesDate = filters.dateMode === "before" ? createdAt < filters.startTime :
      filters.dateMode === "after" ? createdAt >= filters.endTime :
      filters.dateMode === "during" ? inside : !inside;
    if (!matchesDate) return false;
  }
  if (filters.wordEnabled) {
    if (typeof message?.content !== "string") {
      throw new WiperError("Unable to verify a message's text for the word filter. Stopped without offering a partial preview.");
    }
    const contains = message.content.toLowerCase().includes(filters.foldedQuery);
    if (filters.wordMode === "containing" ? !contains : contains) return false;
  }
  return true;
}
