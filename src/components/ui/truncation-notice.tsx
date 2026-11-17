import { AlertTriangle } from "lucide-react";

/** Shown when the server hit its safety cap and the list on screen is incomplete. */
export function TruncationNotice({ noun, limit }: { noun: string; limit: number }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-[#EBD9A8] bg-[#FDF3DC] px-3 py-2 text-[13px] text-[#8A5A00]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Only the first {limit.toLocaleString("en-US")} {noun} are shown, so counts and lists
        here are incomplete. Pagination is needed before this data set grows further.
      </span>
    </div>
  );
}
