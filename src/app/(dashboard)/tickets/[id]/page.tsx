import { Suspense } from "react";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import { TicketDetailSkeleton } from "@/components/tickets/ticket-detail-states";

export default function TicketDetailPage() {
  return (
    <Suspense fallback={<TicketDetailSkeleton />}>
      <TicketDetail />
    </Suspense>
  );
}
