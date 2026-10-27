/**
 * KiotViet Plus – phần "WEB": làm những việc API công khai của KiotViet KHÔNG cho phép,
 * bằng cách dùng chính trang quản lý KiotViet (pinpinfoods.kiotviet.vn/man) đã đăng nhập.
 *
 * Code mở trang KiotViet trong trình duyệt của Javis rồi gọi đúng các hàm mà nút
 * "Đồng ý"/"Lưu" trên giao diện gọi (ProductResource của trang). Không lưu mật khẩu.
 *
 * Cấu hình (biến môi trường, đều tuỳ chọn):
 *   KIOTVIET_RETAILER          tên gian hàng, vd: pinpinfoods  (dùng chung với phần API)
 *   KIOTVIET_WEB_CDP           địa chỉ trình duyệt của Javis, mặc định http://127.0.0.1:9333
 *   KIOTVIET_WEB_USER          tên đăng nhập KiotViet (chủ cửa hàng tự nhập trong cấu hình Javis)
 *   KIOTVIET_WEB_PASSWORD      mật khẩu KiotViet (chủ cửa hàng tự nhập; code chỉ điền vào trang đăng nhập)
 *   KIOTVIET_WEB_COOKIES       (tuỳ chọn) NỘI DUNG cookie KiotViet (dán nguyên JSON xuất từ tiện ích Cookie-Editor)
 *   KIOTVIET_WEB_COOKIES_FILE  hoặc đường dẫn file chứa JSON đó
 *                              – dùng khi trình duyệt của Javis chưa đăng nhập KiotViet
 *   KIOTVIET_CHROME_PATH       đường dẫn Chromium nếu không kết nối được trình duyệt Javis
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RETAILER = process.env.KIOTVIET_RETAILER;
const CDP = process.env.KIOTVIET_WEB_CDP || "http://127.0.0.1:9333";
const COOKIES_FILE = process.env.KIOTVIET_WEB_COOKIES_FILE;
const MAN_URL = () => `https://${RETAILER}.kiotviet.vn/man/#/Products`;

let browser = null;
let context = null;
let page = null;

// ───────────────────────── kết nối trình duyệt ─────────────────────────
function findChromium() {
  if (process.env.KIOTVIET_CHROME_PATH) return process.env.KIOTVIET_CHROME_PATH;
  const roots = ["/data/state/browsers", path.join(os.homedir(), ".cache/ms-playwright")];
  for (const root of roots) {
    try {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, f.name);
          if (f.isDirectory()) stack.push(p);
          else if (/^(chrome|chrome-headless-shell|headless_shell)$/.test(f.name)) return p;
        }
      }
    } catch { /* bỏ qua */ }
  }
  return undefined;
}

function readCookieFile() {
  let text = process.env.KIOTVIET_WEB_COOKIES || "";
  if (!text && COOKIES_FILE) text = fs.readFileSync(COOKIES_FILE, "utf8");
  if (!text.trim()) return [];
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error("KIOTVIET_WEB_COOKIES không phải JSON hợp lệ (hãy dán nguyên nội dung Export → JSON của Cookie-Editor)."); }
  const list = Array.isArray(raw) ? raw : raw.cookies || [];
  const same = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" };
  return list
    .filter((c) => /kiotviet\.vn$/.test(String(c.domain || "").replace(/^\./, "")))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.expirationDate || c.expires || -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: same[String(c.sameSite || "").toLowerCase()] || "Lax",
    }));
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  const { chromium } = await import("playwright-core");
  try {
    browser = await chromium.connectOverCDP(CDP, { timeout: 8000 });
    context = browser.contexts()[0] || (await browser.newContext());
  } catch {
    const executablePath = findChromium();
    if (!executablePath) {
      throw new Error(`Không kết nối được trình duyệt Javis ở ${CDP} và không tìm thấy Chromium. Đặt KIOTVIET_WEB_CDP hoặc KIOTVIET_CHROME_PATH.`);
    }
    const profile = path.join(os.homedir(), ".kiotviet-plus-profile");
    context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, args: ["--no-sandbox"] });
    browser = context.browser() || { isConnected: () => true, close: () => context.close() };
  }
  const cookies = readCookieFile();
  if (cookies.length) await context.addCookies(cookies);
}

