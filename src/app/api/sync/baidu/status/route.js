import { NextResponse } from "next/server";
import {
  getSyncConfig, getTokenStatus, getRemoteFilePath, isConfigured,
} from "@/lib/sync/baidu/panClient";
import { getStateSummary } from "@/lib/sync/baidu/engine";
import { isBaiduSyncStarted } from "@/lib/sync/baidu";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cfg = getSyncConfig();
    return NextResponse.json({
      configured: isConfigured(),
      schedulerStarted: isBaiduSyncStarted(),
      intervalMinutes: Number(process.env.BAIDU_SYNC_INTERVAL_MINUTES) || 30,
      remotePath: getRemoteFilePath(),
      excludeTables: cfg.excludeTables,
      token: getTokenStatus(),
      state: getStateSummary(),
      authorizeUrl: "/api/sync/baidu/authorize",
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "status failed" }, { status: 500 });
  }
}
