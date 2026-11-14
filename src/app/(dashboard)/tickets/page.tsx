import { Inbox } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function Page() {
  return (
    <PlaceholderPage
      icon={Inbox}
      title="The full ticket list is coming next"
      description="Filter, sort and open every ticket here once this page is built."
    />
  );
}
