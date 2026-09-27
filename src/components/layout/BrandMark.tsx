/* ------------------------------------------------------------------ */
/*  Ferrum Foundry – brand mark                                        */
/*                                                                     */
/*  The emblem is a small square crop of the full illustration         */
/*  (`public/brand-mark-*.png`), shown as a rounded app-icon tile so   */
/*  it reads as intentional on both themes. The name always sits       */
/*  beside it, so the image itself is decorative.                      */
/* ------------------------------------------------------------------ */

const sizes = {
  sm: {
    image: "w-7 h-7 rounded-md",
    name: "text-sm",
    gap: "gap-2.5",
  },
  lg: {
    image: "w-12 h-12 rounded-xl",
    name: "text-lg",
    gap: "gap-3",
  },
} as const;

export function BrandMark({
  size = "sm",
  className = "",
}: {
  size?: keyof typeof sizes;
  className?: string;
}) {
  const style = sizes[size];
  return (
    <span className={`flex min-w-0 items-center ${style.gap} ${className}`}>
      <img
        src="/brand-mark-64.png"
        srcSet="/brand-mark-64.png 1x, /brand-mark-128.png 2x"
        alt=""
        width={size === "lg" ? 48 : 28}
        height={size === "lg" ? 48 : 28}
        className={`${style.image} shrink-0 object-cover ring-1 ring-border`}
      />
      <span className={`truncate font-semibold tracking-tight text-text-primary ${style.name}`}>
        Ferrum Foundry
      </span>
    </span>
  );
}
