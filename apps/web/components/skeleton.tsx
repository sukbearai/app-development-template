"use client";

function classNames(...values: Array<string | undefined | false>) {
  return values.filter(Boolean).join(" ");
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden="true" className={classNames("skeleton-block", className)} />;
}

export function SelectSkeleton({ className }: { className?: string }) {
  return <SkeletonBlock className={classNames("skeleton-select", className)} />;
}

export function TableSkeletonRows({
  rows,
  columns,
  actionColumn = false,
}: {
  rows: number;
  columns: number;
  actionColumn?: boolean;
}) {
  const totalColumns = columns + (actionColumn ? 1 : 0);

  return (
    <>
      {Array.from({ length: Math.max(1, rows) }).map((_, rowIndex) => (
        <tr key={`table-skeleton-${rowIndex}`}>
          {Array.from({ length: totalColumns }).map((__, columnIndex) => (
            <td key={columnIndex}>
              <SkeletonBlock
                className={classNames(
                  "skeleton-table-cell",
                  columnIndex === 0 && "narrow",
                  columnIndex === totalColumns - 1 && actionColumn && "action",
                  columnIndex % 3 === 1 && "wide",
                )}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <SkeletonBlock className="skeleton-card-title" />
      {Array.from({ length: Math.max(1, lines) }).map((_, index) => (
        <SkeletonBlock
          key={index}
          className={index % 2 === 0 ? "skeleton-card-line" : "skeleton-card-line short"}
        />
      ))}
    </div>
  );
}
