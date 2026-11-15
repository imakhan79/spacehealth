import Link from "next/link";

export function Nav({ active }: { active: "status" | "dashboard" }) {
  const link = (href: string, label: string, isActive: boolean) => (
    <Link
      href={href}
      style={{
        color: isActive ? "#e6edf3" : "#8b98a5",
        textDecoration: "none",
        fontWeight: isActive ? 600 : 400,
        borderBottom: isActive ? "2px solid #58a6ff" : "2px solid transparent",
        paddingBottom: 4,
      }}
    >
      {label}
    </Link>
  );
  return (
    <nav style={{ display: "flex", gap: "1.25rem", marginTop: "0.75rem", fontSize: 15 }}>
      {link("/dashboard", "Crew health", active === "dashboard")}
      {link("/", "Uplink status", active === "status")}
    </nav>
  );
}
