import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helpText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helpText, className = "", id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-text-secondary text-sm font-medium"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`w-full min-w-0 bg-bg-input border rounded-lg px-3 py-2 text-text-primary text-sm placeholder:text-text-muted transition-colors duration-150 ${error ? "border-danger focus:border-danger focus:ring-1 focus:ring-danger/30" : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"} ${className}`}
          {...props}
        />
        {error && <p className="text-danger text-xs">{error}</p>}
        {!error && helpText && (
          <p className="text-text-muted text-xs">{helpText}</p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
