import { isSecretKeyName, looksLikeSecretValue } from "@beamhop/sdk";

type Schema = { [k: string]: unknown } | undefined;

const isSecretSchema = (s: Schema) => !!s && (s.format === "password" || s.writeOnly === true || s["x-secret"] === true);

const sub = (s: Schema, key: "properties" | "items" | "additionalProperties", name?: string): Schema => {
  const v = s?.[key];
  if (!v || typeof v !== "object") return undefined;
  return (name !== undefined ? (v as Record<string, unknown>)[name] : v) as Schema;
};

/**
 * Deep copy of plugin settings with secret values replaced by "[redacted]", for audit records and logs.
 * A field is secret when its JSON schema node is `format: "password"`, `writeOnly` or `x-secret`, or when its
 * key looks like a credential (the same matcher the admin API masks with) — at any depth, whole subtree. Strings
 * that carry a credential on their own (URLs with `user:pass@` or `secret=`, nsec keys) are redacted too.
 */
export function redactSecrets(value: unknown, schema?: Schema, key?: string): unknown {
  if ((key !== undefined && isSecretKeyName(key)) || isSecretSchema(schema)) {
    return value === undefined || value === null || value === "" ? value : "[redacted]";
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, sub(schema, "items")));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, sub(schema, "properties", k) ?? sub(schema, "additionalProperties"), k);
    }
    return out;
  }
  if (typeof value === "string" && looksLikeSecretValue(value)) return "[redacted]";
  return value;
}