async function isReady(p) {
  try {
    return await p.evaluate(() => {
      const ng = window.angular;
      if (!ng) return false;
      if (/#\/login/i.test(location.href)) return false;
      const inj = ng.element(document.body).injector();
      if (!inj || !inj.has("ProductResource")) return false;
      const s = inj.get("kvSession");
      return !!(s && s.user && s.retailer && Array.isArray(s.branchs) && s.branchs.length > 0);
    });
  } catch { return false; }
}

/** Mở (hoặc dùng lại) tab KiotViet; chờ trang tải xong. Trả về { page, ready }. */
async function openKv({ reload = false } = {}) {
  if (!RETAILER) throw new Error("Thiếu KIOTVIET_RETAILER (tên gian hàng).");
  await ensureBrowser();
  if (!reload && page && !page.isClosed() && (await isReady(page))) return { page, ready: true };
  if (!page || page.isClosed()) {
    page = context.pages().find((p) => p.url().includes(`${RETAILER}.kiotviet.vn/man`)) || (await context.newPage());
  }
  if (reload || !page.url().includes(`${RETAILER}.kiotviet.vn/man`)) {
    await page.goto(MAN_URL(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  }
  for (let i = 0; i < 20; i++) {
    if (await isReady(page)) return { page, ready: true };
    if (i >= 4 && /login/i.test(page.url()) && (await page.locator("input[type=password]:visible").count()) > 0) break;
    await page.waitForTimeout(1000);
  }
  return { page, ready: await isReady(page) };
}

/** Trả về tab KiotViet đã đăng nhập và sẵn sàng. */
async function kvPage() {
  let r = await openKv();
  if (!r.ready) r = await openKv({ reload: true });
  if (r.ready) return r.page;
  throw new Error(
    `CHƯA ĐĂNG NHẬP KiotViet trong trình duyệt của Javis (trang: ${r.page.url()}). ` +
    "Hãy gọi kvw_login trước (cần KIOTVIET_WEB_USER và KIOTVIET_WEB_PASSWORD trong cấu hình kết nối).",
  );
}

// ───────────────────────── đăng nhập từ VPS ─────────────────────────
async function visibleText(p, selector) {
  return p.evaluate((sel) => [...document.querySelectorAll(sel)]
    .filter((e) => e.offsetParent !== null && e.innerText && e.innerText.trim())
    .map((e) => e.innerText.trim().replace(/\s+/g, " ").slice(0, 200)), selector).catch(() => []);
}

async function pageMessages(p) {
  const list = await visibleText(p, ".error, .text-danger, .validation-summary-errors, .field-validation-error, .toast, .k-notification, [class*=error], [class*=alert], [role=alert]");
  return [...new Set(list)].filter((t) => t.length > 3).slice(0, 5);
}

/** Chỉ coi là captcha khi có THỬ THÁCH HIỆN RA bắt người bấm/nhập (captcha chạy ngầm thì bỏ qua). */
async function hasCaptcha(p) {
  return p.evaluate(() => {
    const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 60 && r.height > 40 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
    const frames = [...document.querySelectorAll("iframe")].filter((f) => /captcha|recaptcha|hcaptcha|turnstile/i.test(f.src || f.title || ""));
    const challenge = frames.some((f) => shown(f) && !/anchor.*size=invisible/i.test(f.src || ""));
    const imgCaptcha = [...document.querySelectorAll("img[src*=aptcha], input[name*=aptcha], input[id*=aptcha]")].some(shown);
    return challenge || imgCaptcha;
  }).catch(() => false);
}


async function captchaInfo(p) {
  return p.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => {
    const r = f.getBoundingClientRect();
    let host = ""; try { host = new URL(f.src).host + new URL(f.src).pathname.slice(0, 40); } catch {}
    return `${host || f.title || "iframe"} ${Math.round(r.width)}x${Math.round(r.height)}`;
  }).slice(0, 6)).catch(() => []);
}

/** Tìm ô nhập mã OTP đang hiện trên trang. */
async function otpInput(p) {
  const cands = p.locator("input:visible").filter({ hasNot: p.locator("[type=password]") });
  const n = await cands.count();
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i);
    const info = await el.evaluate((e) => ({
      type: e.type, name: (e.name || "") + " " + (e.id || "") + " " + (e.placeholder || "") + " " + (e.getAttribute("autocomplete") || ""),
      max: e.maxLength, val: e.value,
    })).catch(() => null);
    if (!info || ["checkbox", "radio", "hidden", "submit", "button"].includes(info.type)) continue;
    if (/otp|code|mã|ma xac|verify|xác/i.test(info.name) || info.type === "tel" || info.type === "number" || (info.max > 0 && info.max <= 8)) return el;
  }
  return null;
}

