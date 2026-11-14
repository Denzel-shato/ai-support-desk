import { ShieldAlert } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function Page() {
  return (
    <PlaceholderPage
      icon={ShieldAlert}
      title="Escalations queue is coming next"
      description="Tickets the AI flags for human review will be listed here."
    />
  );
}
