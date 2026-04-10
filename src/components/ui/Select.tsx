import * as SelectPrimitive from "@radix-ui/react-select";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  label,
  error,
  disabled,
}: SelectProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label && (
        <span className="text-text-secondary text-sm font-medium">{label}</span>
      )}
      <SelectPrimitive.Root
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          className={`inline-flex w-full min-w-0 items-center justify-between bg-bg-input border rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${error ? "border-danger" : "border-border focus:border-orange focus:ring-1 focus:ring-orange/30"} ${value ? "text-text-primary" : "text-text-muted"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <SelectPrimitive.Value className="truncate" placeholder={placeholder} />
          <SelectPrimitive.Icon className="ml-2 shrink-0 text-text-muted">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M3 4.5L6 7.5L9 4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>

        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            className="z-50 min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] bg-bg-card border border-border rounded-lg shadow-xl overflow-hidden"
            position="popper"
            sideOffset={4}
          >
            <SelectPrimitive.Viewport className="p-1 max-h-[min(var(--radix-select-content-available-height),20rem)]">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className="relative flex min-w-0 items-center px-3 py-2 text-sm text-text-primary rounded-md cursor-pointer select-none outline-none data-[highlighted]:bg-bg-card-hover"
                >
                  <SelectPrimitive.ItemText>
                    <span className="block truncate">{option.label}</span>
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}