async function clickByText(p, re) {
  const btns = p.locator("button:visible, a:visible, input[type=submit]:visible, [role=button]:visible");
  const n = await btns.count();
  for (let i = 0; i < n; i++) {
    const t = ((await btns.nth(i).innerText().catch(() => "")) || (await btns.nth(i).getAttribute("value").catch(() => "")) || "").trim();
    if (re.test(t)) { await btns.nth(i).click(); return t; }
  }
  return null;
}

async function waitAfterSubmit(p, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await p.waitForTimeout(1000);
    if (await isReady(p)) return "ready";
    if (await otpInput(p)) return "otp";
    if (await hasCaptcha(p)) return "captcha";
  }
  return "unknown";
}

async function loginFlow(otp) {
  const { page: p, ready } = await openKv();
  if (ready) return { loggedIn: true, note: "Đã đăng nhập sẵn." };

  // Bước 2: nhập mã OTP
  if (otp) {
    const box = await otpInput(p);
    if (!box) return { loggedIn: false, error: "Không thấy ô nhập mã OTP. Gọi kvw_login (không có otp) để bắt đầu lại.", page: p.url(), messages: await pageMessages(p) };
    await box.fill(String(otp).trim());
    const clicked = await clickByText(p, /xác nhận|xác thực|tiếp tục|đăng nhập|gửi|confirm|verify|ok/i);
    if (!clicked) await box.press("Enter");
    const st = await waitAfterSubmit(p);
    if (st === "ready") return { loggedIn: true, note: "Đăng nhập thành công. Trình duyệt của Javis sẽ giữ phiên này." };
    return { loggedIn: false, state: st, page: p.url(), messages: await pageMessages(p) };
  }

  // Bước 1: tên đăng nhập + mật khẩu
  const user = process.env.KIOTVIET_WEB_USER;
  const pass = process.env.KIOTVIET_WEB_PASSWORD;
  if (!user || !pass) {
    return { loggedIn: false, error: "Thiếu KIOTVIET_WEB_USER hoặc KIOTVIET_WEB_PASSWORD. Chủ cửa hàng tự nhập 2 biến này trong cấu hình kết nối kiotviet-plus của Javis." };
  }
  if (!/login/i.test(p.url())) await p.goto(`https://${RETAILER}.kiotviet.vn/man/#/login`, { waitUntil: "domcontentloaded" }).catch(() => {});
  const pw = p.locator("input[type=password]:visible").first();
  await pw.waitFor({ timeout: 20000 });
  if (await hasCaptcha(p)) return { loggedIn: false, state: "captcha", error: "Trang đăng nhập đang hiện captcha bắt người bấm – không tự vượt qua được. Đợi ít phút rồi thử lại.", detail: await captchaInfo(p) };
  const userBox = p.locator("input:visible:not([type=password]):not([type=checkbox]):not([type=hidden])").first();
  await userBox.fill(user);
  await pw.fill(pass);
  const clicked = await clickByText(p, /^quản lý$/i) || await clickByText(p, /quản lý|đăng nhập|login/i);
  if (!clicked) await pw.press("Enter");
  const st = await waitAfterSubmit(p);
  if (st === "ready") return { loggedIn: true, note: "Đăng nhập thành công." };
  if (st === "otp") {
    return {
      loggedIn: false, needOtp: true,
      next: "KiotViet yêu cầu mã xác thực (OTP). Hỏi chủ cửa hàng mã vừa nhận (SMS/ứng dụng/email), rồi gọi kvw_login với otp=<mã>. Mã thường hết hạn sau vài phút.",
      screen: (await visibleText(p, "h1,h2,h3,label,p")).slice(0, 6),
    };
  }
  if (st === "captcha") return { loggedIn: false, state: "captcha", error: "Sau khi bấm đăng nhập, KiotViet hiện captcha bắt người bấm – không tự vượt qua được.", detail: await captchaInfo(p), messages: await pageMessages(p) };
  return { loggedIn: false, state: st, page: p.url(), messages: await pageMessages(p), screen: (await visibleText(p, "h1,h2,h3,label")).slice(0, 6) };
}

