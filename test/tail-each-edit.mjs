/**
 * 6尾各数 / 各数6尾 → 香港特码 06 16 26 36 46，不是平特尾。
 * 6尾500 / 500.6尾 仍是平特尾。
 * 已保存的单可以改原文和金额，再识别并重新结算。
 *
 * 用法: node test/tail-each-edit.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const SLIP = "香:01.03.06.13.15.18.25.27.30.37.39.42.49各200，03.06.07.13.16.17.23.26.27.33.36.37.43.46.47各50，06.25.26.32.36.37.39各30，01.03.06.10.13.15.18.22.25.27.30.34.37.39.42.46.49各130，10.11.12.22.23.24.34.35.36.46.47.48各20。\n6尾各数400";
const TAIL6 = ["06", "16", "26", "36", "46"];

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
        const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "application/octet-stream";
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
        close() { ws.close(); },
      });
    });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

async function evalJs(b, sessionId, expression) {
  const ev = await b.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (ev.exceptionDetails) {
    const d = ev.exceptionDetails;
    const desc = d.exception && d.exception.description;
    throw new Error((desc || d.text || "eval failed") + (d.lineNumber != null ? " line " + d.lineNumber : "") + " " + (d.exception && d.exception.value || ""));
  }
  return ev.result && ev.result.value;
}

const CHECK = `(() => {
  const X = window.__WB;
  const pack = (r) => ({ lot: r.lot, type: r.type, content: String(r.content), amount: r.amount, warn: r.warn || "", zexp: r.zexp || "", grp: r.grp });
  const rows = X.parseBets(${JSON.stringify(SLIP)}).map(pack);
  const cases = {
    plain: X.parseBets("6尾500").map(pack),
    dot: X.parseBets("500.6尾").map(pack),
    rev: X.parseBets("各数6尾400").map(pack),
    spaced: X.parseBets("6尾各 数400").map(pack),
    zero: X.parseBets("0尾各数100").map(pack),
    ge: X.parseBets("7尾各400").map(pack),
    ping: X.parseBets("平特8尾500").map(pack),
    both: X.parseBets("6.8尾各数10").map(pack)
  };
  const dt = "2026-10-24";
  document.getElementById("wb_date").value = dt;
  X.DRAWS["香港|2026297"] = { lot: "香港", issue: "2026297", date: dt, nums: [2, 3, 4, 5, 7, 8, 16], manual: true };
  const src = ${JSON.stringify(SLIP)};
  X.D.bets.push({
    id: "old-tail", date: dt, issue: "2026297", lot: "香港", type: "平特尾数", content: "6",
    amount: 400, odds: 0.8, net: true, note: "工作台：6尾 各数 400", grp: 2, src, cust: "甲",
    rebO: { 特码: 4, 平特: 0, 连肖: 4 }, res: "win", ret: 720
  });
  X.D.bets.push({
    id: "old-num", date: dt, issue: "2026297", lot: "香港", type: "特码单码", content: "01",
    amount: 200, odds: 47, net: false, note: "工作台：01 各200", grp: 2, src, cust: "甲",
    rebO: { 特码: 4, 平特: 0, 连肖: 4 }, res: "lose", ret: 0
  });
  document.getElementById("wb_date").dispatchEvent(new Event("change"));
  const before = document.getElementById("wb_cards").innerText;
  const btn = document.querySelector('[data-ed="2"]');
  if (!btn) return { err: "no edit button", before };
  btn.click();
  const opened = {
    text: document.getElementById("wb_text").value,
    bar: (document.getElementById("wb_editbar").innerText || "").replace(/\\s+/g, " "),
    label: document.getElementById("wb_save").textContent,
    open: document.getElementById("wb_paste_box").open
  };
  document.getElementById("wb_text").value = opened.text.replace("6尾各数400", "6尾各数250");
  document.getElementById("wb_save").click();
  const bets = X.D.bets.filter((b) => b.date === dt && (b.grp || 1) === 2);
  const tail = bets.filter((b) => b.zexp === "6尾").map((b) => ({
    type: b.type, content: String(b.content).padStart(2, "0"), amount: b.amount, lot: b.lot,
    res: b.res, ret: b.ret, reb: Math.round((X.rebInfo(b).amt || 0) * 100) / 100, cust: b.cust || "", rate: (b.rebO && b.rebO.特码)
  }));
  return {
    rows, cases, before: before.includes("平特尾") || before.includes("平特6"),
    hitBefore: /平特尾/.test(before),
    opened, msg: document.getElementById("wb_msg").textContent,
    saveLabel: document.getElementById("wb_save").textContent,
    editHidden: document.getElementById("wb_editbar").style.display,
    n: bets.length,
    grps: [...new Set(X.D.bets.filter((b) => b.date === dt).map((b) => b.grp))],
    ping: bets.filter((b) => b.type === "平特尾数").length,
    tail,
    card: document.getElementById("wb_cards").innerText.slice(0, 500),
    hasEdit: !!document.querySelector("[data-ed]")
  };
})()`;

function numsOf(rows, pred) {
  return rows.filter(pred).map((r) => r.content.padStart(2, "0")).sort();
}

function assertPing(name, rows) {
  if (rows.length !== 1) throw new Error(name + " 注数 " + rows.length + " " + JSON.stringify(rows));
  const r = rows[0];
  if (r.type !== "平特尾数" || r.content !== "6" && r.content !== "8" && r.content !== "7") {
    throw new Error(name + " 不是平特尾: " + JSON.stringify(r));
  }
  if (r.warn) throw new Error(name + " 有警告: " + r.warn);
}

async function main() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (!html.includes("尾各数为特码")) throw new Error("版本说明没有尾各数");
  if (!html.includes('data-ed=')) throw new Error("注单没有改按钮");
  const server = await serve();
  const port = server.address().port;
  const userDir = fs.mkdtempSync("/tmp/wb-tail-");
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
    await b.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__WBTEST=true;window.__alerts=[];window.alert=function(m){window.__alerts.push(String(m));};window.confirm=function(){return true;};",
    }, sessionId);
    const loaded = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("load timeout")), 30000);
      const iv = setInterval(async () => {
        try {
          const t0 = await evalJs(b, sessionId, `(document.getElementById("wb_ballstat")||{}).textContent||""`);
          if (String(t0).includes("测试模式")) { clearTimeout(t); clearInterval(iv); resolve(); }
        } catch (e) {}
      }, 100);
    });
    await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
    await loaded;
    const r = await evalJs(b, sessionId, CHECK);
    if (r.err) throw new Error(r.err + " " + (r.before || ""));
    const tema = r.rows.filter((x) => x.zexp === "6尾");
    if (tema.length !== 5) throw new Error("6尾各数 不是 5 个特码: " + JSON.stringify(tema));
    if (numsOf(tema, () => true).join() !== TAIL6.join()) throw new Error("尾6号码 " + numsOf(tema, () => true));
    if (tema.some((x) => x.type !== "特码单码" || x.amount !== 400 || x.lot !== "香港" || x.warn)) throw new Error("尾6注不对: " + JSON.stringify(tema));
    if (r.rows.some((x) => x.type === "平特尾数")) throw new Error("整单里还有平特尾: " + JSON.stringify(r.rows.filter((x) => x.type === "平特尾数")));
    if (r.rows.some((x) => x.lot !== "香港")) throw new Error("有注不是香港");
    const groups = {};
    r.rows.filter((x) => !x.zexp).forEach((x) => { groups[x.amount] = (groups[x.amount] || 0) + 1; });
    const expectG = { 200: 13, 50: 15, 30: 7, 130: 17, 20: 12 };
    for (const [amt, n] of Object.entries(expectG)) {
      if (groups[amt] !== n) throw new Error("各" + amt + " 应有 " + n + " 个号，实际 " + groups[amt]);
    }
    if (r.rows.filter((x) => !x.zexp).some((x) => x.type !== "特码单码")) throw new Error("号码组不是特码");
    assertPing("6尾500", r.cases.plain);
    if (r.cases.plain[0].amount !== 500 || r.cases.plain[0].content !== "6") throw new Error("6尾500 " + JSON.stringify(r.cases.plain));
    assertPing("500.6尾", r.cases.dot);
    if (r.cases.dot[0].amount !== 500 || r.cases.dot[0].type !== "平特尾数" || r.cases.dot[0].content !== "6") throw new Error("500.6尾 " + JSON.stringify(r.cases.dot));
    if (numsOf(r.cases.rev, () => true).join() !== TAIL6.join() || r.cases.rev.some((x) => x.type !== "特码单码" || x.amount !== 400)) throw new Error("各数6尾 " + JSON.stringify(r.cases.rev));
    if (numsOf(r.cases.spaced, () => true).join() !== TAIL6.join()) throw new Error("各 数 没合并 " + JSON.stringify(r.cases.spaced));
    if (numsOf(r.cases.zero, () => true).join() !== "10,20,30,40") throw new Error("0尾 " + numsOf(r.cases.zero, () => true));
    if (r.cases.ge.length !== 1 || r.cases.ge[0].type !== "平特尾数" || r.cases.ge[0].content !== "7" || r.cases.ge[0].amount !== 400) throw new Error("7尾各 应仍是平特尾 " + JSON.stringify(r.cases.ge));
    if (r.cases.ping.length !== 1 || r.cases.ping[0].type !== "平特尾数" || r.cases.ping[0].content !== "8" || r.cases.ping[0].amount !== 500) throw new Error("平特8尾 " + JSON.stringify(r.cases.ping));
    const both = numsOf(r.cases.both, () => true);
    const wantBoth = [];
    for (let n = 1; n <= 49; n++) if (n % 10 === 6 || n % 10 === 8) wantBoth.push(String(n).padStart(2, "0"));
    if (both.join() !== wantBoth.join() || r.cases.both.some((x) => x.zexp !== "6尾8尾" || x.amount !== 10)) throw new Error("6.8尾各数 " + both + " " + JSON.stringify(r.cases.both[0]));
    if (!r.hitBefore) throw new Error("改之前界面没有把旧单显示成平特尾");
    if (!r.opened.open || !r.opened.text.includes("6尾各数400") || !r.opened.text.includes("各20")) throw new Error("改单没载入原文: " + JSON.stringify(r.opened));
    if (!r.opened.label.includes("保存修改") || !r.opened.bar.includes("第2单")) throw new Error("改单提示不对: " + JSON.stringify(r.opened));
    if (!/已改第2单/.test(r.msg)) throw new Error("保存提示不对: " + r.msg);
    if (r.saveLabel !== "保存" || r.editHidden !== "none") throw new Error("改完没有退出编辑");
    if (r.ping) throw new Error("改完仍有平特尾");
    if (r.grps.join() !== "2") throw new Error("改单变成了别的单号: " + r.grps);
    if (numsOf(r.tail, () => true).join() !== TAIL6.join()) throw new Error("改完尾号 " + numsOf(r.tail, () => true));
    if (r.tail.some((x) => x.type !== "特码单码" || x.amount !== 250 || x.lot !== "香港" || x.cust !== "甲" || x.rate !== 4)) throw new Error("改完金额或客户不对: " + JSON.stringify(r.tail));
    const win = r.tail.find((x) => x.content === "16");
    if (!win || win.res !== "win" || win.ret !== 250 * 47) throw new Error("16 没有按特码重结算: " + JSON.stringify(win));
    if (r.tail.some((x) => x.content !== "16" && x.res !== "lose")) throw new Error("其他尾号不该中: " + JSON.stringify(r.tail));
    const reb = r.tail.reduce((a, x) => a + x.reb, 0);
    if (Math.abs(reb - 50) > 0.001) throw new Error("五个特码退水应是 50，实际 " + reb);
    if (/平特尾/.test(r.card)) throw new Error("改完卡片还写平特尾: " + r.card);
    if (!r.card.includes("特码") || !r.hasEdit) throw new Error("改完卡片没有特码或改按钮: " + r.card);
    const art = process.env.ARTIFACTS || "/opt/cursor/artifacts";
    fs.mkdirSync(art, { recursive: true });
    const shot = await b.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(path.join(art, "tail_each_resettle.png"), Buffer.from(shot.data, "base64"));
    console.log("ok 6尾各数 → 特码", TAIL6.join(" "), "；6尾500 / 500.6尾 仍是平特尾；改单后 16 中", win.ret);
    b.close();
  } finally {
    chrome.kill("SIGKILL");
    server.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
