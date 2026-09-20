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

// OAuth redirect target when BAIDU_REDIRECT_URI is registered in the app
// console. Exchanges ?code= and stores the token locally. It never echoes the
// token back — a successful page is all a caller learns. Public by design:
// only a code minted for this very app is worth anything here.
export async function GET(request) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return htmlPage("缺少授权码", "<p>回调 URL 中没有授权码，请重新发起授权。</p>");
  try {
    await exchangeCode(code);
    return htmlPage("授权成功 ✅", "<p>百度网盘同步凭证已保存到本机，定时同步将自动运行。</p>");
  } catch (error) {
    return htmlPage(
      "授权失败 ❌",
      `<p>${String(error?.message ?? error)}</p><p>请重新发起授权（授权码 10 分钟内有效且只能用一次）。</p>`
    );
  }
}