/** Chạy một đoạn code trong trang KiotViet với các dịch vụ của trang. */
async function inPage(fn, arg) {
  const p = await kvPage();
  return p.evaluate(
    async ({ src, arg }) => {
      const inj = window.angular.element(document.body).injector();
      const ctx = {
        P: inj.get("ProductResource"),
        http: inj.get("$http"),
        session: inj.get("kvSession"),
      };
      const errMsg = (e) => (e && e.data && (e.data.ResponseStatus?.Message || e.data.Message)) || (e && e.statusText) || String(e);
      ctx.errMsg = errMsg;
      // eslint-disable-next-line no-new-func
      const f = new Function("ctx", "arg", `return (${src})(ctx, arg);`);
      try { return { ok: true, data: await f(ctx, arg) }; } catch (e) { return { ok: false, error: errMsg(e) }; }
    },
    { src: fn.toString(), arg },
  ).then((r) => { if (!r.ok) throw new Error(`KiotViet báo lỗi: ${r.error}`); return r.data; });
}

// ───────────────────────── các thao tác trong trang ─────────────────────────
// (Các hàm dưới đây chạy BÊN TRONG trang KiotViet – chỉ dùng ctx và arg.)

const pageBranches = (ctx) => (ctx.session.branchs || []).map((b) => ({ Id: b.Id, Name: b.Name, LimitAccess: !!b.LimitAccess }));

const pageListProducts = async (ctx, a) => {
  const body = {
    CategoryIds: JSON.stringify(a.categoryIds || []), AttributeFilter: "[]", BranchId: a.branchId,
    ProductTypes: a.productTypes || "", IsImei: 2, IsFormulas: 2, IsActive: a.isActive, AllowSale: null,
    IsBatchExpireControl: 2, ShelvesIds: "", TrademarkIds: "", StockoutDate: "alltime", CreatedDate: "alltime",
    supplierIds: "", isNewFilter: true, $inlinecount: "allpages", $format: "json",
    $top: a.take, Skip: a.skip, Take: a.take, PageSize: a.take, Page: Math.floor(a.skip / a.take) + 1,
  };
  if (a.keyword) body.ProductKey = a.keyword;
  const r = await ctx.http.post(`/api/branchs/${a.branchId}/masterproducts?format=json&Includes=ProductAttributes`, body);
  return {
    total: r.data.Total,
    rows: (r.data.Data || []).filter((x) => x.Id > 0).map((x) => ({
      Id: x.Id, Code: x.Code, Name: x.FullName || x.Name, CategoryId: x.CategoryId, CategoryName: x.CategoryName,
      ProductType: x.ProductType, BasePrice: x.BasePrice, OnHand: x.OnHand, Unit: x.Unit, RewardPoint: x.RewardPoint,
      Units: (x.UnitList || []).map((u) => ({ Id: u.Id, Code: u.Code, Unit: u.Unit })),
    })),
  };
};

