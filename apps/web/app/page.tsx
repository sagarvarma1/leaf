"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { loadSession } from "@/lib/session";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    void loadSession().then((s) => {
      if (!s.user) return router.replace("/login");
      try {
        const last = JSON.parse(localStorage.getItem("leaf:last") ?? "null");
        if (last && s.workspaces.some((w) => w.id === last.ws)) return router.replace(`/w/${last.ws}${last.page ? `/${last.page}` : ""}`);
      } catch {}
      router.replace(`/w/${s.workspaces[0]?.id}`);
    });
  }, [router]);
  return <div className="splash">🌿</div>;
}
