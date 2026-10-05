import { isSnowflake, WiperError } from "./validation.js";

const dateModes = new Set(["before", "after", "during", "except"]);
const wordModes = new Set(["containing", "excluding"]);
const wordMatches = new Set(["any", "all"]);
const attachmentTypes = new Set(["any", "image", "video", "audio", "file"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "svg", "ico", "heic", "heif", "apng"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "avi", "mkv", "ogv", "mpeg", "mpg", "3gp"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus", "aiff", "aif", "wma"]);
const discordEpoch = 1420070400000n;
export const maxWordQueryLength = 256;
export const maxWordQueries = 32;
export const maxWordInputLength = (maxWordQueryLength + 2) * maxWordQueries;

function includesTerm(text, term, wholeWords) {
  if (!wholeWords) return text.includes(term);
  for (let offset = text.indexOf(term); offset !== -1; offset = text.indexOf(term, offset + 1)) {
    const before = [...text.slice(Math.max(0, offset - 2), offset)].at(-1) ?? "";
    const afterPoint = text.codePointAt(offset + term.length);
    const after = afterPoint === undefined ? "" : String.fromCodePoint(afterPoint);
    if (!/[\p{L}\p{M}\p{N}_]/u.test(before) && !/[\p{L}\p{M}\p{N}_]/u.test(after)) return true;
  }
  return false;
}

function attachmentKind(attachment) {
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) ||
      typeof attachment.filename !== "string" || !attachment.filename ||
      (attachment.content_type !== undefined && typeof attachment.content_type !== "string")) {
    throw new WiperError("Unable to verify attachment metadata. Stopped without offering a partial preview.");
  }
  const contentType = attachment.content_type?.toLowerCase().trim() ?? "";
  for (const type of ["image", "video", "audio"]) if (contentType.startsWith(`${type}/`)) return type;
  const extension = /\.([a-z\d]+)$/i.exec(attachment.filename)?.[1].toLowerCase() ?? "";
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return "file";
}

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
      ["dateEnabled", "wordEnabled", "wholeWords", "keepPinned", "attachmentEnabled"].some(key => values[key] !== undefined && typeof values[key] !== "boolean")) {
    throw new WiperError("Choose valid filter options.");
  }
  const dateEnabled = values.dateEnabled === true;
  const wordEnabled = values.wordEnabled === true;
  const keepPinned = values.keepPinned === true;
  const attachmentEnabled = values.attachmentEnabled === true;
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
  let wordMatch = "any";
  let queries = [];
  if (wordEnabled) {
    if (!wordModes.has(values.wordMode)) throw new WiperError("Choose Containing or Excluding for the word filter.");
    wordMode = values.wordMode;
    wordQuery = typeof values.wordQuery === "string" ? values.wordQuery.trim() : "";
    wordMatch = values.wordMatch ?? "any";
    if (!wordMatches.has(wordMatch)) throw new WiperError("Choose Match any or Match all for the word filter.");
    if (!wordQuery || wordQuery.length > maxWordInputLength) {
      throw new WiperError(`Enter up to ${maxWordQueries} words or phrases, one per line, with 1–${maxWordQueryLength} characters each.`);
    }
    const lines = wordQuery.split(/\r\n|\n|\r/).map(value => value.trim()).filter(Boolean);
    if (lines.length > maxWordQueries || lines.some(value => value.length > maxWordQueryLength)) {
      throw new WiperError(`Use up to ${maxWordQueries} words or phrases, one per line, with 1–${maxWordQueryLength} characters each.`);
    }
    queries = [...new Map(lines.map(value => [value.toLowerCase(), value])).values()];
  }
  let attachmentMode = "containing";
  let attachmentType = "any";
  if (attachmentEnabled) {
    attachmentMode = values.attachmentMode ?? "containing";
    attachmentType = values.attachmentType ?? "any";
    if (!wordModes.has(attachmentMode) || !attachmentTypes.has(attachmentType)) {
      throw new WiperError("Choose valid Containing/Excluding and attachment type options.");
    }
  }
  return Object.freeze({ dateEnabled, dateMode, dateFrom, dateTo, startTime, endTime, timeZone,
    wordEnabled, wordMode, wordQuery, foldedQuery: wordQuery.toLowerCase(), wordMatch,
    wholeWords: wordEnabled && values.wholeWords === true, queries: Object.freeze(queries),
    foldedQueries: Object.freeze(queries.map(value => value.toLowerCase())), keepPinned, attachmentEnabled, attachmentMode, attachmentType });
}

export function describeFilters(filters) {
  const descriptions = [];
  if (filters.dateEnabled) {
    const range = filters.dateTo ? `${filters.dateFrom} through ${filters.dateTo}, inclusive` : `${filters.dateFrom}, selected day excluded`;
    descriptions.push(`Date: ${filters.dateMode} ${range} (${filters.timeZone})`);
  }
  if (filters.wordEnabled) descriptions.push(`Words: ${filters.wordMode}, match ${filters.wordMatch} of ${filters.queries.length} terms, ${filters.wholeWords ? "whole words" : "literal substrings"}, case-insensitive`);
  if (filters.keepPinned) descriptions.push("Keep pinned messages; rechecked before deletion");
  if (filters.attachmentEnabled) descriptions.push(`Attachments: ${filters.attachmentMode} ${filters.attachmentType === "any" ? "any attachment" : filters.attachmentType === "file" ? "other files" : `${filters.attachmentType} files`}`);
  return descriptions.length ? descriptions.join(" · ") : "Filters off.";
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
  if (filters.keepPinned) {
    if (typeof message?.pinned !== "boolean") throw new WiperError("Unable to verify a message's pinned status. Stopped without offering a partial preview.");
    if (message.pinned) return false;
  }
  if (filters.wordEnabled) {
    if (typeof message?.content !== "string") {
      throw new WiperError("Unable to verify a message's text for the word filter. Stopped without offering a partial preview.");
    }
    const text = message.content.toLowerCase();
    const matches = term => includesTerm(text, term, filters.wholeWords);
    const contains = filters.wordMatch === "all" ? filters.foldedQueries.every(matches) : filters.foldedQueries.some(matches);
    if (filters.wordMode === "containing" ? !contains : contains) return false;
  }
  if (filters.attachmentEnabled) {
    if (!Array.isArray(message?.attachments)) throw new WiperError("Unable to verify a message's attachments. Stopped without offering a partial preview.");
    const kinds = message.attachments.map(attachmentKind);
    const contains = filters.attachmentType === "any" ? kinds.length > 0 : kinds.includes(filters.attachmentType);
    if (filters.attachmentMode === "containing" ? !contains : contains) return false;
  }
  return true;
}
