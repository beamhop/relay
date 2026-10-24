/* Renders a form from a JSON Schema (as produced by zod's toJSONSchema). Supports string/number/integer/boolean,
 * enums, arrays of primitives, nested objects and nullable unions. Unknown shapes fall back to a JSON editor. */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ListInput } from "@/components/list-input";
import { cn } from "@/lib/utils";

export interface JSONSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  writeOnly?: boolean;
  [k: string]: unknown;
}

type Val = Record<string, unknown>;

/** Collapse `anyOf: [X, {type:"null"}]` into X with nullable flag. */
function normalize(s: JSONSchema): { schema: JSONSchema; nullable: boolean } {
  const union = s.anyOf ?? s.oneOf;
  if (union) {
    const nonNull = union.filter((x) => x.type !== "null");
    if (nonNull.length === 1) return { schema: { ...nonNull[0], description: s.description ?? nonNull[0].description, default: s.default ?? nonNull[0].default }, nullable: nonNull.length < union.length };
    if (nonNull.every((x) => x.const !== undefined)) return { schema: { ...s, type: "string", enum: nonNull.map((x) => x.const) }, nullable: nonNull.length < union.length };
  }
  if (Array.isArray(s.type)) {
    const t = s.type.filter((x) => x !== "null");
    return { schema: { ...s, type: t[0] }, nullable: s.type.includes("null") };
  }
  return { schema: s, nullable: false };
}

const humanize = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
const isSecret = (key: string, s: JSONSchema) => s.writeOnly || s.format === "password" || /secret|password|token|apikey|api_key|privatekey/i.test(key);

export function JsonSchemaForm({ schema, value, onChange, disabled }: { schema: JSONSchema; value: Val; onChange: (v: Val) => void; disabled?: boolean }) {
  const { schema: s } = normalize(schema);
  if (s.type !== "object" || !s.properties) {
    return <RawJson value={value} onChange={(v) => onChange((v ?? {}) as Val)} disabled={disabled} />;
  }
  return <ObjectFields schema={s} value={value ?? {}} onChange={onChange} disabled={disabled} />;
}

function ObjectFields({ schema, value, onChange, disabled, depth = 0 }: { schema: JSONSchema; value: Val; onChange: (v: Val) => void; disabled?: boolean; depth?: number }) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return (
    <div className={cn("space-y-4", depth > 0 && "rounded-lg border p-3")}>
      {props.map(([key, sub]) => (
        <Field
          key={key}
          name={key}
          schema={sub}
          required={required.has(key)}
          value={value[key]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[key];
            else next[key] = v;
            onChange(next);
          }}
          disabled={disabled}
          depth={depth}
        />
      ))}
    </div>
  );
}

function Field({ name, schema: raw, required, value, onChange, disabled, depth }: { name: string; schema: JSONSchema; required: boolean; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; depth: number }) {
  const id = React.useId();
  const { schema: s, nullable } = normalize(raw);
  const label = s.title ?? humanize(name);
  const desc = s.description;
  const header = (
    <Label htmlFor={id} className="gap-1">
      {label}
      {required && !nullable && <span className="text-destructive">*</span>}
    </Label>
  );
  const help = desc ? <p className="text-xs text-muted-foreground">{desc}</p> : null;
  const placeholder = s.default !== undefined && typeof s.default !== "object" ? String(s.default) : undefined;

  if (s.type === "boolean") {
    return (
      <label htmlFor={id} className="flex items-center justify-between gap-4 rounded-lg border p-3">
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">{label}</span>
          {help}
        </span>
        <Switch id={id} checked={value === undefined ? !!s.default : !!value} onCheckedChange={onChange} disabled={disabled} />
      </label>
    );
  }
  if (s.enum) {
    const opts = s.enum.map((e) => String(e));
    return (
      <div className="space-y-2">
        {header}
        <Select
          value={value === undefined || value === null ? (s.default !== undefined ? String(s.default) : "") : String(value)}
          onValueChange={(v) => onChange(v === "__null" ? null : (s.enum!.find((e) => String(e) === v) ?? v))}
          disabled={disabled}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {nullable && <SelectItem value="__null">None</SelectItem>}
            {opts.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {help}
      </div>
    );
  }
  if (s.type === "number" || s.type === "integer") {
    return (
      <div className="space-y-2">
        {header}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          step={s.type === "integer" ? 1 : "any"}
          min={s.minimum}
          max={s.maximum}
          placeholder={placeholder}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? (nullable ? null : undefined) : Number(e.target.value))}
          disabled={disabled}
        />
        {help}
      </div>
    );
  }
  if (s.type === "string") {
    const multiline = (s.maxLength ?? 0) > 200 || s.format === "textarea" || /description|template|message|text$/i.test(name);
    const secret = isSecret(name, s);
    return (
      <div className="space-y-2">
        {header}
        {multiline ? (
          <Textarea id={id} rows={3} value={typeof value === "string" ? value : ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" && nullable ? null : e.target.value)} disabled={disabled} />
        ) : (
          <Input
            id={id}
            type={secret ? "password" : s.format === "uri" || s.format === "url" ? "url" : s.format === "email" ? "email" : "text"}
            autoComplete={secret ? "new-password" : "off"}
            value={typeof value === "string" ? value : ""}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value === "" && nullable ? null : e.target.value)}
            disabled={disabled}
          />
        )}
        {help}
      </div>
    );
  }
  if (s.type === "array" && s.items) {
    const { schema: it } = normalize(s.items);
    const arr = Array.isArray(value) ? value : [];
    if (it.enum) {
      const opts = it.enum;
      return (
        <div className="space-y-2">
          {header}
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {opts.map((o) => (
              <label key={String(o)} className="flex items-center gap-2 text-sm">
                <Checkbox checked={arr.includes(o)} onCheckedChange={(v) => onChange(v === true ? [...arr, o] : arr.filter((x) => x !== o))} disabled={disabled} />
                {String(o)}
              </label>
            ))}
          </div>
          {help}
        </div>
      );
    }
    if (it.type === "string" || it.type === "number" || it.type === "integer") {
      return (
        <div className="space-y-2">
          {header}
          <ListInput id={id} numeric={it.type !== "string"} value={arr as (string | number)[]} onChange={onChange} placeholder="Type and press Enter" />
          {help}
        </div>
      );
    }
  }
  if (s.type === "object" && s.properties) {
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{label}</legend>
        {help}
        <ObjectFields schema={s} value={(value as Val) ?? {}} onChange={onChange} disabled={disabled} depth={depth + 1} />
      </fieldset>
    );
  }
  return (
    <div className="space-y-2">
      {header}
      <RawJson value={value} onChange={onChange} disabled={disabled} />
      {help}
    </div>
  );
}

function RawJson({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = React.useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = React.useState<string>();
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // the value this editor last produced: anything else arriving (Discard, a refetch after save, another plugin)
  // replaces the text instead of leaving stale JSON in the box
  const emitted = React.useRef(value);
  if (value !== emitted.current) {
    emitted.current = value;
    setText(JSON.stringify(value ?? null, null, 2));
    setErr(undefined);
  }
  // invalid JSON blocks the form's submit (native validation), so Save can't send the last valid draft instead
  React.useEffect(() => ref.current?.setCustomValidity(err ? `Invalid JSON: ${err}` : ""), [err]);
  return (
    <div className="space-y-1">
      <Textarea
        ref={ref}
        rows={6}
        className="font-mono text-xs"
        spellCheck={false}
        value={text}
        disabled={disabled}
        aria-invalid={!!err}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            emitted.current = v;
            onChange(v);
            setErr(undefined);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
