import clsx from "clsx";
import type { DisplayStatusDTO } from "@/lib/schemas/dto";

const LABEL: Record<DisplayStatusDTO, string> = {
  not_assessed: "Not assessed",
  developing: "Developing",
  demonstrated: "Demonstrated",
  review_due: "Review due",
};

const GLYPH: Record<DisplayStatusDTO, string> = {
  not_assessed: "○",
  developing: "◐",
  demonstrated: "◆",
  review_due: "↻",
};

export function StatusBadge({ status }: { status: DisplayStatusDTO }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap",
        status === "not_assessed" && "text-muted",
        status === "developing" && "text-link",
        status === "demonstrated" && "text-good",
        status === "review_due" && "text-spark",
      )}
    >
      <span aria-hidden className="text-[0.7rem] leading-none">
        {GLYPH[status]}
      </span>
      {LABEL[status]}
    </span>
  );
}
