"use client";
import { useParams } from "next/navigation";
import { SharedPage } from "@/components/SharedPage";

export default function Shared() {
  const params = useParams<{ token: string; slug?: string[] }>();
  return <SharedPage token={params.token} pageId={params.slug?.[0] ?? null} />;
}
