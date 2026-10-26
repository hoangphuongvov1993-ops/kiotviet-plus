#!/usr/bin/env node
/**
 * KiotViet Plus – MCP server bổ sung cho Javis.
 * Lấp các chức năng kết nối KiotViet gốc còn thiếu:
 *   1. Thêm/sửa hàng hoá kèm TỒN KHO + GIÁ VỐN theo CHI NHÁNH, mã vạch, ảnh, đơn vị quy đổi
 *   2. Khách hàng: thêm, sửa, xoá, phân loại (cá nhân/công ty, nhóm khách)
 *   3. Nhóm hàng: thêm, sửa, xoá
 *   4. Báo cáo lợi nhuận theo ngày (mặc định hôm nay)
 *
 * Biến môi trường (giống kết nối KiotViet gốc):
 *   KIOTVIET_CLIENT_ID, KIOTVIET_CLIENT_SECRET, KIOTVIET_RETAILER
 *   KIOTVIET_BRANCH_ID (tuỳ chọn – chi nhánh mặc định)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.KIOTVIET_BASE_URL || "https://public.kiotapi.com").replace(/\/$/, "");
const TOKEN_URL = process.env.KIOTVIET_TOKEN_URL || "https://id.kiotviet.vn/connect/token";
const CLIENT_ID = process.env.KIOTVIET_CLIENT_ID;
const CLIENT_SECRET = process.env.KIOTVIET_CLIENT_SECRET;
const RETAILER = process.env.KIOTVIET_RETAILER;
const TZ = "Asia/Ho_Chi_Minh";

// ───────────────────────── HTTP ─────────────────────────
let token = null;
let tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  if (!CLIENT_ID || !CLIENT_SECRET || !RETAILER) {
    throw new Error("Thiếu KIOTVIET_CLIENT_ID / KIOTVIET_CLIENT_SECRET / KIOTVIET_RETAILER");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scopes: "PublicApi.Access",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Lấy token KiotViet thất bại (${r.status}): ${j.error_description || j.error || ""}`);
  }
  token = j.access_token;
  tokenExp = Date.now() + ((j.expires_in || 3600) - 120) * 1000;
  return token;
}

async function kv(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      method,
      headers: {
        Retailer: RETAILER,
        Authorization: `Bearer ${await getToken()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && attempt === 0) { token = null; continue; }
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) {
      const msg = data?.responseStatus?.message || data?.message || text.slice(0, 500);
      throw new Error(`KiotViet ${method} ${path} lỗi ${r.status}: ${msg}`);
    }
    return data;
  }
}

async function listAll(path, query = {}, max = 5000) {
  const out = [];
  let currentItem = 0;
  while (out.length < max) {
    const res = await kv("GET", path, { query: { ...query, pageSize: 100, currentItem } });
    const rows = res.data || [];
    out.push(...rows);
    currentItem += rows.length;
    if (rows.length < 100 || currentItem >= (res.total ?? 0)) break;
  }
  return out;
}

// ───────────────────────── tiện ích ─────────────────────────
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

let branchCache = null;
async function branches() {
  if (!branchCache) branchCache = (await kv("GET", "/branches", { query: { pageSize: 100 } })).data || [];
  return branchCache;
}
async function resolveBranchIds(input) {
  const all = await branches();
  if (!input || input.length === 0) {
    const def = Number(process.env.KIOTVIET_BRANCH_ID) || all[0]?.id;
    if (!def) throw new Error("Không tìm thấy chi nhánh nào.");
    return [def];
  }
  if (input.length === 1 && String(input[0]).toLowerCase() === "all") return all.map((b) => b.id);
  return input.map((x) => {
    if (/^\d+$/.test(String(x))) return Number(x);
    const b = all.find((b) => b.branchName?.toLowerCase().includes(String(x).toLowerCase()));
    if (!b) throw new Error(`Không tìm thấy chi nhánh "${x}". Có: ${all.map((b) => `${b.id}:${b.branchName}`).join(", ")}`);
    return b.id;
  });
}

function vnDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function requireConfirm(confirm, what) {
  if (confirm !== true) {
    throw new Error(`Thao tác xoá ${what} không thể hoàn tác. Hãy hỏi lại chủ cửa hàng, rồi gọi lại với confirm=true.`);
  }
}

const branchArg = z.array(z.union([z.string(), z.number()])).optional()
  .describe('Chi nhánh: danh sách id hoặc tên chi nhánh; ["all"] = tất cả chi nhánh; bỏ trống = chi nhánh mặc định');

// ───────────────────────── server ─────────────────────────
const server = new McpServer({ name: "kiotviet-plus", version: "1.0.0" });

// ===== Chi nhánh =====
server.tool("kvp_branches", "Liệt kê chi nhánh (id, tên) để chọn khi nhập tồn kho.", {},
  wrap(async () => (await branches()).map((b) => ({ id: b.id, name: b.branchName, address: b.address }))));

// ===== HÀNG HOÁ =====
const inventoryArg = z.object({
  onHand: z.number().optional().describe("Số lượng tồn kho ban đầu"),
  cost: z.number().optional().describe("Giá vốn"),
  minQuantity: z.number().optional().describe("Định mức tồn thấp nhất"),
  maxQuantity: z.number().optional().describe("Định mức tồn cao nhất"),
});

server.tool(
  "kvp_product_create",
  "Thêm hàng hoá ĐẦY ĐỦ: tồn kho + giá vốn theo chi nhánh, mã vạch, ảnh, thuộc tính, đơn vị.",
  {
    name: z.string().describe("Tên hàng (bắt buộc)"),
    categoryId: z.number().describe("Id nhóm hàng (bắt buộc) – xem kiotviet_categories_list"),
    basePrice: z.number().describe("Giá bán"),
    code: z.string().optional().describe("Mã hàng – bỏ trống để KiotViet tự sinh"),
    barcode: z.string().optional(),
    fullName: z.string().optional().describe("Tên hàng trên hoá đơn điện tử"),
    brandId: z.number().optional().describe("Id thương hiệu – xem kvp_trademarks"),
    unit: z.string().optional().describe("Đơn vị cơ bản, vd: kg, hộp, bó"),
    weight: z.number().optional().describe("Trọng lượng (gam)"),
    description: z.string().optional(),
    images: z.array(z.string().url()).optional().describe("Danh sách link ảnh công khai (https)"),
    attributes: z.array(z.object({ attributeName: z.string(), attributeValue: z.string() })).optional(),
    allowsSale: z.boolean().optional().default(true).describe("Bán trực tiếp"),
    isRewardPoint: z.boolean().optional().default(true).describe("Tích điểm"),
    branches: branchArg,
    stock: inventoryArg.optional().describe("Tồn kho/giá vốn áp cho các chi nhánh đã chọn"),
  },
  wrap(async (a) => {
    const ids = await resolveBranchIds(a.branches);
    const s = a.stock || {};
    const body = {
      name: a.name, categoryId: a.categoryId, basePrice: a.basePrice, code: a.code, barcode: a.barcode,
      fullName: a.fullName, brandId: a.brandId, unit: a.unit, weight: a.weight, description: a.description,
      images: a.images, attributes: a.attributes, allowsSale: a.allowsSale, isRewardPoint: a.isRewardPoint,
      isActive: true,
      inventories: ids.map((branchId) => ({
        branchId, onHand: s.onHand ?? 0, cost: s.cost ?? 0,
        ...(s.minQuantity !== undefined && { minQuantity: s.minQuantity }),
        ...(s.maxQuantity !== undefined && { maxQuantity: s.maxQuantity }),
      })),
    };
    return await kv("POST", "/products", { body });
  }),
);

server.tool(
  "kvp_product_add_unit",
  "Thêm đơn vị quy đổi cho hàng hoá có sẵn, vd 1 thùng = 24 hộp.",
  {
    baseProductId: z.number().describe("Id hàng hoá đơn vị cơ bản"),
    unit: z.string().describe("Tên đơn vị mới, vd: thùng"),
    conversionValue: z.number().describe("1 đơn vị mới = bao nhiêu đơn vị cơ bản"),
    basePrice: z.number().describe("Giá bán của đơn vị mới"),
    code: z.string().optional(),
    barcode: z.string().optional(),
  },
  wrap(async (a) => {
    const base = await kv("GET", `/products/${a.baseProductId}`);
    return await kv("POST", "/products", {
      body: {
        name: base.name, categoryId: base.categoryId, unit: a.unit, masterUnitId: a.baseProductId,
        conversionValue: a.conversionValue, basePrice: a.basePrice, code: a.code, barcode: a.barcode,
        allowsSale: true, isActive: true,
      },
    });
  }),
);

server.tool(
  "kvp_product_update",
  "Sửa hàng hoá: tên, giá, mã vạch, ảnh, nhóm... và/hoặc cập nhật tồn kho, giá vốn tại chi nhánh.",
  {
    id: z.number().describe("Id hàng hoá"),
    name: z.string().optional(), basePrice: z.number().optional(), categoryId: z.number().optional(),
    barcode: z.string().optional(), fullName: z.string().optional(), brandId: z.number().optional(),
    unit: z.string().optional(), weight: z.number().optional(), description: z.string().optional(),
    images: z.array(z.string().url()).optional(), allowsSale: z.boolean().optional(),
    isActive: z.boolean().optional().describe("false = ngừng kinh doanh"),
    branches: branchArg,
    stock: inventoryArg.optional().describe("Đặt lại tồn kho/giá vốn ở các chi nhánh đã chọn"),
  },
  wrap(async ({ id, branches: br, stock, ...fields }) => {
    const body = { id, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    if (stock) {
      const ids = await resolveBranchIds(br);
      body.inventories = ids.map((branchId) => ({ branchId, ...stock }));
    }
    return await kv("PUT", `/products/${id}`, { body });
  }),
);

server.tool("kvp_product_stock", "Xem tồn kho, giá vốn từng chi nhánh của 1 hàng hoá (theo id hoặc mã).",
  { id: z.number().optional(), code: z.string().optional() },
  wrap(async ({ id, code }) => {
    const p = id ? await kv("GET", `/products/${id}`) : await kv("GET", `/products/code/${encodeURIComponent(code)}`);
    return { id: p.id, code: p.code, name: p.fullName || p.name, basePrice: p.basePrice, unit: p.unit, inventories: p.inventories };
  }));

server.tool("kvp_trademarks", "Danh sách thương hiệu (id, tên).", {},
  wrap(async () => (await kv("GET", "/trademark", { query: { pageSize: 100 } })).data));

// ===== NHÓM HÀNG =====
server.tool("kvp_category_create", "Tạo nhóm hàng mới.",
  { categoryName: z.string(), parentId: z.number().optional().describe("Id nhóm cha nếu là nhóm con") },
  wrap(async (a) => kv("POST", "/categories", { body: a })));

server.tool("kvp_category_update", "Đổi tên / đổi nhóm cha của nhóm hàng.",
  { id: z.number(), categoryName: z.string().optional(), parentId: z.number().optional() },
  wrap(async ({ id, ...rest }) => kv("PUT", `/categories/${id}`, { body: { id, ...rest } })));

server.tool("kvp_category_delete",
  "XOÁ nhóm hàng. Bắt buộc confirm=true sau khi chủ cửa hàng đồng ý. Nhóm còn hàng hoá có thể bị KiotViet từ chối.",
  { id: z.number(), confirm: z.boolean().optional() },
  wrap(async ({ id, confirm }) => {
    requireConfirm(confirm, "nhóm hàng");
    await kv("DELETE", `/categories/${id}`);
    return { deleted: true, id };
  }));

// ===== KHÁCH HÀNG =====
const customerFields = {
  name: z.string().optional(),
  code: z.string().optional().describe("Mã khách – bỏ trống để tự sinh"),
  contactNumber: z.string().optional().describe("Điện thoại"),
  gender: z.enum(["nam", "nu"]).optional(),
  birthDate: z.string().optional().describe("YYYY-MM-DD"),
  email: z.string().optional(),
  address: z.string().optional(),
  locationName: z.string().optional().describe("Khu vực, vd: Đắk Lắk - Thành phố Buôn Ma Thuột"),
  wardName: z.string().optional().describe("Phường/xã"),
  comments: z.string().optional().describe("Ghi chú"),
  type: z.enum(["ca_nhan", "cong_ty"]).optional().describe("Loại khách"),
  organization: z.string().optional().describe("Tên công ty"),
  taxCode: z.string().optional().describe("Mã số thuế"),
  groupIds: z.array(z.number()).optional().describe("Id các nhóm khách hàng – xem kiotviet_customer_groups_list"),
};
function customerBody(a) {
  const b = { ...a };
  if (a.gender) b.gender = a.gender === "nam";
  if (a.type) b.type = a.type === "cong_ty" ? 1 : 0;
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
}

server.tool("kvp_customer_create", "Thêm khách hàng mới, có thể gán loại khách và nhóm khách.",
  { ...customerFields, name: z.string().describe("Tên khách (bắt buộc)"), branches: branchArg },
  wrap(async ({ branches: br, ...a }) => {
    const [branchId] = await resolveBranchIds(br);
    return kv("POST", "/customers", { body: { ...customerBody(a), branchId } });
  }));

server.tool("kvp_customer_update", "Sửa thông tin / đổi loại khách / đổi nhóm khách của khách hàng.",
  { id: z.number().describe("Id khách hàng"), ...customerFields },
  wrap(async ({ id, ...a }) => kv("PUT", `/customers/${id}`, { body: { id, ...customerBody(a) } })));

server.tool("kvp_customer_find", "Tìm khách theo số điện thoại, mã hoặc tên.",
  { contactNumber: z.string().optional(), code: z.string().optional(), name: z.string().optional() },
  wrap(async (q) => {
    const res = await kv("GET", "/customers", { query: { ...q, pageSize: 20 } });
    return (res.data || []).map((c) => ({
      id: c.id, code: c.code, name: c.name, phone: c.contactNumber, type: c.type === 1 ? "công ty" : "cá nhân",
      groups: c.groups, debt: c.debt, totalRevenue: c.totalRevenue,
    }));
  }));

server.tool("kvp_customer_delete",
  "XOÁ khách hàng. Bắt buộc confirm=true sau khi chủ cửa hàng đồng ý.",
  { id: z.number(), confirm: z.boolean().optional() },
  wrap(async ({ id, confirm }) => {
    requireConfirm(confirm, "khách hàng");
    await kv("DELETE", `/customers/${id}`);
    return { deleted: true, id };
  }));

// ===== LỢI NHUẬN =====
let costCache = { at: 0, map: new Map() };
async function costMap() {
  if (Date.now() - costCache.at < 5 * 60 * 1000) return costCache.map;
  const rows = await listAll("/products", { includeInventory: true });
  const map = new Map();
  for (const p of rows) {
    const byBranch = {};
    for (const inv of p.inventories || []) byBranch[inv.branchId] = inv.cost || 0;
    map.set(p.id, byBranch);
  }
  costCache = { at: Date.now(), map };
  return map;
}
const costOf = (map, productId, branchId) => {
  const b = map.get(productId) || {};
  return b[branchId] ?? Object.values(b)[0] ?? 0;
};

server.tool(
  "kvp_profit_report",
  "Báo cáo doanh thu, giá vốn, LỢI NHUẬN GỘP theo ngày (mặc định hôm nay, giờ Việt Nam), có thể lọc chi nhánh.",
  { date: z.string().optional().describe("YYYY-MM-DD, bỏ trống = hôm nay"), branches: branchArg, topProducts: z.number().optional().default(10) },
  wrap(async ({ date, branches: br, topProducts }) => {
    const day = date || vnDate();
    const branchIds = br && br.length ? await resolveBranchIds(br) : undefined;
    const [invoices, returns, costs] = await Promise.all([
      listAll("/invoices", { fromPurchaseDate: `${day}T00:00:00`, toPurchaseDate: `${day}T23:59:59`, status: [1], branchIds }),
      listAll("/returns", { fromReturnDate: `${day}T00:00:00`, toReturnDate: `${day}T23:59:59` }),
      costMap(),
    ]);
    const inDay = (d) => d && vnDate(new Date(d.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(d) ? d : d + "+07:00")) === day;
    const inv = invoices.filter((i) => inDay(i.purchaseDate));
    const ret = returns.filter((r) => inDay(r.returnDate) && (r.status === undefined || r.status === 1) && (!branchIds || branchIds.includes(r.branchId)));

    let revenue = 0, cogs = 0, retRevenue = 0, retCogs = 0;
    const prod = new Map();
    for (const i of inv) {
      revenue += i.total || 0;
      for (const d of i.invoiceDetails || []) {
        const c = costOf(costs, d.productId, i.branchId) * d.quantity;
        cogs += c;
        const line = d.price * d.quantity - (d.discount || 0) * d.quantity;
        const p = prod.get(d.productId) || { code: d.productCode, name: d.productName, qty: 0, revenue: 0, cost: 0 };
        p.qty += d.quantity; p.revenue += line; p.cost += c;
        prod.set(d.productId, p);
      }
    }
    for (const r of ret) {
      retRevenue += r.returnTotal || 0;
      for (const d of r.returnDetails || []) retCogs += costOf(costs, d.productId, r.branchId) * d.quantity;
    }
    const netRevenue = revenue - retRevenue;
    const netCogs = cogs - retCogs;
    const profit = netRevenue - netCogs;
    const top = [...prod.values()].map((p) => ({ ...p, profit: p.revenue - p.cost }))
      .sort((a, b) => b.profit - a.profit).slice(0, topProducts);
    return {
      date: day,
      branches: branchIds || "tất cả",
      invoiceCount: inv.length,
      revenue, returns: retRevenue, netRevenue,
      costOfGoods: netCogs,
      grossProfit: profit,
      margin: netRevenue ? `${((profit / netRevenue) * 100).toFixed(1)}%` : "0%",
      topProducts: top,
      note: "Giá vốn lấy theo giá vốn hiện tại của hàng hoá, nên có thể lệch nhẹ so với Báo cáo cuối ngày của KiotViet nếu giá vốn đã thay đổi trong ngày.",
    };
  }),
);

await server.connect(new StdioServerTransport());
