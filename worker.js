// Cloudflare Worker: Stripe checkout + payment verification + firmware proxy
// Secrets (wrangler secret put): STRIPE_SECRET_KEY, GITHUB_TOKEN (only if firmware repo is private)
// Vars (wrangler.toml): SITE_URL, SITE_PATH, FIRMWARE_OWNER, FIRMWARE_REPO, FIRMWARE_BRANCH

const BOARDS = ["ILI9341", "ST7789"];
const PRICE_SATANG = "19900"; // 199 บาท (ทุกโปรแกรมราคาเดียวกัน)

// รายชื่อโปรแกรมที่เฟลชได้
//   enabled  : true = เปิดให้ซื้อ/เฟลช   false = ยังไม่พร้อม (เร็วๆ นี้)
//   manifest : ไฟล์ manifest.json ของโปรแกรมนั้นใน repo เฟิร์มแวร์
//   prefix   : โฟลเดอร์ของโปรแกรมนั้น (ใช้กันไม่ให้โหลดไฟล์ของโปรแกรมอื่น)
// ภายใน manifest path ของแต่ละไฟล์ต้องมี "/<ILI9341|ST7789>/" อยู่ เหมือนเดิม
const PROJECTS = {
  dashtron: {
    name: "DashTron",
    enabled: true,
    manifest: "firmware-installer/manifest.json",
    prefix: "firmware-installer/",
  },
  setthai: {
    name: "ราคาหุ้นไทย ทองคำ และคริปโต",
    enabled: true,
    manifest: "firmware-test/manifest.json",
    prefix: "firmware-test/",
  },
  medreminder: {
    name: "ระบบเตือนทานยา",
    enabled: true,
    manifest: "firmware-medreminder/manifest.json",
    prefix: "firmware-medreminder/",
  },
  bitkubbot: {
    name: "Bitkub Bot",
    enabled: true,
    manifest: "firmware-bitkubbot/manifest.json",
    prefix: "firmware-bitkubbot/",
  },
  motogauge: {
    name: "เกจมอเตอร์ไซค์",
    enabled: true,
    manifest: "firmware-motogauge/manifest.json",
    prefix: "firmware-motogauge/",
  },
};

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_URL, // e.g. https://yourname.github.io  (no trailing slash/path)
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

async function stripe(env, path, method = "GET", body) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  return res.json();
}

// Fetch a file from the firmware repo (works for public or private repo)
async function fetchFirmware(env, path) {
  const { FIRMWARE_OWNER: o, FIRMWARE_REPO: r, FIRMWARE_BRANCH: b = "main" } = env;
  if (env.GITHUB_TOKEN) {
    return fetch(`https://api.github.com/repos/${o}/${r}/contents/${path}?ref=${b}`, {
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "flash-worker",
      },
    });
  }
  return fetch(`https://raw.githubusercontent.com/${o}/${r}/${b}/${path}`);
}

// คืนค่า { project, board } ที่ล็อกไว้ตอนชำระเงิน ถ้าจ่ายแล้วจริง ไม่งั้นคืน null
// โปรแกรม/ชิปจอ มาจาก metadata ของ Stripe session เสมอ (ไม่เชื่อค่าที่เบราว์เซอร์ส่งมาทีหลัง)
// จึงเปลี่ยนไม่ได้หลังชำระเงิน
async function getPaidSelection(env, sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId || "")) return null;
  const s = await stripe(env, "/checkout/sessions/" + sessionId);
  if (!s || s.payment_status !== "paid") return null;
  const project = s.metadata?.project;
  const board = s.metadata?.board;
  if (!PROJECTS[project] || !BOARDS.includes(board)) return null;
  return { project, board };
}

// Collect every object that has an address + path (robust to manifest layout)
function collectParts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectParts(n, out));
  else if (node && typeof node === "object") {
    if (node.address && node.path) out.push(node);
    else Object.values(node).forEach((n) => collectParts(n, out));
  }
  return out;
}

