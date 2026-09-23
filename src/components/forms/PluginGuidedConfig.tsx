/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – guided plugin configuration fields                */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  fieldPath,
  readGuidedConfig,
  validateGuidedConfig,
  writeGuidedConfig,
  type FieldIssue,
  type FieldState,
  type GuidedValues,
  type JsonObject,
} from "@/lib/pluginGuidedConfig";
import type { GuidedField, GuidedSection, PluginGuidedSchema } from "@/lib/pluginSchemas";

export interface PluginGuidedConfigProps {
  schema: PluginGuidedSchema;
  /** The configuration as JSON. Guided edits are written back through this. */
  configJson: string;
  onChange: (nextConfigJson: string) => void;
  onIssuesChange: (issues: FieldIssue[]) => void;
  readOnly?: boolean;
}

/**
 * Labelled controls for the fields a plugin's schema describes.
 *
 * The JSON string stays the single source of truth for submission: every edit
 * here is written straight back through `writeGuidedConfig`, which copies the
 * original configuration and touches only the modelled keys. A field the
 * operator has not set stays absent — omission is a value to the gateway's
 * full-replacement admission, and the control says what omitting it means
 * rather than quietly materialising a default.
 */
export function PluginGuidedConfig({
  schema,
  configJson,
  onChange,
  onIssuesChange,
  readOnly = false,
}: PluginGuidedConfigProps) {
  const parsed = useMemo<JsonObject>(() => {
    try {
      const value = JSON.parse(configJson) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonObject)
        : {};
    } catch {
      return {};
    }
  }, [configJson]);

  // The configuration as it was when this view opened. Unmodelled keys are
  // carried from here, so a guided edit can never strip one.
  const originalRef = useRef<JsonObject>(parsed);
  const [values, setValues] = useState<GuidedValues>(() =>
    readGuidedConfig(schema, parsed),
  );
  const seededRef = useRef<GuidedValues>(values);

  const currentConfig = useMemo(
    () => writeGuidedConfig(schema, originalRef.current, values, seededRef.current),
    [schema, values],
  );
  const issues = useMemo(
    () => validateGuidedConfig(schema, values, currentConfig, seededRef.current),
    [schema, values, currentConfig],
  );

  const reportRef = useRef(onIssuesChange);
  reportRef.current = onIssuesChange;
  useEffect(() => {
    reportRef.current(issues);
  }, [issues]);

  const update = (path: string, next: FieldState) => {
    if (readOnly) return;
    const nextValues = { ...values, [path]: next };
    setValues(nextValues);
    onChange(
      JSON.stringify(
        writeGuidedConfig(schema, originalRef.current, nextValues, seededRef.current),
        null,
        2,
      ),
    );
  };

  const issueFor = (path: string) => issues.find((issue) => issue.path === path)?.message;

  return (
    <div className="space-y-6">
      {schema.sections.map((section) => (
        <SectionFields
          key={`${section.title}:${section.path}`}
          section={section}
          values={values}
          readOnly={readOnly}
          issueFor={issueFor}
          onUpdate={update}
        />
      ))}
    </div>
  );
}

function SectionFields({
  section,
  values,
  readOnly,
  issueFor,
  onUpdate,
}: {
  section: GuidedSection;
  values: GuidedValues;
  readOnly: boolean;
  issueFor: (path: string) => string | undefined;
  onUpdate: (path: string, next: FieldState) => void;
}) {
  return (
    <section>
      <h4 className="text-sm font-semibold text-text-primary">{section.title}</h4>
      {section.description && (
        <p className="text-xs text-text-muted mt-1">{section.description}</p>
      )}
      <div className="mt-3 space-y-5">
        {section.fields.map((field) => {
          const path = fieldPath(section, field);
          const state = values[path];
          if (!state) return null;
          return (
            <FieldControl
              key={path}
              field={field}
              path={path}
              state={state}
              readOnly={readOnly}
              error={issueFor(path)}
              onUpdate={onUpdate}
            />
          );
        })}
      </div>
    </section>
  );
}

