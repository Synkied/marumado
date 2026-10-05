/** A persimmon count on a button's corner: how many things behind it wait for you. Its button says it in words. */
export function CountBadge({ n }: { n: number }) {
  return n > 0 ? (
    <span className="tool__badge" aria-hidden="true">
      {n > 9 ? '9+' : n}
    </span>
  ) : null
}
