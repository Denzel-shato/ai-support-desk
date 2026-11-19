import { Suspense } from "react";
import { TicketsSkeleton } from "@/components/tickets/tickets-skeleton";
import { TicketsExplorer } from "@/components/tickets/tickets-explorer";

export default function Page() {
  // The explorer reads ?q= (the header search); that needs a Suspense boundary while prerendering.
  return (
    <Suspense fallback={<TicketsSkeleton />}>
      <TicketsExplorer />
    </Suspense>
  );
}
