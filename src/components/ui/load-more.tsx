import { Button } from "@/components/ui/button";

/** Footer of a paged list: shows the next-page button, its loading state and a retryable error. */
export function LoadMore({
  hasMore,
  loading,
  error,
  scanLimited,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  scanLimited: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore && !error) return null;
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border px-6 py-4 text-center">
      {scanLimited && !error && (
        <p className="text-xs text-muted-foreground">
          Many tickets were checked without finding enough matches. Load more to keep searching.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[#B42318]">
          {error}
        </p>
      )}
      <Button variant="outline" onClick={onLoadMore} disabled={loading}>
        {loading ? "Loading…" : error ? "Try again" : "Load more"}
      </Button>
    </div>
  );
}
