import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/processKill";

// Stop the app: kill sibling processes (MITM, tunnels, tray, stray servers) then exit
export async function POST() {
  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
