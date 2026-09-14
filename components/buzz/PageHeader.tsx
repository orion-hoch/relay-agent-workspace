// Adapted from block/buzz; Apache-2.0. Only the utility import path changed.
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type HeaderProps = {
  /** Optional trailing content (buttons, menus) aligned to the header's end. */
  action?: ReactNode;
  className?: string;
  /** Muted supporting line rendered beneath the title. */
  description?: ReactNode;
  title: ReactNode;
};

/**
 * One per page. Renders the page's single `h1`.
 */
export function PageHeader({
  action,
  className,
  description,
  title,
}: HeaderProps) {
  const copy = (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-base font-normal text-muted-foreground">
          {description}
        </p>
      ) : null}
    </>
  );

  if (action) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-start justify-between gap-4",
          className,
        )}
      >
        <div className="min-w-0 space-y-1">{copy}</div>
        <div className="shrink-0">{action}</div>
      </div>
    );
  }

  return <div className={cn("min-w-0 space-y-1", className)}>{copy}</div>;
}
