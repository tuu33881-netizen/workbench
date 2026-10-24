/**
 * 多台合计：同一浏览器读 1/2/3 号台今天的注额，只加总，不除以台数。
 * 1号台 01=1000、2号台 01=50、3号台 01=50 → 合计 1100（没有平摊列）。
 * 平特按生肖加注额（平特马不乘赔率），平特尾按 0–9 平分，跟 judge 的份数一致。
 *
 * 用法: node test/level-risk.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const dt = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const desk1 = [
  { date: dt, lot: "新澳", type: "特码单码", content: "01", amount: 1000, odds: 47, net: false },
  { date: dt, lot: "新澳", type: "一肖", content: "鼠", amount: 10, odds: 10.85, net: false },
  { date: dt, lot: "新澳", type: "平特", content: "马", amount: 100, odds: 0.8, net: true },
  { date: dt, lot: "新澳", type: "平特一肖", content: "蛇", amount: 200, odds: 1, net: true },
  { date: dt, lot: "新澳", type: "平特尾数", content: "8", amount: 80, odds: 0.8, net: true },
  { date: dt, lot: "新澳", type: "平特尾数", content: "35", amount: 90, odds: 0.8, net: true },
  { date: dt, lot: "新澳", type: "平特", content: "龙马", amount: 999, odds: 1, net: true },
  { date: dt, lot: "新澳", type: "二连肖", content: "马蛇", amount: 500, odds: 4, net: false },
  { date: dt, lot: "香港", type: "特码单码", content: "01", amount: 999, odds: 47, net: false },
  { date: "2000-01-01", lot: "新澳", type: "特码单码", content: "01", amount: 777, odds: 47, net: false },
];
const desk2 = [
  { date: dt, lot: "新澳", type: "特码单码", content: "01", amount: 50, odds: 47, net: false },
  { date: dt, lot: "新澳", type: "特码单码", content: "07", amount: 5, odds: 47, net: false },
  { date: dt, lot: "新澳", type: "平特一肖", content: "马", amount: 40, odds: 1, net: true },
  { date: dt, lot: "新澳", type: "平特一肖", content: "蛇", amount: 20, odds: 1, net: true },
  { date: dt, lot: "新澳", type: "平特尾数", content: "8", amount: 10, odds: 0.8, net: true },
];
const desk3 = [
  { date: dt, lot: "新澳", type: "特码单码", content: "01", amount: 50, odds: 47, net: false },
];

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
  const waits = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else waits.forEach((w) => w(m));
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}, sessionId) {
          const i = ++id;
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("cdp timeout " + method)), 20000);
            pending.set(i, (m) => {
              clearTimeout(t);
              if (m.error) rej(new Error(method + ": " + JSON.stringify(m.error)));
              else res(m.result);
            });
            const msg = { id: i, method, params };
            if (sessionId) msg.sessionId = sessionId;
            ws.send(JSON.stringify(msg));
          });
        },
        waitEvent(method, sessionId, ms = 20000) {
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("timeout " + method)), ms);
            const fn = (m) => {
              if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
                clearTimeout(t);
                waits.splice(waits.indexOf(fn), 1);
                res(m.params);
              }
            };
            waits.push(fn);
          });
        },
        close() { ws.close(); },
      });
    });
    ws.addEventListener("error", () => reject(new Error("ws error " + wsUrl)));
  });
}

function near(name, got, exp) {
  if (Math.abs(+got - exp) > 1e-6) throw new Error(`${name} expected ${exp}, got ${got}`);
}
function triple(name, row, exp) {
  if (!row) throw new Error(name + " missing row");
  if (row.avg != null || row.dev != null) throw new Error(name + " still has an across-desk average");
  exp.forEach((v, i) => near(name + "[" + i + "]", row.d[i], v));
  near(name + " sum", row.sum, exp.reduce((a, b) => a + b, 0));
}

const CHECK = `(() => {
  const X = window.__WB;
  if (!X || !X.levelData) return { err: "no levelData" };
  const desk1 = ${JSON.stringify(desk1)};
  const desk2 = ${JSON.stringify(desk2)};
  const desk3 = ${JSON.stringify(desk3)};
  localStorage.setItem("wb_data_v2", JSON.stringify({ bets: [{ date: ${JSON.stringify(dt)}, lot: "新澳", type: "特码单码", content: "01", amount: 1, odds: 47 }] }));
  localStorage.setItem("wb_data_v2__t2", JSON.stringify({ bets: desk2 }));
  localStorage.setItem("wb_data_v2__t3", JSON.stringify({ bets: desk3 }));
  X.setTestData({
    bets: desk1,
    settings: Object.assign({}, X.D.settings, { auto: false, view: "客户" }),
    trash: [], unlock: {}, learn: []
  }, {});
  document.querySelector('#tabbar button[data-s="an"]').click();
  X.renderLevel();
  const data = X.levelData("新澳", ${JSON.stringify(dt)});
  const find = (list, key) => list.find((r) => r.key === key);
  const box = document.getElementById("an_level");
  const row = (key) => {
    const tr = box.querySelector('tr[data-k="' + key + '"]');
    if (!tr) return null;
    return [...tr.children].map((td) => ({ t: td.textContent, c: td.className }));
  };
  const norm = (s) => String(s || "").replace(/[,，\\s]/g, "");
  box.querySelector('[data-lvk="ping"]').click();
  const ping = {
    ma: row("马"), she: row("蛇"), long: row("龙"),
    text: box.innerText
  };
  box.querySelector('[data-lvk="tail"]').click();
  const tail = { t8: row("8"), t3: row("3"), t5: row("5"), t0: row("0"), text: box.innerText };
  box.querySelector('[data-lvk="tema"]').click();
  const first = box.querySelector("tr[data-k]");
  const temaRow = row("1");
  const shu = row("19");
  const zeroBefore = !!row("2");
  document.getElementById("lv_zero").click();
  const zeroAfter = !!row("2");
  document.getElementById("lv_zero").click();
  const hk = X.levelData("香港", ${JSON.stringify(dt)});
  localStorage.removeItem("wb_data_v2__t3");
  const gone = X.levelData("新澳", ${JSON.stringify(dt)});
  X.renderLevel();
  return {
    err: "",
    note: (document.querySelector("#set .note small") || {}).textContent || "",
    title: (document.getElementById("lv_title") || {}).textContent || "",
    tab: (document.querySelector('#tabbar button[data-s="an"]') || {}).textContent || "",
    header: (document.querySelector("#an .dh span") || {}).textContent || "",
    anOpen: document.getElementById("an").style.display !== "none",
    tableOnTab: document.getElementById("an").contains(document.getElementById("an_level")) && !document.getElementById("rk").querySelector("#an_level"),
    hint: box.innerText,
    dataDesks: data.desks,
    n01: find(data.tema, 1),
    n07: find(data.tema, 7),
    n13: find(data.tema, 13),
    n19: find(data.tema, 19),
    ma: find(data.ping, "马"),
    she: find(data.ping, "蛇"),
    long: find(data.ping, "龙"),
    t8: find(data.tail, 8),
    t3: find(data.tail, 3),
    t5: find(data.tail, 5),
    hk01: find(hk.tema, 1),
    first: first && first.getAttribute("data-k"),
    temaRow, shu, zeroBefore, zeroAfter,
    temaText: box.innerText,
    ping, tail,
    miss: gone.desks,
    n01gone: find(gone.tema, 1),
    normTema: temaRow && temaRow.map((c) => norm(c.t) + "|" + c.c)
  };
})()`;

async function evalJs(b, sessionId, expression) {
  const ev = await b.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (ev.exceptionDetails) throw new Error(JSON.stringify(ev.exceptionDetails).slice(0, 1500));
  return ev.result.value;
}

async function shot(b, sessionId, file) {
  const art = process.env.ARTIFACTS || "/opt/cursor/artifacts";
  fs.mkdirSync(art, { recursive: true });
  await evalJs(b, sessionId, `document.getElementById("lv_title").scrollIntoView({block:"start"})`);
  const { data } = await b.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(path.join(art, file), Buffer.from(data, "base64"));
}

async function main() {
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  if (!sw.includes("wb-v217")) throw new Error("sw cache not wb-v217");
  const server = await serve();
  const port = server.address().port;
  const userDir = fs.mkdtempSync("/tmp/wb-level-");
  const chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--user-data-dir=${userDir}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const m = await waitLine(chrome.stderr, /DevTools listening on (ws:\/\/\S+)/, 15000);
    const ver = await fetch(m[1].replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/version")).then((r) => r.json());
    const b = await cdp(ver.webSocketDebuggerUrl);
    const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
    await b.send("Page.enable", {}, sessionId);
    await b.send("Runtime.enable", {}, sessionId);
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__WBTEST=true" }, sessionId);
    let loaded = b.waitEvent("Page.loadEventFired", sessionId, 30000);
    await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
    await loaded;
    const r = await evalJs(b, sessionId, CHECK);
    if (r.err) throw new Error(r.err);
    if (!r.note.includes("v21.7")) throw new Error("version " + r.note);
    if (r.tab !== "多台合计风险") throw new Error("tab " + r.tab);
    if (r.header !== "多台合计风险") throw new Error("header " + r.header);
    if (r.title !== "多台合计") throw new Error("title " + r.title);
    if (!r.anOpen || !r.tableOnTab) throw new Error("多台合计 table is not the open tab");
    if (!r.hint.includes("wb_data_v2__t3") || !r.hint.includes("不上传") || !r.hint.includes("不除以台数")) throw new Error("hint missing same-browser note: " + r.hint.slice(0, 280));
    if (/平摊|366\.67|÷/.test(r.hint)) throw new Error("UI still divides by desk count: " + r.hint.slice(0, 280));
    triple("01", r.n01, [1000, 50, 50]);
    triple("鼠号07 特肖+各号", r.n07, [10, 5, 0]);
    triple("鼠号19 只有特肖", r.n19, [10, 0, 0]);
    triple("马号13 平特不摊进特码", r.n13, [0, 0, 0]);
    triple("平特马", r.ma, [100, 40, 0]);
    triple("平特蛇", r.she, [200, 20, 0]);
    triple("两肖不拆", r.long, [0, 0, 0]);
    triple("尾8", r.t8, [80, 10, 0]);
    triple("尾3", r.t3, [45, 0, 0]);
    triple("尾5", r.t5, [45, 0, 0]);
    triple("香港01不进新澳", r.hk01, [999, 0, 0]);
    if (r.n01.d[0] !== 1000) throw new Error("current desk used stale storage instead of memory");
    if (r.first !== "1") throw new Error("sort first row " + r.first);
    if (!r.temaRow || r.temaRow.length !== 5) throw new Error("01 row should be 号码+三台+合计, got " + JSON.stringify(r.temaRow));
    if (!/hi/.test(r.temaRow[1].c) || !/peak/.test(r.temaRow[1].c)) throw new Error("01 desk1 1000 not highlighted " + JSON.stringify(r.temaRow));
    if (!/hi/.test(r.temaRow[4].c)) throw new Error("合计 1100 not highlighted " + JSON.stringify(r.temaRow));
    if (/hi|lo|peak/.test(r.temaRow[2].c) || /hi|lo|peak/.test(r.temaRow[3].c)) throw new Error("50 desks should stay plain " + JSON.stringify(r.temaRow));
    const texts = r.temaRow.map((c) => c.t.replace(/[,，\s]/g, ""));
    if (texts[1] !== "1000" || texts[2] !== "50" || texts[3] !== "50" || texts[4] !== "1100") throw new Error("合计 display " + texts.join(" | "));
    if (r.zeroBefore) throw new Error("zero row 02 was visible");
    if (!r.zeroAfter) throw new Error("显示无注 did not reveal 02");
    if (r.ping.long) throw new Error("平特 tab showed 龙 from an unsplittable 龙马 bet");
    if (!r.ping.ma || !r.ping.ma[4].t.replace(/[,，\s]/g, "").startsWith("140")) throw new Error("平特马 UI " + JSON.stringify(r.ping.ma));
    if (r.tail.t0) throw new Error("empty tail 0 was shown");
    if (!r.tail.t8 || r.tail.t8[4].t.replace(/[,，\s]/g, "") !== "90") throw new Error("尾8 UI " + JSON.stringify(r.tail.t8));
    if (r.dataDesks.some((d) => d.missing)) throw new Error("desks should all exist " + JSON.stringify(r.dataDesks));
    if (!r.miss.find((d) => d.t === "3" && d.missing)) throw new Error("desk3 should be missing " + JSON.stringify(r.miss));
    triple("缺3号台按0", r.n01gone, [1000, 50, 0]);
    if (!r.temaText.includes("3号台")) throw new Error("missing desk not noted: " + r.temaText.slice(0, 300));

    await evalJs(b, sessionId, `localStorage.setItem("wb_data_v2__t3", ${JSON.stringify(JSON.stringify({ bets: desk3 }))}); window.__WB.renderLevel(); document.querySelector('[data-lvk="tema"]').click();`);
    await shot(b, sessionId, "level_tema.png");
    await evalJs(b, sessionId, `document.querySelector('[data-lvk="ping"]').click()`);
    await shot(b, sessionId, "level_ping.png");
    await evalJs(b, sessionId, `document.querySelector('[data-lvk="tail"]').click()`);
    await shot(b, sessionId, "level_tail.png");

    localStoragePrep(null);
    await evalJs(b, sessionId, `localStorage.setItem("wb_data_v2", ${JSON.stringify(JSON.stringify({ bets: desk1, settings: { auto: false } }))});`);
    loaded = b.waitEvent("Page.loadEventFired", sessionId, 30000);
    await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/simple.html` }, sessionId);
    await loaded;
    const simpleText = await pollText(b, sessionId, `document.getElementById("lvbox") ? document.getElementById("lvbox").innerText : ""`, (t) => t.replace(/[,，]/g, "").includes("1100") && t.includes("不除以台数") && !t.includes("平摊"), 15000);
    if (!simpleText.includes("wb_data_v2__t3")) throw new Error("simple note missing keys: " + simpleText.slice(0, 240));
    if (/366\.67|平摊/.test(simpleText)) throw new Error("simple still shows an average: " + simpleText.slice(0, 240));
    await evalJs(b, sessionId, `document.querySelector('#lvcard [data-lvk="ping"]').click()`);
    const pingText = await pollText(b, sessionId, `document.getElementById("lvbox").innerText`, (t) => t.replace(/[,，]/g, "").includes("140") && t.includes("蛇"), 5000);
    if (/46\.67|平摊|366\.67/.test(pingText)) throw new Error("simple 平特 still averages: " + pingText.slice(0, 300));
    await evalJs(b, sessionId, `document.getElementById("lvcard").scrollIntoView({block:"start"})`);
    const art = process.env.ARTIFACTS || "/opt/cursor/artifacts";
    const { data } = await b.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(path.join(art, "level_simple_ping.png"), Buffer.from(data, "base64"));
    console.log("ok 01 合计 1100（1000+50+50，不除以台数）；平特马 140；平特尾 8 合计 90；缺台按 0");
    b.close();
  } finally {
    try { chrome.kill("SIGKILL"); } catch (e) {}
    try { server.close(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
  }
}

function localStoragePrep() {}

async function pollText(b, sessionId, expression, pred, ms) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await evalJs(b, sessionId, expression) || "";
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout text: " + String(last).slice(0, 500));
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
