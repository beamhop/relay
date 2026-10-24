import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { isAuthSlotName, isSecretKeyName, maskSecretValues } from "../src/secrets";

const redact = (v: unknown) => (v === undefined || v === null || v === "" ? v : "[redacted]");
const MASK = "••••••••";
/** the admin API's viewer masking: every non-empty string becomes the mask, structure and flags stay */
const maskAll = (v: unknown): unknown => {
  if (typeof v === "string") return v === "" ? v : MASK;
  if (Array.isArray(v)) return v.map(maskAll);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)]));
  return v;
};
const jsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });

describe("secret schema walker", () => {
  test("schema-marked secrets inside .nullable(), unions and intersections stay masked", () => {
    const schema = jsonSchema(
      z.object({
        upstream: z.string().meta({ format: "password" }).nullable().default(null),
        smtp: z.object({ host: z.string(), login: z.string().meta({ writeOnly: true }) }).nullable().default(null),
        creds: z.union([z.string().meta({ "x-secret": true }), z.number()]).default(0),
        merged: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string().meta({ format: "password" }) })).optional(),
        label: z.string().default(""),
      }),
    );
    const values = { upstream: "hunter2-upstream", smtp: { host: "mail", login: "s3cr3t-login" }, creds: "abc123def", merged: { a: "x", b: "y-secret" }, label: "ok" };
    expect(maskSecretValues(values, schema, redact)).toEqual({
      upstream: "[redacted]",
      smtp: { host: "mail", login: "[redacted]" },
      creds: "[redacted]",
      merged: { a: "x", b: "[redacted]" },
      label: "ok",
    });
    const masked = JSON.stringify(maskSecretValues(values, schema, maskAll));
    for (const secret of ["hunter2-upstream", "s3cr3t-login", "abc123def", "y-secret"]) expect(masked).not.toContain(secret);
    expect(masked).toContain('"label":"ok"');
  });

  test("$ref / $defs, oneOf, prefixItems, tuple items and additionalProperties", () => {
    const schema = {
      $defs: { secretString: { type: "string", format: "password" }, endpoint: { type: "object", properties: { url: {}, token2: {}, pass: { $ref: "#/$defs/secretString" } } } },
      type: "object",
      properties: {
        primary: { $ref: "#/$defs/endpoint" },
        backups: { type: "array", items: { $ref: "#/$defs/endpoint" } },
        pair: { type: "array", prefixItems: [{ type: "string" }, { type: "string", writeOnly: true }] },
        legacyTuple: { type: "array", items: [{ type: "string" }, { "x-secret": true }], additionalItems: { type: "string" } },
        choice: { oneOf: [{ type: "number" }, { type: "object", properties: { v: { format: "password" } } }] },
        byHost: { type: "object", additionalProperties: { $ref: "#/$defs/secretString" } },
        named: { type: "object", properties: { visible: { type: "string" } }, additionalProperties: { format: "password" } },
      },
    };
    const out = maskSecretValues(
      {
        primary: { url: "https://a", token2: "t", pass: "p1" },
        backups: [{ url: "https://b", pass: "p2" }],
        pair: ["user", "pw-value"],
        legacyTuple: ["a", "b-secret", "c"],
        choice: { v: "chosen" },
        byHost: { "relay.example": "h-secret" },
        named: { visible: "shown", extra: "x-secret" },
      },
      schema,
      redact,
    );
    expect(out).toEqual({
      primary: { url: "https://a", token2: "[redacted]", pass: "[redacted]" },
      backups: [{ url: "https://b", pass: "[redacted]" }],
      pair: ["user", "[redacted]"],
      legacyTuple: ["a", "[redacted]", "c"],
      choice: { v: "[redacted]" },
      byHost: { "relay.example": "[redacted]" },
      named: { visible: "shown", extra: "[redacted]" },
    });
  });

  test("recursive / broken refs and hostile keys can't loop or touch prototypes", () => {
    const schema = { $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" }, secretValue: {} } } }, $ref: "#/$defs/node" };
    const deep = { child: { child: { secretValue: "s", child: {} } } };
    expect(maskSecretValues(deep, schema, redact)).toEqual({ child: { child: { secretValue: "[redacted]", child: {} } } });
    expect(maskSecretValues({ a: "x" }, { properties: { a: { $ref: "#/$defs/missing" } } }, redact)).toEqual({ a: "x" });
    expect(maskSecretValues({ a: "x" }, { properties: { a: { $ref: "#/__proto__/x" } } }, redact)).toEqual({ a: "x" });
    const out = maskSecretValues(JSON.parse('{"__proto__": {"password": "p"}}'), undefined, redact) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ password: "[redacted]" });
  });

  test("key names and credential-bearing values without a schema (old redact.test cases)", () => {
    const out = maskSecretValues(
      {
        privkey: "deadbeef",
        smtpPass: "hunter2",
        openaiKey: "sk-123",
        databaseUrl: "postgres://u:p@db/x",
        nested: { list: ["wss://relay.damus.io", `nsec1${"q".repeat(58)}`] },
        maxTokens: 100,
        tokenBucketSize: 5,
        privateRelay: true,
        relayPubkey: "ab".repeat(32),
      },
      undefined,
      redact,
    ) as Record<string, unknown>;
    expect(out).toEqual({
      privkey: "[redacted]",
      smtpPass: "[redacted]",
      openaiKey: "[redacted]",
      databaseUrl: "[redacted]",
      nested: { list: ["wss://relay.damus.io", "[redacted]"] },
      maxTokens: 100,
      tokenBucketSize: 5,
      privateRelay: true,
      relayPubkey: "ab".repeat(32),
    });
  });
});

