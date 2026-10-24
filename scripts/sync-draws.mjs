#!/usr/bin/env node
/**
 * 从 166w2 / kai8 拉公开开奖号，写成同站静态 JSON。
 * 浏览器打不开 kai8（无 CORS）；GitHub Pages 直接托管这些文件。
 *
 *   node scripts/sync-draws.mjs [--out dir]     拉取并写入（无变化则不改文件）
 *   node scripts/sync-draws.mjs --check [--out dir]  只校验已有文件，不访问网络
 *
 * 老澳 draws_lao.json 保留 k / issue / nums，线上旧页面仍能 ingest 最新一期。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_BASE = "https://data.kai8.us/api/lottery/history/kai166";
const LOTS = [
  { lot: "新澳", code: "XOMLHC", file: "draws_xinao.json" },
  { lot: "香港", code: "HK6", file: "draws_hk.json" },
  { lot: "老澳", code: "OMLHC", file: "draws_lao.json" },
];
/** 任务核实过的期次；更新的列表必须仍包含这些开奖，且最新期不得更早。 */
const KNOWN = {
  新澳: { issue: "2026296", draw_code: "14,43,26,45,03,31,23" },
  香港: { issue: "2026113", draw_code: "12,11,38,48,16,04,05" },
  老澳: { issue: "2026296", draw_code: "45,29,35,04,39,01,36" },
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argOut() {
  const i = process.argv.indexOf("--out");
  if (i === -1) return repoRoot;
  const dir = process.argv[i + 1];
  if (!dir) throw new Error("--out 需要目录");
  return path.resolve(dir);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalize(row) {
  if (!row || row.issue == null) return null;
  const issue = String(row.issue).trim();
  if (!/^\d{6,8}$/.test(issue)) return null;
  const raw = String(row.draw_code || row.openCode || "").trim();
  const parts = raw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 7) return null;
  const nums = parts.map((s) => Number(s));
  if (nums.some((n) => !(Number.isInteger(n) && n >= 1 && n <= 49))) return null;
  const drawTime = String(row.draw_time || row.openTime || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}/.test(drawTime) ? drawTime.slice(0, 10) : "";
  const time = drawTime.slice(11, 19);
  const next = row.next_issue != null ? String(row.next_issue).trim() : "";
  return {
    issue,
    draw_time: date ? `${date}${time ? " " + time : ""}` : drawTime,
    draw_code: nums.map(pad2).join(","),
    nums,
    date,
    time,
    next,
  };
}

function laoK(latest) {
  const day = String(Number(latest.issue.slice(-3)));
  const next = latest.next && /^\d+$/.test(latest.next)
    ? String(Number(latest.next.slice(-3)))
    : String(Number(day) + 1);
  return `${day},${latest.draw_code},${next}`;
}

function signature(doc) {
  return JSON.stringify({
    lot: doc.lot,
    code: doc.code,
    issue: String(doc.issue || ""),
    date: doc.date || "",
    time: doc.time || "",
    nums: doc.nums || [],
    k: doc.k || "",
    list: (doc.list || []).map((r) => [String(r.issue), r.draw_code, r.draw_time]),
  });
}

async function pull(code) {
  const url = `${SRC_BASE}/${code}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "workbench-draws-sync",
        },
      });
      if (!r.ok) throw new Error(`${code} HTTP ${r.status}`);
      const j = await r.json();
      const list = j && j.data && j.data.list;
      if (!Array.isArray(list)) {
        throw new Error(`${code} 无 data.list（status=${j && j.status}）`);
      }
      console.log(`${code} status=${JSON.stringify(j.status)} n=${list.length}`);
      return list;
    } catch (e) {
      last = e;
      if (i < 2) await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
  throw last;
}

function buildDoc(meta, rawList) {
  const map = new Map();
  for (const raw of rawList) {
    const n = normalize(raw);
    if (!n || map.has(n.issue)) continue;
    map.set(n.issue, n);
  }
  const rows = [...map.values()].sort((a, b) => Number(b.issue) - Number(a.issue));
  if (!rows.length) throw new Error(`${meta.lot} 没有有效开奖`);
  const latest = rows[0];
  const doc = {
    lot: meta.lot,
    code: meta.code,
    src: `${SRC_BASE}/${meta.code}`,
    updatedAt: new Date().toISOString(),
    issue: latest.issue,
    date: latest.date,
    time: latest.time,
    nums: latest.nums,
  };
  if (meta.lot === "老澳") doc.k = laoK(latest);
  doc.list = rows.map((r) => ({ issue: r.issue, draw_time: r.draw_time, draw_code: r.draw_code }));
  return doc;
}

function readDoc(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertDoc(meta, doc) {
  const bad = [];
  if (!doc || doc.lot !== meta.lot || doc.code !== meta.code) bad.push("lot/code 不对");
  if (!Array.isArray(doc.list) || !doc.list.length) bad.push("list 为空");
  const known = KNOWN[meta.lot];
  const hit = (doc.list || []).find((r) => String(r.issue) === known.issue);
  if (!hit) bad.push(`缺少已核实期 ${known.issue}`);
  else if (hit.draw_code !== known.draw_code) bad.push(`${known.issue} 号码是 ${hit.draw_code}，应为 ${known.draw_code}`);
  if (!(Number(doc.issue) >= Number(known.issue))) bad.push(`最新期 ${doc.issue} 早于 ${known.issue}`);
  for (const r of doc.list || []) {
    const n = normalize(r);
    if (!n) {
      bad.push(`无效行 ${r && r.issue}`);
      break;
    }
  }
  if (meta.lot === "老澳") {
    if (!doc.k || !Array.isArray(doc.nums) || doc.nums.length !== 7) bad.push("老澳缺少 k/nums");
    else {
      const fromK = String(doc.k).split(",").slice(1, 8).map(Number);
      if (fromK.join() !== doc.nums.map(Number).join()) bad.push(`k 与 nums 不一致 ${doc.k}`);
      const day = String(Number(String(doc.issue).slice(-3)));
      if (!String(doc.k).startsWith(day + ",")) bad.push(`k 期号后缀不是 ${day}`);
    }
  }
  if (bad.length) throw new Error(`${meta.file}: ${bad.join("；")}`);
}

function writeIfChanged(file, doc, prev) {
  if (prev && signature(prev) === signature({ ...doc, updatedAt: prev.updatedAt })) {
    console.log(`${path.basename(file)} 无变化 ${doc.lot} ${doc.issue} ${doc.nums.map(pad2).join(",")}`);
    return false;
  }
  if (prev && Number(doc.issue) < Number(prev.issue)) {
    throw new Error(`${path.basename(file)} 新期号 ${doc.issue} 早于已有 ${prev.issue}，拒绝回退`);
  }
  if (prev && Array.isArray(prev.list) && doc.list.length + 5 < prev.list.length) {
    throw new Error(`${path.basename(file)} 条数从 ${prev.list.length} 降到 ${doc.list.length}，拒绝覆盖`);
  }
  const text = JSON.stringify(doc, null, 2) + "\n";
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  console.log(`${path.basename(file)} 写入 ${doc.lot} ${doc.issue} ${doc.date} ${doc.nums.map(pad2).join(",")}（${doc.list.length} 期）`);
  return true;
}

async function sync(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const ready = [];
  for (const meta of LOTS) {
    const raw = await pull(meta.code);
    const doc = buildDoc(meta, raw);
    assertDoc(meta, doc);
    ready.push({ meta, doc });
  }
  let changed = 0;
  for (const { meta, doc } of ready) {
    const file = path.join(outDir, meta.file);
    if (writeIfChanged(file, doc, readDoc(file))) changed++;
  }
  console.log(changed ? `更新 ${changed} 个文件` : "三个缓存都已是最新");
}

function check(outDir) {
  for (const meta of LOTS) {
    const file = path.join(outDir, meta.file);
    const doc = readDoc(file);
    if (!doc) throw new Error("缺少 " + file);
    assertDoc(meta, doc);
    console.log(`ok ${meta.file} ${doc.lot} ${doc.issue} ${doc.date} ${(doc.nums || []).map(pad2).join(",")} list=${doc.list.length}`);
  }
}

const outDir = argOut();
if (process.argv.includes("--check")) {
  try {
    check(outDir);
  } catch (e) {
    console.error(e && e.message || e);
    process.exit(1);
  }
} else {
  sync(outDir).catch((e) => {
    console.error(e && e.message || e);
    process.exit(1);
  });
}
