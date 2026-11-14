import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold [&_svg]:size-3.5",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        ok: "border-ok/40 bg-ok/15 text-ok",
        info: "border-info/40 bg-info/15 text-info",
        caution: "border-caution/40 bg-caution/15 text-caution",
        warning: "border-warning/40 bg-warning/15 text-warning",
        emergency: "border-emergency/50 bg-emergency/20 text-emergency",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
