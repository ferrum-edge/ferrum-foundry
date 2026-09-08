import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

export interface CollapsibleSectionConfig {
  id: string;
  errorKeys: readonly string[];
}

export function countValidationErrors(errors: Record<string, string>): number {
  return Object.keys(errors).length;
}

export function validationSummaryMessage(count: number): string {
  return `Fix ${count} validation error${count === 1 ? "" : "s"} above`;
}

export function sectionsWithErrors(
  errors: Record<string, string>,
  sections: readonly CollapsibleSectionConfig[],
): string[] {
  const errorKeys = new Set(Object.keys(errors));
  return sections
    .filter((section) => section.errorKeys.some((key) => errorKeys.has(key)))
    .map((section) => section.id);
}

export function focusFirstInvalidField(form: HTMLFormElement): void {
  const selector = [
    'input[aria-invalid="true"]',
    'textarea[aria-invalid="true"]',
    '[role="combobox"][aria-invalid="true"]',
  ].join(", ");
  const first = form.querySelector<HTMLElement>(selector);
  if (!first) return;
  first.focus();
  first.scrollIntoView({ block: "nearest" });
}

function scheduleFocusFirstInvalid(form: HTMLFormElement | null): void {
  if (!form) return;
  requestAnimationFrame(() => {
    focusFirstInvalidField(form);
  });
}

export function reportValidationFailure(
  errors: Record<string, string>,
  options: {
    form: HTMLFormElement | null;
    sections?: readonly CollapsibleSectionConfig[];
    setSectionState?: Dispatch<SetStateAction<Record<string, boolean>>>;
    setShowSummary: (show: boolean) => void;
    setErrorCount: (count: number) => void;
  },
): void {
  const count = countValidationErrors(errors);
  options.setErrorCount(count);
  options.setShowSummary(count > 0);
  if (options.sections && options.setSectionState && count > 0) {
    const toExpand = sectionsWithErrors(errors, options.sections);
    options.setSectionState((previous) => {
      const next = { ...previous };
      for (const id of toExpand) {
        next[id] = true;
      }
      return next;
    });
  }
  scheduleFocusFirstInvalid(options.form);
}

export function useCollapsibleFormValidation(
  sections: readonly CollapsibleSectionConfig[],
) {
  const [sectionState, setSectionState] = useState<Record<string, boolean>>({});
  const [showSummary, setShowSummary] = useState(false);
  const [errorCount, setErrorCount] = useState(0);

  const sectionProps = useCallback(
    (id: string, defaultOpen = false) => ({
      open: sectionState[id] ?? defaultOpen,
      onOpenChange: (open: boolean) =>
        setSectionState((previous) => ({ ...previous, [id]: open })),
    }),
    [sectionState],
  );

  const onValidationFailed = useCallback(
    (errors: Record<string, string>, form: HTMLFormElement | null) => {
      reportValidationFailure(errors, {
        form,
        sections,
        setSectionState,
        setShowSummary,
        setErrorCount,
      });
    },
    [sections],
  );

  const clearValidationSummary = useCallback(() => {
    setShowSummary(false);
    setErrorCount(0);
  }, []);

  return {
    sectionProps,
    onValidationFailed,
    showSummary,
    errorCount,
    clearValidationSummary,
  };
}

export function useFormValidationSummary() {
  const [showSummary, setShowSummary] = useState(false);
  const [errorCount, setErrorCount] = useState(0);

  const onValidationFailed = useCallback(
    (errors: Record<string, string>, form: HTMLFormElement | null) => {
      reportValidationFailure(errors, {
        form,
        setShowSummary,
        setErrorCount,
      });
    },
    [],
  );

  const clearValidationSummary = useCallback(() => {
    setShowSummary(false);
    setErrorCount(0);
  }, []);

  return {
    onValidationFailed,
    showSummary,
    errorCount,
    clearValidationSummary,
  };
}
