import { NextResponse } from "next/server";
import { runBaiduSyncTick } from "@/lib/sync/baidu";

export const dynamic = "force-dynamic";

// Manual "sync now". Auth is enforced by the global dashboard guard
// (session or x-9r-cli-token).
export async function POST() {
  try {
    const result = await runBaiduSyncTick();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ status: "error", error: error?.message || "trigger failed" }, { status: 500 });
  }
}
