/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – free-text tag list input                          */
/* ------------------------------------------------------------------ */

import { useId, useState, type KeyboardEvent } from "react";
import { Badge, type BadgeProps } from "@/components/ui/Badge";

export interface TagInputProps {
  label?: string;
  values: (string | number)[];
  onChange: (values: (string | number)[]) => void;
  placeholder?: string;
  helpText?: string;
  /** Keep only entries that parse as numbers, stored as numbers. */
  parseAsNumber?: boolean;
  variant?: BadgeProps["variant"];
}

/**
 * Type and press Enter (or a comma) to add a tag; Backspace on an empty
 * field removes the last one. The label names the text field and each
 * remove button names its tag, so both are reachable by assistive tech.
 */
export function TagInput({
  label,
  values,
  onChange,
  placeholder = "Type and press Enter",
  helpText,
  parseAsNumber = false,
  variant = "default",
}: TagInputProps) {
  const [input, setInput] = useState("");
  const inputId = useId();
  const helpId = useId();

  const addTags = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const newValues = parts
      .map((p) => (parseAsNumber ? Number(p) : p))
      .filter((v) => {
        if (parseAsNumber && isNaN(v as number)) return false;
        return !values.includes(v);
      });
    if (newValues.length > 0) {
      onChange([...values, ...newValues]);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(input);
      setInput("");
    }
    if (e.key === "Backspace" && input === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const handleBlur = () => {
    if (input.trim()) {
      addTags(input);
      setInput("");
    }
  };

  const removeTag = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-text-secondary text-sm font-medium">
          {label}
        </label>
      )}
      <div className="flex flex-wrap gap-1.5 bg-bg-input border border-border rounded-lg px-3 py-2 focus-within:border-orange focus-within:ring-1 focus-within:ring-orange/30 transition-colors duration-150">
        {values.map((v, i) => (
          <Badge key={`${v}-${i}`} variant={variant}>
            <span className="flex items-center gap-1">
              {String(v)}
              <button
                type="button"
                onClick={() => removeTag(i)}
                aria-label={`Remove ${String(v)}`}
                className="text-text-muted hover:text-text-primary cursor-pointer"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </Badge>
        ))}
        <input
          id={inputId}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={values.length === 0 ? placeholder : ""}
          aria-describedby={helpText ? helpId : undefined}
          className="bg-transparent text-text-primary text-sm outline-none flex-1 min-w-[80px] placeholder:text-text-muted"
        />
      </div>
      {helpText && <p id={helpId} className="text-text-muted text-xs">{helpText}</p>}
    </div>
  );
}
