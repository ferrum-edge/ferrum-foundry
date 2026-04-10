/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – Inline target add/edit form for UpstreamForm      */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import type { UpstreamTarget } from "@/api/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface TargetFormProps {
  initialData?: UpstreamTarget;
  onSubmit: (target: UpstreamTarget) => void;
  onCancel: () => void;
}

/* ================================================================== */
/*  TargetForm                                                         */
/* ================================================================== */

export function TargetForm({ initialData, onSubmit, onCancel }: TargetFormProps) {
  const [host, setHost] = useState(initialData?.host ?? "");
  const [port, setPort] = useState(initialData?.port ?? 80);
  const [weight, setWeight] = useState(initialData?.weight ?? 1);
  const [path, setPath] = useState(initialData?.path ?? "");
  const [tags, setTags] = useState<Record<string, string>>(initialData?.tags ?? {});

  /* -- Tag input state -- */
  const [tagInput, setTagInput] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!host.trim()) errs.host = "Host is required";
    if (!port || port <= 0 || port > 65535) errs.port = "Valid port required (1-65535)";
    if (weight < 0) errs.weight = "Weight must be >= 0";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    const target: UpstreamTarget = {
      host: host.trim(),
      port,
      weight,
      ...(path.trim() && { path: path.trim() }),
      ...(Object.keys(tags).length > 0 && { tags }),
    };

    onSubmit(target);
  };

  /* -- Tag helpers -- */

  const addTag = (raw: string) => {
    const sep = raw.indexOf(":");
    if (sep <= 0) return;
    const key = raw.slice(0, sep).trim();
    const val = raw.slice(sep + 1).trim();
    if (key && val) {
      setTags((prev) => ({ ...prev, [key]: val }));
    }
  };

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
      setTagInput("");
    }
  };

  const handleTagBlur = () => {
    if (tagInput.trim()) {
      addTag(tagInput);
      setTagInput("");
    }
  };

  const removeTag = (key: string) => {
    setTags((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-bg-primary/50 border border-border rounded-lg p-4 space-y-3"
    >
      {/* Row 1: host, port, weight, path */}
      <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr] gap-3">
        <Input
          label="Host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="10.0.0.1"
          error={errors.host}
          required
        />
        <Input
          label="Port"
          type="number"
          value={String(port)}
          onChange={(e) => setPort(Number(e.target.value))}
          placeholder="80"
          error={errors.port}
          required
        />
        <Input
          label="Weight"
          type="number"
          value={String(weight)}
          onChange={(e) => setWeight(Number(e.target.value))}
          placeholder="1"
          error={errors.weight}
        />
        <Input
          label="Path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/optional"
        />
      </div>

      {/* Tags */}
      <div className="flex flex-col gap-1.5">
        <span className="text-text-secondary text-sm font-medium">Tags</span>
        <div className="flex flex-wrap gap-1.5 bg-bg-input border border-border rounded-lg px-3 py-2 focus-within:border-orange focus-within:ring-1 focus-within:ring-orange/30 transition-colors duration-150">
          {Object.entries(tags).map(([k, v]) => (
            <Badge key={k} variant="default">
              <span className="flex items-center gap-1">
                {k}:{v}
                <button
                  type="button"
                  onClick={() => removeTag(k)}
                  className="text-text-muted hover:text-text-primary cursor-pointer"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </Badge>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={handleTagBlur}
            placeholder={Object.keys(tags).length === 0 ? "key:value, press Enter" : ""}
            className="bg-transparent text-text-primary text-sm outline-none flex-1 min-w-[80px] placeholder:text-text-muted"
          />
        </div>
        <p className="text-text-muted text-xs">Enter tags as key:value pairs, press Enter to add</p>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {initialData ? "Update Target" : "Add Target"}
        </Button>
      </div>
    </form>
  );
}