const pageSetActive = async (ctx, a) => {
  const r = await ctx.P.activeproductlist({ SelectedProductList: a.products, IsActive: a.isActive, Branches: a.branches }).$promise;
  return r && r.Message;
};

const pageMoveGroup = async (ctx, a) => {
  const r = await ctx.P.movegroupproductlist({ Ids: a.ids, CategoryId: a.categoryId }).$promise;
  return r && r.Message;
};

const pageUnitList = async (ctx, a) => (await ctx.http.post("/api/products/unitlist", { Ids: a.ids })).data;

const pageSetPoints = async (ctx, a) => {
  const r = await ctx.P.updateproductpointlist({ ProductPointList: a.list }).$promise;
  return r && r.Message;
};

const pageValidateDelete = async (ctx, a) => {
  await ctx.P.validateDeleteProduct({ Ids: a.ids }).$promise;
  return true;
};

const pageDelete = async (ctx, a) => {
  const r = await ctx.P.deleteproductlist({ apiversion: 5 }, { Ids: a.ids }).$promise;
  return { code: r && r.Code, message: r && r.Message };
};

// ───────────────────────── hàm tiện ích phía Node ─────────────────────────
const TYPE = { 1: "combo", 2: "hàng hoá", 3: "dịch vụ" };

async function webBranches() {
  return inPage(pageBranches);
}

async function resolveWebBranches(input) {
  const all = await webBranches();
  if (!input || input.length === 0 || (input.length === 1 && String(input[0]).toLowerCase() === "all")) {
    return { all: true, list: all };
  }
  const list = input.map((x) => {
    const q = String(x).toLowerCase().trim();
    const b = all.find((b) => String(b.Id) === q) || all.find((b) => b.Name.toLowerCase() === q)
      || all.find((b) => b.Name.toLowerCase().includes(q));
    if (!b) throw new Error(`Không thấy chi nhánh "${x}". Có: ${all.map((b) => b.Name).join(", ")}`);
    return b;
  });
  return { all: false, list };
}

/** Tìm hàng hoá theo mã (khớp chính xác), kể cả hàng đang ngừng kinh doanh. */
async function findByCodes(codes) {
  const branches = await webBranches();
  const branchId = branches[0]?.Id;
  const found = new Map();
  for (const code of codes) {
    for (const isActive of [true, false]) {
      if (found.has(code)) break;
      for (const b of [branchId, ...branches.slice(1).map((x) => x.Id)]) {
        const r = await inPage(pageListProducts, { branchId: b, isActive, keyword: code, skip: 0, take: 20 });
        const hit = r.rows.find((x) => x.Code === code) || r.rows.find((x) => x.Units.some((u) => u.Code === code));
        if (hit) { found.set(code, hit); break; }
      }
    }
  }
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) throw new Error(`Không tìm thấy mã hàng: ${missing.join(", ")}`);
  return codes.map((c) => found.get(c));
}

