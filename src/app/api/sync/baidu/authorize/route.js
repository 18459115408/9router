import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/sync/baidu/panClient";

export const dynamic = "force-dynamic";

// Redirects to the Baidu authorization page. Without a configured redirect URI
// this uses "oob": after confirming, Baidu shows the authorization code on the
// page — paste it into /api/sync/baidu/exchange?code=... to finish.
export async function GET() {
  try {
    return NextResponse.redirect(buildAuthorizeUrl());
  } catch (error) {
    return NextResponse.json({ error: error?.message || "authorize failed" }, { status: 400 });
  }
}
