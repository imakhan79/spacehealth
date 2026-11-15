import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: ComponentProps<"div">) {
  // Soft top highlight + depth shadow; status borders passed in className still win (tailwind-merge).
  return (
    <div
      className={cn(
        "rounded-xl border border-border/80 bg-gradient-to-b from-card to-card/80 text-card-foreground shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04),0_10px_30px_-18px_rgb(0_0_0/0.8)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold leading-none", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4 pt-2", className)} {...props} />;
}