// ดึงรายการไฟล์เฟิร์มแวร์ของโปรเจ็ค + ชิปจอ จาก manifest ใน repo
// คืนค่า { parts } หรือ { error, status }
async function loadParts(env, project, board) {
  const proj = PROJECTS[project];
  const mf = await fetchFirmware(env, proj.manifest);
  if (!mf.ok) return { error: "manifest not found", status: 502 };
  let data;
  try { data = await mf.json(); } catch { return { error: "manifest invalid", status: 502 }; }
  const parts = collectParts(data)
    .filter((p) => p.path.startsWith(proj.prefix) && p.path.includes(`/${board}/`))
    .map((p) => ({ name: p.name, address: p.address, path: p.path, size: p.size, sha256: p.sha256 }));
  if (!parts.length) return { error: "no parts for board", status: 404 };
  return { parts };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    try {
      // 1) Create Checkout Session (199 THB) — ล็อกโปรแกรม + ชิปจอ ไว้ใน metadata
      if (url.pathname === "/checkout" && request.method === "POST") {
        const { project, board } = await request.json().catch(() => ({}));
        if (!PROJECTS[project] || !PROJECTS[project].enabled) return json(env, { error: "โปรแกรมนี้ยังไม่เปิดให้ติดตั้ง" }, 400);
        if (!BOARDS.includes(board)) return json(env, { error: "bad board" }, 400);

        // กันเก็บเงินโดยไม่มีของส่ง: ต้องมีไฟล์เฟิร์มแวร์ของโปรแกรม+ชิปจอนี้พร้อมก่อน
        const ready = await loadParts(env, project, board);
        if (!ready.parts) {
          return json(env, { error: "ขณะนี้ยังไม่มีไฟล์เฟิร์มแวร์ของโปรแกรมนี้สำหรับชิปจอที่เลือก จึงยังไม่เปิดให้ชำระเงิน (ไม่มีการเรียกเก็บเงิน)" }, 503);
        }

        const s = await stripe(env, "/checkout/sessions", "POST", {
          mode: "payment",
          "line_items[0][price_data][currency]": "thb",
          "line_items[0][price_data][unit_amount]": PRICE_SATANG,
          "line_items[0][price_data][product_data][name]": `Flash Tool - ${PROJECTS[project].name} (${board})`,
          "line_items[0][quantity]": "1",
          "payment_method_types[0]": "card",
          "payment_method_types[1]": "promptpay",
          "metadata[project]": project,
          "metadata[board]": board,
          success_url: env.SITE_URL + (env.SITE_PATH || "/") + "?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: env.SITE_URL + (env.SITE_PATH || "/"),
        });
        if (!s.url) return json(env, { error: s.error?.message || "stripe error" }, 500);
        return json(env, { url: s.url });
      }

      // 2) Verify payment + return what was purchased (ใช้ตอนกลับจากหน้าชำระเงิน)
      if (url.pathname === "/session") {
        const sel = await getPaidSelection(env, url.searchParams.get("session_id"));
        if (!sel) return json(env, { error: "not paid" }, 402);
        return json(env, sel);
      }

      // 3) Return list of parts for the purchased project + board
      if (url.pathname === "/parts") {
        const sel = await getPaidSelection(env, url.searchParams.get("session_id"));
        if (!sel) return json(env, { error: "not paid" }, 402);
        const r = await loadParts(env, sel.project, sel.board);
        if (!r.parts) return json(env, { error: r.error }, r.status);
        return json(env, { parts: r.parts });
      }

      // 4) Stream firmware file (only the purchased project + board)
      if (url.pathname === "/firmware") {
        const sel = await getPaidSelection(env, url.searchParams.get("session_id"));
        if (!sel) return json(env, { error: "not paid" }, 402);
        const proj = PROJECTS[sel.project];

        const path = url.searchParams.get("path") || "";
        const ok =
          path.startsWith(proj.prefix) &&
          !path.includes("..") &&
          path.includes(`/${sel.board}/`);
        if (!ok) return json(env, { error: "bad path" }, 400);

        const f = await fetchFirmware(env, path);
        if (!f.ok) return json(env, { error: "file not found" }, 502);
        return new Response(f.body, {
          headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", ...cors(env) },
        });
      }

      return json(env, { error: "not found" }, 404);
    } catch (e) {
      return json(env, { error: String(e) }, 500);
    }
  },
};
