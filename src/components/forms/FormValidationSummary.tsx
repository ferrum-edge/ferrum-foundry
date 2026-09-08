import { validationSummaryMessage } from "@/lib/collapsedFormValidation";

interface FormValidationSummaryProps {
  count: number;
}

export function FormValidationSummary({ count }: FormValidationSummaryProps) {
  if (count <= 0) return null;
  return (
    <p role="alert" className="text-danger text-sm">
      {validationSummaryMessage(count)}
    </p>
  );
}
