/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from "react";
import type { Control } from "react-hook-form";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ListInput } from "@/components/list-input";
import { cn } from "@/lib/utils";

type Base = { control: Control<any>; name: string; label: React.ReactNode; description?: React.ReactNode; className?: string; disabled?: boolean };

export function TextField({ multiline, placeholder, ...p }: Base & { multiline?: boolean; placeholder?: string }) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => (
        <FormItem className={p.className}>
          <FormLabel>{p.label}</FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea {...field} value={field.value ?? ""} rows={3} placeholder={placeholder} disabled={p.disabled} />
            ) : (
              <Input {...field} value={field.value ?? ""} placeholder={placeholder} disabled={p.disabled} />
            )}
          </FormControl>
          {p.description && <FormDescription>{p.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function NumberField({ placeholder, min, step, suffix, optional, ...p }: Base & { placeholder?: string; min?: number; step?: number; suffix?: string; optional?: boolean }) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => (
        <FormItem className={p.className}>
          <FormLabel>{p.label}</FormLabel>
          <div className="relative">
            <FormControl>
              <Input
                type="number"
                inputMode="decimal"
                min={min}
                step={step ?? "any"}
                placeholder={placeholder}
                disabled={p.disabled}
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value === "" ? (optional ? undefined : 0) : Number(e.target.value))}
                className={cn(suffix && "pr-14")}
              />
            </FormControl>
            {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
          </div>
          {p.description && <FormDescription>{p.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;
type Unit = keyof typeof UNITS;
const pickUnit = (n: number): Unit => (n >= UNITS.TB && n % UNITS.TB === 0 ? "TB" : n >= UNITS.GB && n % UNITS.GB === 0 ? "GB" : n >= UNITS.MB ? "MB" : "KB");

export function BytesField(p: Base & { zeroLabel?: string }) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => <BytesInner field={field} {...p} />}
    />
  );
}
function BytesInner({ field, ...p }: Base & { field: { value: number; onChange: (v: number) => void; name: string; onBlur: () => void }; zeroLabel?: string }) {
  const [unit, setUnit] = React.useState<Unit>(() => pickUnit(field.value || UNITS.MB));
  const shown = field.value ? +(field.value / UNITS[unit]).toFixed(3) : field.value === 0 ? 0 : "";
  return (
    <FormItem className={p.className}>
      <FormLabel>{p.label}</FormLabel>
      <div className="flex gap-2">
        <FormControl>
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            name={field.name}
            onBlur={field.onBlur}
            disabled={p.disabled}
            value={shown}
            onChange={(e) => field.onChange(e.target.value === "" ? 0 : Math.round(Number(e.target.value) * UNITS[unit]))}
          />
        </FormControl>
        <Select value={unit} onValueChange={(u) => setUnit(u as Unit)} disabled={p.disabled}>
          <SelectTrigger className="w-24 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(UNITS).map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(p.description || (p.zeroLabel && field.value === 0)) && <FormDescription>{field.value === 0 && p.zeroLabel ? p.zeroLabel : p.description}</FormDescription>}
      <FormMessage />
    </FormItem>
  );
}

export function SwitchField(p: Base) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => (
        <FormItem className={cn("flex items-center justify-between gap-4 rounded-lg border p-3", p.className)}>
          <div className="space-y-0.5">
            <FormLabel className="text-sm">{p.label}</FormLabel>
            {p.description && <FormDescription className="text-xs">{p.description}</FormDescription>}
          </div>
          <FormControl>
            <Switch checked={!!field.value} onCheckedChange={field.onChange} disabled={p.disabled} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

export function SelectField({ options, ...p }: Base & { options: { value: string; label: React.ReactNode; hint?: string }[] }) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => (
        <FormItem className={p.className}>
          <FormLabel>{p.label}</FormLabel>
          <Select value={field.value} onValueChange={field.onChange} disabled={p.disabled}>
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                  {o.hint && <span className="text-muted-foreground"> — {o.hint}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {p.description && <FormDescription>{p.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function ListField({ numeric, placeholder, format, validate, ...p }: Base & { numeric?: boolean; placeholder?: string; format?: (v: any) => React.ReactNode; validate?: (raw: string) => string | undefined }) {
  return (
    <FormField
      control={p.control}
      name={p.name}
      render={({ field }) => (
        <FormItem className={p.className}>
          <FormLabel>{p.label}</FormLabel>
          <FormControl>
            <ListInput numeric={numeric} value={field.value ?? []} onChange={field.onChange} placeholder={placeholder} format={format} validate={validate} />
          </FormControl>
          {p.description && <FormDescription>{p.description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
