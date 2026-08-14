import { createHash } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function keys(value) {
  return Object.keys(value).sort().join("\0");
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function validateReasoningSummary(summary, label) {
  if (!Array.isArray(summary) || summary.some((entry) => (
    typeof entry !== "string" &&
    !(entry && typeof entry === "object" && !Array.isArray(entry) &&
      keys(entry) === "text\0type" && typeof entry.type === "string" &&
      typeof entry.text === "string")
  ))) {
    throw new Error(`${label}.summary has an invalid shape`);
  }
}

function validateItem(item, eventType, index, prefix) {
  if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") {
    throw new Error(`${prefix} transcript contains a prohibited or unknown item at line ${index}`);
  }
  const label = `${prefix} transcript item at line ${index}`;
  if (item.type === "agent_message") {
    const expected = eventType === "item.completed" ? "id\0text\0type" : "id\0type";
    if (keys(item) !== expected) throw new Error(`${prefix} transcript contains prohibited or unknown item fields at line ${index}`);
    requireString(item.id, `${label}.id`);
    if (eventType === "item.completed") requireString(item.text, `${label}.text`);
    return { type: item.type, text: eventType === "item.completed" ? item.text : null };
  }
  if (item.type === "reasoning") {
    const expected = eventType === "item.completed" ? "id\0summary\0type" : "id\0type";
    if (keys(item) !== expected) throw new Error(`${prefix} transcript contains prohibited or unknown item fields at line ${index}`);
    requireString(item.id, `${label}.id`);
    if (eventType === "item.completed") validateReasoningSummary(item.summary, label);
    return { type: item.type, text: null };
  }
  if (item.type === "error") {
    const expected = eventType === "item.completed" ? "id\0message\0type" : "id\0type";
    if (keys(item) !== expected) throw new Error(`${prefix} transcript contains prohibited or unknown item fields at line ${index}`);
    requireString(item.id, `${label}.id`);
    if (eventType === "item.completed") requireString(item.message, `${label}.message`);
    return { type: item.type, text: null };
  }
  throw new Error(`${prefix} transcript contains a prohibited or unknown item at line ${index}`);
}

export function parseZeroToolTranscript(output, prefix = "Codex") {
  const raw = String(output ?? "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error(`${prefix} transcript is empty`);
  const eventCounts = new Map();
  const itemCounts = new Map();
  const messages = [];
  let phase = 0;
  for (const [offset, line] of lines.entries()) {
    const index = offset + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`${prefix} transcript line ${index} is not JSON`);
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      throw new Error(`${prefix} transcript contains a prohibited or unknown event at line ${index}`);
    }
    if (event.type === "thread.started") {
      if (phase !== 0 || keys(event) !== "thread_id\0type") throw new Error(`${prefix} transcript thread.started schema is invalid`);
      requireString(event.thread_id, `${prefix} transcript thread_id`);
      phase = 1;
    } else if (event.type === "turn.started") {
      if (phase !== 1 || keys(event) !== "type") throw new Error(`${prefix} transcript turn.started schema is invalid`);
      phase = 2;
    } else if (event.type === "item.started" || event.type === "item.completed") {
      if ((phase !== 2 && phase !== 1) || keys(event) !== "item\0type") throw new Error(`${prefix} transcript contains a prohibited or unknown item/event at line ${index}`);
      const item = validateItem(event.item, event.type, index, prefix);
      if (phase === 1 && (event.type !== "item.completed" || item.type !== "error")) {
        throw new Error(`${prefix} transcript contains an item before turn.started at line ${index}`);
      }
      itemCounts.set(item.type, (itemCounts.get(item.type) ?? 0) + 1);
      if (item.text !== null) messages.push(item.text);
    } else if (event.type === "turn.completed") {
      if (phase !== 2 || keys(event) !== "type\0usage" || !event.usage || typeof event.usage !== "object" || Array.isArray(event.usage) ||
          !["input_tokens\0output_tokens", "cache_write_input_tokens\0cached_input_tokens\0input_tokens\0output_tokens\0reasoning_output_tokens"].includes(keys(event.usage))) {
        throw new Error(`${prefix} transcript turn.completed schema is invalid`);
      }
      requireNonNegativeInteger(event.usage.input_tokens, `${prefix} transcript usage.input_tokens`);
      requireNonNegativeInteger(event.usage.output_tokens, `${prefix} transcript usage.output_tokens`);
      if (Object.hasOwn(event.usage, "cached_input_tokens")) {
        requireNonNegativeInteger(event.usage.cached_input_tokens, `${prefix} transcript usage.cached_input_tokens`);
        requireNonNegativeInteger(event.usage.cache_write_input_tokens, `${prefix} transcript usage.cache_write_input_tokens`);
        requireNonNegativeInteger(event.usage.reasoning_output_tokens, `${prefix} transcript usage.reasoning_output_tokens`);
      }
      phase = 3;
    } else {
      throw new Error(`${prefix} transcript contains a prohibited or unknown event at line ${index}`);
    }
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
  }
  if (phase !== 3 || eventCounts.get("thread.started") !== 1 || eventCounts.get("turn.started") !== 1 ||
      eventCounts.get("turn.completed") !== 1 || messages.length !== 1) {
    throw new Error(`${prefix} transcript lifecycle is incomplete or ambiguous`);
  }
  const counted = (values) => [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
  return {
    responseText: messages.at(-1),
    transcriptDigest: digest(raw),
    transcriptSummary: {
      schemaVersion: 1,
      eventCount: lines.length,
      eventTypes: counted(eventCounts),
      itemTypes: counted(itemCounts),
      observedToolCalls: 0
    }
  };
}