describe("secret key names, extended", () => {
  test("credential names the matcher used to miss", () => {
    for (const k of ["authValue", "creds", "smtpCreds", "awsCred", "pw", "dbPw", "smtp_pw"]) expect([k, isSecretKeyName(k)]).toEqual([k, true]);
  });
  test("switches and ordinary names stay readable", () => {
    for (const k of ["requireAuth", "authRequired", "authForRead", "authForWrite", "authMode", "nip42Auth", "useAuth", "authors", "author", "authorName", "login", "username", "credits", "pwa", "powDifficulty"])
      expect([k, isSecretKeyName(k)]).toEqual([k, false]);
  });

  test("…Auth keys: masked when the value is a credential, readable when it's a switch", () => {
    for (const k of ["proxyAuth", "upstreamAuth", "httpAuth", "HTTP_AUTH", "uploadAuth", "readAuth"]) expect([k, isAuthSlotName(k)]).toEqual([k, true]);
    for (const k of ["requireAuth", "nip42Auth", "auth", "authMode"]) expect([k, isAuthSlotName(k)]).toEqual([k, false]);
    const out = maskSecretValues(
      {
        uploadAuth: "required", readAuth: "members", writeAuth: "admins", listAuth: "none", deleteAuth: "owner", proxyAuth: "optional",
        upstreamAuth: "user:pass", httpAuth: "Bearer abcdefghijkl", relayAuth: "a8f3k2j9d0s7h6g5x1", nested: { proxyAuth: "alice:hunter2" },
        modeAuth: "authenticated-only", emptyAuth: "", flagAuth: true,
      },
      undefined,
      redact,
    );
    expect(out).toEqual({
      uploadAuth: "required", readAuth: "members", writeAuth: "admins", listAuth: "none", deleteAuth: "owner", proxyAuth: "optional",
      upstreamAuth: "[redacted]", httpAuth: "[redacted]", relayAuth: "[redacted]", nested: { proxyAuth: "[redacted]" },
      modeAuth: "authenticated-only", emptyAuth: "", flagAuth: true,
    });
    // the admin API's viewer masking follows the same rule
    expect(maskSecretValues({ proxyAuth: "user:pass", uploadAuth: "required" }, undefined, maskAll)).toEqual({ proxyAuth: MASK, uploadAuth: "required" });
  });
});
