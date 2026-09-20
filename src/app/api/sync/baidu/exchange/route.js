import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/sync/baidu/panClient";

export const dynamic = "force-dynamic";

function htmlPage(title, body) {
  return new NextResponse(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;line-height:1.7}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}a{color:#2563eb}</style></head>
<body><h2>${title}</h2>${body}<p><a href="/dashboard">返回 Dashboard</a></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// Finish the oob flow: paste the code Baidu showed after authorization.
// GET /api/sync/baidu/exchange?code=XXXX
export async function GET(request) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return htmlPage(
      "缺少授权码",
      "<p>请先访问 <code>/api/sync/baidu/authorize</code> 完成授权，然后把百度页面显示的授权码附在 URL 后访问本页：<br><code>/api/sync/baidu/exchange?code=授权码</code></p>"
    );
  }
  try {
    const info = await exchangeCode(code);
    return htmlPage(
      "授权成功 ✅",
      `<p>百度网盘同步凭证已保存到本机。定时同步将按配置的周期自动运行。</p><p>scope：<code>${info.scope || "n/a"}</code></p>`
    );
  } catch (error) {
    return htmlPage(
      "授权失败 ❌",
      `<p>${String(error?.message ?? error)}</p><p>请回到 <code>/api/sync/baidu/authorize</code> 重新发起授权（授权码 10 分钟内有效且只能用一次）。</p>`
    );
  }
}
