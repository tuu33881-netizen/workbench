/**
 * 同一单三行：生肖各 → 特肖；红波单 / 绿波双 → 对应特码。能保存。
 * 各数仍展开成特码。
 *
 * 用法: node test/parse-slip.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const SLIP = "猪牛狗羊兔狗各30\n红波单各30\n绿波双各30";
const RED_ODD = [1, 7, 13, 19, 23, 29, 35, 45];
const GREEN_EVEN = [6, 16, 22, 28, 32, 38, 44];

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
        waitEvent(method, sessionId, ms = 20000) {
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("timeout " + method)), ms);
            const fn = (m) => {
              if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
                clearTimeout(t);
                res(m.params);
              }
            };
            ws.addEventListener("message", function on(ev) {
              const m = JSON.parse(ev.data);
              if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
              else fn(m);
            });
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
    throw new Error(d.text || (d.exception && d.exception.description) || JSON.stringify(d));
  }
  return ev.result && ev.result.value;
}

const CHECK = `(() => {
  const X = window.__WB;
  const text = ${JSON.stringify(SLIP)};
  const rows = X.parseBets(text);
  const pack = (r) => ({ type: r.type, content: String(r.content), amount: r.amount, warn: r.warn || "", grp: r.grp, zexp: r.zexp || "" });
  document.getElementById("wb_text").value = text;
  document.getElementById("wb_save").click();
  const saved = X.D.bets.map(pack);
  const zx = X.parseBets("鸡猴兔各数15").map(pack);
  const allRed = X.parseBets("红波各10").map(pack);
  return {
    rows: rows.map(pack),
    saved,
    msg: (document.getElementById("wb_msg") || {}).textContent || "",
    alerts: window.__alerts || [],
    version: (document.querySelector("#set .note small") || {}).textContent || "",
    zx,
    allRed: allRed.length
  };
})()`;

function numsOf(rows) {
  return rows.map((r) => Number(r.content)).sort((a, b) => a - b);
}

async function main() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (/各\s*(?=\d)/.test(html) && html.includes('"$1$2各数"')) throw new Error("仍把生肖各改写成各数");
  const server = await serve();
  const port = server.address().port;
  const userDir = fs.mkdtempSync("/tmp/wb-parse-");
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
    if (r.alerts.length) throw new Error("保存被拦住: " + r.alerts.join(" | "));
    if (!/已保存 1 单（21 注）/.test(r.msg)) throw new Error("保存结果不对: " + r.msg + " bets=" + r.saved.length);
    const zod = r.rows.filter((x) => x.type === "一肖");
    const tema = r.rows.filter((x) => x.type === "特码单码");
    if (zod.map((x) => x.content).join("") !== "猪牛狗羊兔狗") throw new Error("特肖不是 6 注: " + JSON.stringify(zod));
    if (zod.some((x) => x.amount !== 30 || x.warn || x.grp !== 1)) throw new Error("特肖金额或警告不对: " + JSON.stringify(zod));
    if (tema.some((x) => x.type !== "特码单码" || x.amount !== 30 || x.warn)) throw new Error("波色注有警告: " + JSON.stringify(tema.filter((x) => x.warn || x.amount !== 30)));
    const gotRed = numsOf(tema.filter((x) => RED_ODD.includes(Number(x.content))));
    const gotGreen = numsOf(tema.filter((x) => GREEN_EVEN.includes(Number(x.content))));
    if (tema.length !== RED_ODD.length + GREEN_EVEN.length) throw new Error("特码注数 " + tema.length + " 内容 " + tema.map((x) => x.content).join(" "));
    if (gotRed.join() !== RED_ODD.join()) throw new Error("红波单 " + gotRed + " != " + RED_ODD);
    if (gotGreen.join() !== GREEN_EVEN.join()) throw new Error("绿波双 " + gotGreen + " != " + GREEN_EVEN);
    if (r.rows.some((x) => /没认出|没写各|没找到/.test(x.warn || ""))) throw new Error("有未识别: " + JSON.stringify(r.rows.filter((x) => x.warn)));
    if (r.saved.length !== 21 || r.saved.some((x) => x.grp !== 1)) throw new Error("没有存成同一单: " + r.saved.length);
    if (zod.some((x) => x.zexp)) throw new Error("特肖被展开成各数");
    if (!r.zx.length || r.zx.some((x) => x.type !== "特码单码" || !x.zexp)) throw new Error("各数没有展开特码: " + JSON.stringify(r.zx.slice(0, 3)));
    if (r.zx.length < 8) throw new Error("各数展开太少: " + r.zx.length);
    if (r.allRed < 16) throw new Error("红波各应展开全部红波，实际 " + r.allRed);
    if (!r.version.includes("v21.11")) throw new Error("版本不是 v21.11: " + r.version);
    console.log("ok 同一单 特肖6 + 红单" + gotRed.length + " + 绿双" + gotGreen.length + "，" + r.msg);
    console.log("特肖", zod.map((x) => x.content).join(""));
    console.log("红波单", gotRed.map((n) => String(n).padStart(2, "0")).join(" "));
    console.log("绿波双", gotGreen.map((n) => String(n).padStart(2, "0")).join(" "));
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
