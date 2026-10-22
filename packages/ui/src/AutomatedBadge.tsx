/** Label shown on every automated answer (FR-014, Constitution III). */
export function AutomatedBadge({ owner }: { owner: string }) {
  return (
    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
      Automated answer on behalf of {owner}
    </span>
  );
}