// ───────────────────────── đăng ký công cụ cho Javis ─────────────────────────
export function registerWebTools(server, z, { wrap, requireConfirm, resolveCategoryId }) {
  const codesArg = z.array(z.string()).min(1).describe("Danh sách MÃ HÀNG, vd [\"SP000011\",\"SP000012\"]");
  const branchesArg = z.array(z.union([z.string(), z.number()])).optional()
    .describe('Chi nhánh áp dụng: tên hoặc id, vd ["CN 99"]; bỏ trống hoặc ["all"] = TOÀN HỆ THỐNG');

  server.tool("kvw_login",
    "ĐĂNG NHẬP KiotViet trong trình duyệt của Javis (chỉ cần 1 lần, phiên được giữ). Gọi không có otp để bắt đầu; nếu kết quả needOtp=true thì hỏi chủ cửa hàng mã OTP rồi gọi lại với otp. Mật khẩu lấy từ cấu hình, KHÔNG hỏi mật khẩu trong chat.",
    { otp: z.string().optional().describe("Mã xác thực KiotViet gửi về (nếu được yêu cầu)") },
    wrap(async ({ otp }) => loginFlow(otp)));

  server.tool("kvw_status",
    "Kiểm tra kết nối trang quản lý KiotViet (phần WEB) và liệt kê chi nhánh. Gọi trước khi dùng các công cụ kvw_*.",
    {},
    wrap(async () => {
      const b = await webBranches();
      return { connected: true, retailer: RETAILER, branches: b.map((x) => ({ id: x.Id, name: x.Name })) };
    }));

  server.tool("kvw_product_list",
    "Danh sách hàng hoá TẠI MỘT CHI NHÁNH theo trạng thái ĐANG / NGỪNG kinh doanh (giống bộ lọc 'Trạng thái hàng hoá' trên KiotViet).",
    {
      branch: z.union([z.string(), z.number()]).describe("Tên hoặc id chi nhánh, vd CN 99"),
      status: z.enum(["dang_kinh_doanh", "ngung_kinh_doanh"]).default("dang_kinh_doanh"),
      keyword: z.string().optional().describe("Lọc theo mã hoặc tên"),
      limit: z.number().optional().default(50),
    },
    wrap(async ({ branch, status, keyword, limit }) => {
      const { list } = await resolveWebBranches([branch]);
      const b = list[0];
      const out = [];
      let skip = 0, total = 0;
      do {
        const r = await inPage(pageListProducts, { branchId: b.Id, isActive: status === "dang_kinh_doanh", keyword, skip, take: 100 });
        total = r.total; out.push(...r.rows); skip += 100;
      } while (out.length < limit && skip < total);
      return {
        branch: b.Name, status, total,
        items: out.slice(0, limit).map((x) => ({ code: x.Code, name: x.Name, category: x.CategoryName, type: TYPE[x.ProductType] || x.ProductType, price: x.BasePrice, onHand: x.OnHand })),
      };
    }));

  server.tool("kvw_stop_business",
    "NGỪNG KINH DOANH hàng hoá/dịch vụ – theo TOÀN HỆ THỐNG hoặc theo CHI NHÁNH (hàng sẽ ẩn ở màn hình bán hàng của chi nhánh đó). Tồn kho và lịch sử vẫn giữ; đơn vị quy đổi cũng ngừng theo. Làm lại được bằng kvw_allow_business.",
    { codes: codesArg, branches: branchesArg },
    wrap(async ({ codes, branches }) => {
      const items = await findByCodes(codes);
      const scope = await resolveWebBranches(branches);
      const msg = await inPage(pageSetActive, {
        products: items.map((x) => ({ Id: x.Id, Code: x.Code })), isActive: false,
        branches: scope.all ? [] : scope.list.map((b) => ({ Id: b.Id, Name: b.Name })),
      });
      return { done: "ngừng kinh doanh", scope: scope.all ? "toàn hệ thống" : scope.list.map((b) => b.Name), items: items.map((x) => `${x.Code} ${x.Name}`), kiotviet: msg };
    }));

  server.tool("kvw_allow_business",
    "CHO PHÉP KINH DOANH lại hàng đã ngừng – theo TOÀN HỆ THỐNG hoặc theo CHI NHÁNH.",
    { codes: codesArg, branches: branchesArg },
    wrap(async ({ codes, branches }) => {
      const items = await findByCodes(codes);
      const scope = await resolveWebBranches(branches);
      const msg = await inPage(pageSetActive, {
        products: items.map((x) => ({ Id: x.Id, Code: x.Code })), isActive: true,
        branches: scope.all ? [] : scope.list.map((b) => ({ Id: b.Id, Name: b.Name })),
      });
      return { done: "cho phép kinh doanh", scope: scope.all ? "toàn hệ thống" : scope.list.map((b) => b.Name), items: items.map((x) => `${x.Code} ${x.Name}`), kiotviet: msg };
    }));

  server.tool("kvw_move_group",
    "ĐỔI NHÓM HÀNG cho nhiều hàng hoá cùng lúc – dùng được cho cả DỊCH VỤ (thứ mà API thường báo lỗi 420).",
    { codes: codesArg, toCategory: z.union([z.number(), z.string()]).describe("Nhóm hàng đích: id hoặc tên, vd DỊCH VỤ MỚI") },
    wrap(async ({ codes, toCategory }) => {
      const items = await findByCodes(codes);
      const categoryId = await resolveCategoryId(toCategory);
      const msg = await inPage(pageMoveGroup, { ids: items.map((x) => x.Id), categoryId });
      return { done: "đổi nhóm hàng", toCategoryId: categoryId, items: items.map((x) => `${x.Code} ${x.Name} (từ ${x.CategoryName})`), kiotviet: msg };
    }));

  server.tool("kvw_set_points",
    "THIẾT LẬP ĐIỂM tích luỹ cho nhiều hàng hoá (giống menu ba chấm → Thiết lập điểm).",
    { items: z.array(z.object({ code: z.string(), points: z.number().min(0) })).min(1) },
    wrap(async ({ items }) => {
      const found = await findByCodes(items.map((i) => i.code));
      const units = await inPage(pageUnitList, { ids: found.map((x) => x.Id) });
      const pointOf = new Map(items.map((i) => [i.code, i.points]));
      const list = (units || []).map((u) => {
        const master = found.find((f) => f.Id === u.ProductId || f.Id === u.MasterProductId || f.Code === u.Code || f.Units.some((x) => x.Id === u.ProductId));
        const pts = pointOf.get(u.Code) ?? (master ? pointOf.get(master.Code) : undefined);
        return pts === undefined ? null : { id: u.ProductId, rewardPoint: pts };
      }).filter(Boolean);
      if (!list.length) throw new Error("Không khớp được hàng nào để thiết lập điểm.");
      const msg = await inPage(pageSetPoints, { list });
      return { done: "thiết lập điểm", updated: list.length, kiotviet: msg };
    }));

  server.tool("kvw_delete_products",
    "XOÁ hàng hoá/dịch vụ (giống menu ba chấm → Xoá). KHÔNG HOÀN TÁC. Hàng còn tồn kho sẽ bị KiotViet tạo phiếu kiểm kho về 0. Bắt buộc confirm=true sau khi chủ cửa hàng đồng ý.",
    { codes: codesArg, confirm: z.boolean().optional() },
    wrap(async ({ codes, confirm }) => {
      const items = await findByCodes(codes);
      const withStock = items.filter((x) => x.ProductType === 2 && x.OnHand && x.OnHand !== 0);
      if (confirm !== true) {
        return {
          needConfirm: true,
          willDelete: items.map((x) => `${x.Code} ${x.Name}`),
          warning: withStock.length ? `Còn tồn kho, KiotViet sẽ tạo phiếu kiểm kho đưa về 0: ${withStock.map((x) => `${x.Code} (tồn ${x.OnHand})`).join(", ")}` : undefined,
          next: "Hỏi lại chủ cửa hàng. Nếu đồng ý, gọi lại với confirm=true. Muốn giữ lịch sử thì dùng kvw_stop_business thay vì xoá.",
        };
      }
      requireConfirm(confirm, "hàng hoá");
      const ids = items.map((x) => x.Id);
      await inPage(pageValidateDelete, { ids });
      const r = await inPage(pageDelete, { ids });
      return { done: "xoá", items: items.map((x) => `${x.Code} ${x.Name}`), kiotviet: r.message, partial: String(r.code) === "2" };
    }));
}
