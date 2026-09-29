import type { JsonValue } from "jazz-tools";

export function toJsonValue(value: unknown, label = "value"): JsonValue {
  if (value === undefined) return null;

  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return JSON.parse(encoded) as JsonValue;
  } catch (error) {
    throw new TypeError(
      `${label} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
