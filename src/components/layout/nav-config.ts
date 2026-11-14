import {
  BookOpen,
  Inbox,
  LayoutDashboard,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Title shown in the header. */
  title: string;
}

export const navItems: NavItem[] = [
  { label: "Overview", href: "/", icon: LayoutDashboard, title: "Overview" },
  { label: "All Tickets", href: "/tickets", icon: Inbox, title: "All tickets" },
  {
    label: "Escalations",
    href: "/escalations",
    icon: ShieldAlert,
    title: "Escalations",
  },
  {
    label: "Knowledge Base",
    href: "/knowledge-base",
    icon: BookOpen,
    title: "Knowledge base",
  },
  { label: "Settings", href: "/settings", icon: Settings, title: "Settings" },
];

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
