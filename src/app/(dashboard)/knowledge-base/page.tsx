import { BookOpen } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function Page() {
  return (
    <PlaceholderPage
      icon={BookOpen}
      title="Knowledge base is coming next"
      description="Articles the AI checks before drafting a reply will be managed here."
    />
  );
}
