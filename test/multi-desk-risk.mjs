/**
 * 多台合计风险：当前彩种 + 当前玩法，1/2/3 号台相加，不除以台数。
 * 特码 round(总注−退水−该号×赔率) 默认 ×47
 * 平特 round(总注−退水−该肖×(1+不含本)) 默认 ×2；本命默认 ×1.8 且不退水
 * 平特尾 round(总注−退水−该尾×(1+0.8)) 默认 ×1.8，不退水
 *
 * 用法: node test/multi-desk-risk.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const shotDir = process.env.WB_SHOT_DIR || "/opt/cursor/artifacts";

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
      const f = path.normalize(path.join(root, rel));
      if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404); res.end("missing"); return; }
        const ext = path.extname(f);
        const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".json" ? "application/json" : "application/octet-stream";
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
        res.end(buf);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function waitLine(stream, re, ms) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("timeout waiting for chrome: " + buf.slice(-400))), ms);
    const on = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(re);
      if (m) { clearTimeout(t); stream.off("data", on); resolve(m); }
    };
    stream.on("data", on);
  });
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          const i = ++id;
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("cdp timeout " + method)), 20000);
            pending.set(i, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
            ws.send(JSON.stringify({ id: i, method, params, sessionId }));
          });
        },
        close() { ws.close(); },
      });
    });
    ws.addEventListener("error", () => reject(new Error("ws error " + wsUrl)));
  });
}

const CHECK = `(() => {
  const X = window.__WB;
  if (!X || !X.multiDeskRisk) return { err: "no multiDeskRisk" };
  const dt = "2026-10-24";
  const S = {
    bm: "马", bmOdds: 0.8, auto: false,
    odds: { 特码单码: 47, 平特一肖: 1, 平特: 1, 平特尾数: 0.8 },
    rebate: { 特码: 4, 平特: 4, 连肖: 4 },
    custReb: { 乙: { 特码: 10 } }
  };
  const desk = (t, bets, settings) => ({ t, missing: false, bets, settings: settings || S });
  const bet = (o) => Object.assign({ date: dt, res: "pend", ret: 0 }, o);
  const row = (pack, key) => pack.rows.find((r) => String(r.key) === String(key));
  const near = (got, exp, name) => {
    if (Math.abs(+got - exp) > 1e-6) throw new Error(name + " expected " + exp + " got " + got);
  };
  const tema = X.multiDeskRisk([
    desk("1", [bet({ lot: "新澳", type: "特码单码", content: "1", amount: 100, odds: 47 })]),
    desk("2", [bet({ lot: "新澳", type: "特码单码", content: "1", amount: 50, odds: 47 })]),
    desk("3", [])
  ], "新澳", dt, "tema");
  if (tema.rows.length !== 49 || tema.rows[0].key !== 1 || tema.rows[1].key !== 2 || tema.rows[48].key !== 49) throw new Error("特码排序 " + tema.rows.slice(0, 3).map((r) => r.key));
  const ord = X.multiDeskRisk([desk("1", [
    bet({ lot: "新澳", type: "特码单码", content: "8", amount: 20, odds: 47 }),
    bet({ lot: "新澳", type: "特码单码", content: "2", amount: 20, odds: 47 }),
    bet({ lot: "新澳", type: "特码单码", content: "15", amount: 40, odds: 1 })
  ])], "新澳", dt, "tema");
  if ([ord.rows[0].key, ord.rows[1].key, ord.rows[2].key, ord.rows[3].key].join() !== "15,2,8,1") throw new Error("下注排序 " + ord.rows.slice(0, 4).map((r) => r.key));
  if (ord.worst !== row(ord, 2).risk && ord.worst !== row(ord, 8).risk) throw new Error("相同下注应一起算最亏 " + ord.worst);
  if (ord.rows[0].risk === ord.worst) throw new Error("最高下注不是最亏时不应占最亏标记");
  near(tema.totalStake, 150, "特码总注");
  near(tema.totalRebate, 6, "特码退水");
  near(row(tema, 1).stake, 150, "01 下注");
  if (row(tema, 1).dStake.join() !== "100,50,0") throw new Error("分台被除或漏了: " + row(tema, 1).dStake);
  if (row(tema, 1).risk !== Math.round(150 - 6 - 150 * 47)) throw new Error("01 风险 " + row(tema, 1).risk);
  if (row(tema, 2).stake !== 0 || row(tema, 2).risk !== Math.round(144)) throw new Error("无注号未列出或风险不对 " + JSON.stringify(row(tema, 2)));
  if (tema.worst !== row(tema, 1).risk) throw new Error("最亏不是 01");
  const ign = X.multiDeskRisk([desk("1", [
    bet({ lot: "新澳", type: "一肖", content: "龙", amount: 80, odds: 10.85 }),
    bet({ lot: "新澳", type: "平特", content: "蛇", amount: 200, odds: 1 }),
    bet({ lot: "香港", type: "特码单码", content: "1", amount: 999, odds: 47 }),
    bet({ lot: "新澳", type: "特码单码", content: "9", amount: 10, odds: 47 })
  ])], "新澳", dt, "tema");
  near(ign.totalStake, 10, "特码应只留 10");
  if (row(ign, 9).risk !== Math.round(10 - 0.4 - 10 * 47)) throw new Error("09 风险 " + row(ign, 9).risk);
  const sp = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "特码单码", content: "1 2", amount: 100, odds: 47 })])], "新澳", dt, "tema");
  near(row(sp, 1).stake, 50, "拆号");
  if (row(sp, 1).risk !== Math.round(100 - 4 - 50 * 47) || row(sp, 3).risk !== 96) throw new Error("拆号风险 " + row(sp, 1).risk + "/" + row(sp, 3).risk);
  const tie = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "特码单码", content: "5", amount: 100, odds: 47, res: "tie" })])], "新澳", dt, "tema");
  if (tie.totalRebate !== 0 || row(tie, 5).risk !== Math.round(100 - 100 * 47)) throw new Error("和局仍退水");
  const cu = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "特码单码", content: "7", amount: 100, odds: 47, cust: "乙" })])], "新澳", dt, "tema");
  near(cu.totalRebate, 10, "客户退水");
  if (row(cu, 7).risk !== Math.round(100 - 10 - 100 * 47)) throw new Error("客户退水风险 " + row(cu, 7).risk);
  const mix = X.multiDeskRisk([
    desk("1", [bet({ lot: "新澳", type: "特码单码", content: "1", amount: 100, odds: 47 })]),
    desk("2", [bet({ lot: "新澳", type: "特码单码", content: "1", amount: 100, odds: 46 })])
  ], "新澳", dt, "tema");
  if (row(mix, 1).stake !== 200) throw new Error("两台下注应是 200，实际 " + row(mix, 1).stake);
  if (row(mix, 1).risk !== Math.round(200 - 8 - (100 * 47 + 100 * 46))) throw new Error("各台赔率 " + row(mix, 1).risk);
  const def = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "特码单码", content: "3", amount: 100 })], {})], "新澳", dt, "tema");
  near(def.totalRebate, 4, "默认退水");
  if (row(def, 3).risk !== Math.round(100 - 4 - 100 * 47)) throw new Error("默认 47 风险 " + row(def, 3).risk);
  const ping = X.multiDeskRisk([desk("1", [
    bet({ lot: "新澳", type: "平特一肖", content: "蛇", amount: 200, odds: 1 }),
    bet({ lot: "新澳", type: "平特", content: "马", amount: 100, odds: 0.8 }),
    bet({ lot: "新澳", type: "平特", content: "龙蛇", amount: 999, odds: 4 }),
    bet({ lot: "香港", type: "平特", content: "鼠", amount: 999, odds: 1 })
  ])], "新澳", dt, "ping");
  if (ping.rows.length !== 12 || ping.rows.map((r) => r.key).join("") !== "蛇马鼠牛虎兔龙羊猴鸡狗猪") throw new Error("平特应按下注再按肖序 " + ping.rows.map((r) => r.key).join(""));
  near(ping.totalStake, 300, "平特总注");
  near(ping.totalRebate, 8, "平特退水");
  if (row(ping, "蛇").risk !== Math.round(300 - 8 - 200 * 2)) throw new Error("蛇风险 " + row(ping, "蛇").risk);
  if (row(ping, "马").risk !== Math.round(300 - 8 - 100 * 1.8)) throw new Error("马风险 " + row(ping, "马").risk);
  if (row(ping, "鼠").stake !== 0 || row(ping, "鼠").risk !== Math.round(292)) throw new Error("无注肖 " + JSON.stringify(row(ping, "鼠")));
  const pingDef = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "平特", content: "牛", amount: 100 })], { bm: "马", bmOdds: 0.8, odds: { 平特一肖: 1 }, rebate: { 平特: 4 } })], "新澳", dt, "ping");
  if (row(pingDef, "牛").risk !== Math.round(100 - 4 - 100 * 2)) throw new Error("平特默认 ×2 " + row(pingDef, "牛").risk);
  const bm = X.multiDeskRisk([desk("1", [bet({ lot: "新澳", type: "平特", content: "马", amount: 100 })], { bm: "马", bmOdds: 0.8, odds: { 平特一肖: 1 }, rebate: { 平特: 50 } })], "新澳", dt, "ping");
  if (bm.totalRebate !== 0 || row(bm, "马").risk !== Math.round(100 - 100 * 1.8)) throw new Error("本命应不退水且 ×1.8 " + row(bm, "马").risk);
  const tail = X.multiDeskRisk([
    desk("1", [bet({ lot: "新澳", type: "平特尾数", content: "8", amount: 50, odds: 0.8, rebO: { 平特: 80 } })]),
    desk("2", [bet({ lot: "新澳", type: "平特尾数", content: "8", amount: 50, odds: 0.8 })])
  ], "新澳", dt, "tail");
  if (tail.rows.length !== 10 || tail.totalRebate !== 0) throw new Error("平特尾行数或退水 " + tail.rows.length + " " + tail.totalRebate);
  near(row(tail, 8).stake, 100, "8尾下注");
  if (row(tail, 8).risk !== Math.round(100 - 100 * 1.8) || row(tail, 0).stake !== 0) throw new Error("8尾风险 " + row(tail, 8).risk);
  const empty = X.multiDeskRisk([desk("1", [])], "老澳", dt, "tema");
  if (empty.rows.length !== 49 || empty.worst !== null || empty.rows.some((r) => r.stake !== 0 || r.risk !== 0)) throw new Error("空盘应 49 行全 0");
  X.Store.setItem("wb_data_v2__t2", JSON.stringify({
    bets: [bet({ lot: "新澳", type: "平特一肖", content: "蛇", amount: 100, odds: 2, net: true })],
    settings: { odds: { 平特一肖: 2, 平特: 2 }, rebate: { 平特: 4 }, bm: "马", bmOdds: 0.8 }
  }));
  const legDesk = X.readDesk("2");
  const leg = X.multiDeskRisk([legDesk], "新澳", dt, "ping");
  if (+legDesk.bets[0].odds !== 1) throw new Error("旧平特赔率 2 应看成不含本 1，实际 " + legDesk.bets[0].odds);
  if (row(leg, "蛇").risk !== Math.round(100 - 4 - 100 * 2)) throw new Error("旧赔率按 ×3 算了 " + row(leg, "蛇").risk);
  X.Store.setItem("wb_data_v2__t3", JSON.stringify({
    bets: [bet({ lot: "新澳", type: "平特", content: "兔", amount: 100 })],
    settings: { odds: { 平特一肖: 2 }, rebate: { 平特: 4 }, bm: "马", bmOdds: 0.8 }
  }));
  const leg3 = X.multiDeskRisk([X.readDesk("3")], "新澳", dt, "ping");
  if (row(leg3, "兔").risk !== Math.round(100 - 4 - 100 * 2)) throw new Error("设置里的旧赔率 2 未迁 " + row(leg3, "兔").risk);

  const live = [
    bet({ lot: "新澳", type: "特码单码", content: "1", amount: 100, odds: 47 }),
    bet({ lot: "新澳", type: "平特一肖", content: "蛇", amount: 200, odds: 1 }),
    bet({ lot: "新澳", type: "平特", content: "马", amount: 100, odds: 0.8 }),
    bet({ lot: "新澳", type: "平特尾数", content: "8", amount: 50, odds: 0.8 }),
    bet({ lot: "香港", type: "特码单码", content: "2", amount: 10, odds: 47 }),
    bet({ lot: "新澳", type: "一肖", content: "龙", amount: 80, odds: 10.85 })
  ];
  X.setTestData({ bets: live, settings: S, trash: [], unlock: {}, learn: [] }, {});
  X.Store.setItem("wb_data_v2__t2", JSON.stringify({
    bets: [
      bet({ lot: "新澳", type: "特码单码", content: "1", amount: 50, odds: 47 }),
      bet({ lot: "新澳", type: "平特尾数", content: "8", amount: 50, odds: 0.8 })
    ],
    settings: S
  }));
  X.Store.removeItem("wb_data_v2__t3");
  const dateEl = document.getElementById("wb_date");
  dateEl.value = dt;
  document.querySelector('#tabbar button[data-s="an"]').click();
  const an = document.getElementById("an");
  const text0 = an.innerText;
  const banned = ["客户与走势", "按客户", "按玩法", "按彩种", "走势（每天"];
  const hit = banned.filter((s) => text0.includes(s));
  if (hit.length) throw new Error("旧分析还在: " + hit.join(","));
  const lots = [...document.querySelectorAll("#an_lot button")].map((b) => b.textContent);
  const kinds = [...document.querySelectorAll("#an_kind button")].map((b) => b.textContent);
  if (lots.join() !== "新澳,香港,老澳") throw new Error("彩种页签 " + lots);
  if (kinds.join() !== "特码,平特,平特尾") throw new Error("玩法页签 " + kinds);
  const table = () => document.getElementById("an_table");
  const snap = () => {
    const tb = table();
    const rows = [...tb.querySelectorAll("tbody tr")].map((tr) => ({
      k: tr.dataset.k, stake: +tr.dataset.stake, risk: +tr.dataset.risk,
      worst: tr.classList.contains("worst"),
      desks: [...tr.children].slice(3).map((td) => td.textContent.replace(/[,\\s]/g, ""))
    }));
    return {
      n: +tb.dataset.n, kind: tb.dataset.kind, lot: tb.dataset.lot,
      text: document.getElementById("an_level").innerText,
      rows, worst: rows.filter((r) => r.worst).map((r) => r.k)
    };
  };
  const temaUi = snap();
  document.getElementById("an_split").click();
  const splitUi = snap();
  document.querySelector('#an_kind button[data-ak="ping"]').click();
  const pingUi = snap();
  document.querySelector('#an_kind button[data-ak="tail"]').click();
  const tailUi = snap();
  document.querySelector('#an_lot button[data-al="香港"]').click();
  document.querySelector('#an_kind button[data-ak="tema"]').click();
  const hkUi = snap();
  document.querySelector('#an_lot button[data-al="老澳"]').click();
  const laoUi = snap();
  document.querySelector('#an_lot button[data-al="新澳"]').click();
  const back = snap();
  return { lots, kinds, temaUi, splitUi, pingUi, tailUi, hkUi, laoUi, back, version: (document.querySelector("#set .note") || {}).innerText || "" };
})()`;

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function rowOf(ui, k) {
  return ui.rows.find((r) => String(r.k) === String(k));
}

async function shot(b, sessionId, file, width, height) {
  await b.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
  const png = await b.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, file), Buffer.from(png.data, "base64"));
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const userDir = fs.mkdtempSync("/tmp/wb-risk-");
  const chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--user-data-dir=${userDir}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let browser;
  try {
    const m = await waitLine(chrome.stderr, /DevTools listening on (ws:\/\/\S+)/, 15000);
    const ver = await fetch(m[1].replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/version")).then((r) => r.json());
    browser = await cdp(ver.webSocketDebuggerUrl);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Runtime.enable", {}, sessionId);
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
    await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__WBTEST=true" }, sessionId);
    await browser.send("Page.navigate", { url }, sessionId);
    let ready = "";
    for (let i = 0; i < 40; i++) {
      try {
        const r = await browser.send("Runtime.evaluate", {
          expression: `(()=>{const s=document.getElementById("wb_ballstat");return (window.__WB&&window.__WB.multiDeskRisk&&s)?s.textContent:""})()`,
          returnByValue: true,
        }, sessionId);
        ready = (r.result && r.result.value) || "";
        if (ready.includes("测试模式")) break;
      } catch (e) { ready = String(e); }
      await new Promise((res) => setTimeout(res, 200));
    }
    if (!ready.includes("测试模式")) throw new Error("page not ready " + ready);
    const ev = await browser.send("Runtime.evaluate", { expression: CHECK, returnByValue: true }, sessionId);
    if (ev.exceptionDetails) throw new Error(JSON.stringify(ev.exceptionDetails.exception || ev.exceptionDetails));
    const r = ev.result.value;
    if (r.err) throw new Error(r.err);
    must(r.temaUi.n === 49 && r.temaUi.kind === "tema" && r.temaUi.lot === "新澳", "特码表 " + JSON.stringify(r.temaUi).slice(0, 200));
    must(r.temaUi.rows.length === 49, "DOM 不是 49 行");
    const n1 = rowOf(r.temaUi, 1);
    must(n1.stake === 150 && n1.risk === Math.round(150 - 6 - 150 * 47) && n1.worst, "01 行 " + JSON.stringify(n1));
    must(rowOf(r.temaUi, 49).stake === 0, "49 未列出");
    must(r.temaUi.worst.join() === "1", "最亏高亮 " + r.temaUi.worst);
    must(r.temaUi.text.includes("不除以台数") && r.temaUi.text.includes("3号台"), "说明文字 " + r.temaUi.text.slice(0, 180));
    const s1 = rowOf(r.splitUi, 1);
    must(s1.desks.join() === "100,50,0", "分台列 " + s1.desks);
    must(!s1.desks.includes("75") && s1.stake === 150, "分台被除以台数");
    must(r.splitUi.text.includes("1号台") && r.splitUi.text.includes("下注数") && r.splitUi.text.includes("风险数"), "表头");
    const snake = rowOf(r.pingUi, "蛇");
    must(r.pingUi.n === 12 && snake.risk === Math.round(300 - 8 - 400) && r.pingUi.worst.join() === "蛇", "平特蛇 " + JSON.stringify(snake));
    must(rowOf(r.pingUi, "马").risk === Math.round(292 - 180), "平特马 " + rowOf(r.pingUi, "马").risk);
    must(r.pingUi.text.includes("×2") && r.pingUi.text.includes("本命"), "平特说明");
    const t8 = rowOf(r.tailUi, 8);
    must(r.tailUi.n === 10 && t8.stake === 100 && t8.risk === -80 && r.tailUi.worst.join() === "8", "平特尾 " + JSON.stringify(t8));
    must(r.tailUi.text.includes("不退水") || r.tailUi.text.includes("×1.8"), "平特尾说明 " + r.tailUi.text.slice(0, 120));
    const hk = rowOf(r.hkUi, 2);
    must(r.hkUi.lot === "香港" && hk.stake === 10 && hk.risk === Math.round(10 - 0.4 - 470), "香港 " + JSON.stringify(hk));
    must(r.laoUi.lot === "老澳" && r.laoUi.worst.length === 0 && r.laoUi.rows.every((x) => x.stake === 0 && x.risk === 0), "老澳应全 0");
    must(r.back.lot === "新澳" && r.back.kind === "tema" && rowOf(r.back, 1).worst, "回到新澳特码");
    must(r.temaUi.rows[0].k === "1" && r.temaUi.rows[1].k === "2" && r.temaUi.rows[48].k === "49", "特码表序 " + r.temaUi.rows.slice(0, 3).map((x) => x.k));
    must(r.pingUi.rows[0].k === "蛇" && r.pingUi.rows[1].k === "马" && r.pingUi.rows[2].k === "鼠", "平特表序 " + r.pingUi.rows.slice(0, 3).map((x) => x.k));
    must(r.tailUi.rows[0].k === "8" && r.tailUi.rows[1].k === "0" && r.tailUi.rows[9].k === "9", "平特尾表序 " + r.tailUi.rows.map((x) => x.k));
    must(r.version.includes("v21.10"), "版本 " + r.version);
    await shot(browser, sessionId, "multi-desk-risk-tema.png", 900, 1100);
    await shot(browser, sessionId, "multi-desk-risk-tema-mobile.png", 390, 844);
    await browser.send("Runtime.evaluate", { expression: `document.querySelector('#an_kind button[data-ak="ping"]').click()`, returnByValue: true }, sessionId);
    await shot(browser, sessionId, "multi-desk-risk-ping.png", 900, 900);
    await browser.send("Runtime.evaluate", { expression: `document.querySelector('#an_kind button[data-ak="tail"]').click()`, returnByValue: true }, sessionId);
    await shot(browser, sessionId, "multi-desk-risk-tail.png", 900, 800);
    console.log("ok 多台合计风险 特码49 / 平特12 / 平特尾10，三台相加不除");
    browser.close();
  } finally {
    try { chrome.kill("SIGKILL"); } catch (e) {}
    server.close();
    await new Promise((res) => setTimeout(res, 300));
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