function FieldControl({
  field,
  path,
  state,
  readOnly,
  error,
  onUpdate,
}: {
  field: GuidedField;
  path: string;
  state: FieldState;
  readOnly: boolean;
  error?: string;
  onUpdate: (path: string, next: FieldState) => void;
}) {
  const controlId = `guided-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const errorId = `${controlId}-error`;
  const noteId = `${controlId}-note`;
  const describedBy = [error ? errorId : null, field.prerequisite ? noteId : null]
    .filter(Boolean)
    .join(" ");

  const setPresence = (present: boolean) =>
    onUpdate(path, { ...state, present, checked: present ? state.checked ?? false : state.checked });

  let control: ReactNode;
  if (!state.present) {
    control = (
      <p className="text-sm text-text-muted">
        Not set
        {field.omissionMeans ? (
          <>
            {" "}
            &mdash; the gateway uses{" "}
            <span className="text-text-secondary">{field.omissionMeans}</span>
          </>
        ) : null}
      </p>
    );
  } else if (field.kind === "boolean") {
    control = (
      <label className="inline-flex items-center gap-2 cursor-pointer select-none has-[:disabled]:cursor-not-allowed">
        <input
          id={controlId}
          type="checkbox"
          disabled={readOnly}
          checked={state.checked === true}
          onChange={(event) =>
            onUpdate(path, {
              ...state,
              text: String(event.target.checked),
              checked: event.target.checked,
            })
          }
          className="w-4 h-4 rounded border-border bg-bg-input text-orange accent-orange cursor-pointer disabled:opacity-60"
        />
        <span className="text-sm text-text-secondary">
          {state.checked === true ? "Enabled" : "Disabled"}
        </span>
      </label>
    );
  } else if (field.kind === "enum") {
    control = (
      <Select
        value={state.text}
        onValueChange={(value) => onUpdate(path, { ...state, text: value })}
        options={(field.enumValues ?? []).map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        placeholder="Select…"
        disabled={readOnly}
      />
    );
  } else if (field.kind === "stringList") {
    control = (
      <textarea
        id={controlId}
        aria-label={field.label}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        disabled={readOnly}
        value={state.text}
        onChange={(event) => onUpdate(path, { ...state, text: event.target.value })}
        rows={Math.min(8, Math.max(3, state.text.split("\n").length + 1))}
        spellCheck={false}
        className={`w-full bg-bg-input border rounded-lg px-3 py-2 text-text-primary text-sm font-mono resize-y disabled:opacity-60 ${
          error
            ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30"
            : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"
        }`}
      />
    );
  } else {
    control = (
      <Input
        id={controlId}
        type={field.kind === "integer" ? "number" : "text"}
        aria-label={field.label}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        disabled={readOnly}
        value={state.text}
        onChange={(event) => onUpdate(path, { ...state, text: event.target.value })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={field.kind === "enum" ? undefined : controlId}
          className="text-text-secondary text-sm font-medium"
        >
          {field.label}
          {field.required && <span className="text-danger ml-1">*</span>}
        </label>
        {!field.required && !readOnly && (
          <button
            type="button"
            onClick={() => setPresence(!state.present)}
            className="text-xs text-orange hover:text-orange-light transition-colors"
          >
            {state.present ? "Omit this field" : "Set a value"}
          </button>
        )}
      </div>

      {control}

      <p className="text-text-muted text-xs">{field.description}</p>

      {field.kind === "stringList" && state.present && (
        <p className="text-text-muted text-xs">One entry per line.</p>
      )}

      {field.secret && state.present && (
        <p className="text-text-muted text-xs">
          Stored on the gateway and never displayed here. Leave blank to keep the
          existing value; type a new one to replace it.
        </p>
      )}

      {field.prerequisite && (
        <p id={noteId} className="text-warning text-xs">
          Deployment prerequisite (Foundry cannot confirm it): {field.prerequisite}
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
