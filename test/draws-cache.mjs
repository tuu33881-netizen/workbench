/**
 * 同站开奖缓存：本地静态服上 fetchDraws 只读 draws_*.json，
 * 老澳 ingest 到 kai8 最新期；新澳/香港不回退到 kai8 或旧站。
 *
 * 用法: node test/draws-cache.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const FILES = {
  新澳: "draws_xinao.json",
  香港: "draws_hk.json",
  老澳: "draws_lao.json",
};

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = u === "/" ? "index.html" : u.replace(/^\/+/, "");
      const f = path.normalize(path.join(root, rel));
      if (!f.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(f, (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
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
      if (m) {
        clearTimeout(t);
        stream.off("data", on);
        resolve(m);
      }
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
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else waits.forEach((w) => w(m));
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
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", () => reject(new Error("ws error " + wsUrl)));
  });
}

function loadExpect() {
  const out = {};
  for (const [lot, file] of Object.entries(FILES)) {
    const doc = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    out[lot] = {
      issue: String(doc.issue),
      date: doc.date,
      nums: doc.nums.map(Number),
      k: doc.k || "",
      n: doc.list.length,
    };
  }
  return out;
}

const SNAP = `(() => {
  const X = window.__WB;
  const latest = (lot) => Object.values(X.DRAWS).filter(d => d.lot === lot).sort((a,b) => String(b.issue).localeCompare(String(a.issue)))[0] || null;
  const pack = (d) => d ? { issue: String(d.issue), date: d.date || "", nums: (d.nums || []).map(Number), n: Object.values(X.DRAWS).filter(x => x.lot === d.lot).length } : null;
  return {
    out: window.__drawOut || null,
    log: window.__fetchLog || [],
    stat: (document.getElementById("wb_ballstat") || {}).textContent || "",
    version: (document.querySelector("#set .note small") || {}).textContent || "",
    draws: { 新澳: pack(latest("新澳")), 香港: pack(latest("香港")), 老澳: pack(latest("老澳")) }
  };
})()`;

async function evalJs(b, sessionId, expression) {
  const ev = await b.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (ev.exceptionDetails) {
    const d = ev.exceptionDetails;
    throw new Error(d.text || d.exception && d.exception.description || JSON.stringify(d));
  }
  return ev.result && ev.result.value;
}

async function pollText(b, sessionId, pred, ms) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await evalJs(b, sessionId, `(document.getElementById("wb_ballstat")||{}).textContent||""`);
    if (pred(last || "")) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout ballstat: " + last);
}

function staticCheck() {
  const r = spawnSync(process.execPath, ["scripts/sync-draws.mjs", "--check"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stdout || "") + (r.stderr || ""));
  process.stdout.write(r.stdout);
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  if (!sw.includes("wb-v214")) throw new Error("sw 不是 wb-v214");
  for (const f of Object.values(FILES)) if (!sw.includes(f)) throw new Error("sw 未预缓存 " + f);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (!html.includes("版本 v21.4")) throw new Error("页面版本不是 v21.4");
  if (!html.includes("await fetchLotCache(lot)")) throw new Error("fetchDraws 没有先读同站缓存");
  const laoFn = html.slice(html.indexOf("async function fetchLaoFromSite"), html.indexOf("function rowsFromKai8"));
  const ipAt = laoFn.indexOf("LAO_BASE");
  const cacheAt = laoFn.indexOf("readDrawCache");
  if (cacheAt < 0 || ipAt < 0 || cacheAt > ipAt) throw new Error("老澳仍把 IP 站放在同站缓存前面");
}

async function main() {
  staticCheck();
  const expect = loadExpect();
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const userDir = fs.mkdtempSync("/tmp/wb-draws-");
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userDir}`,
    "--remote-debugging-port=0",
    "about:blank",
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
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__WBTEST=true;window.__fetchLog=[];const _f=window.fetch;window.fetch=function(input,init){try{const u=typeof input==="string"?input:(input&&input.url)||"";window.__fetchLog.push(String(u));}catch(e){}return _f.apply(this,arguments);};`,
    }, sessionId);
    const loaded = browser.waitEvent("Page.loadEventFired", sessionId, 30000);
    await browser.send("Page.navigate", { url }, sessionId);
    await loaded;
    await pollText(browser, sessionId, (t) => t.includes("测试模式"), 15000);
    await evalJs(browser, sessionId, `window.__fetchLog=[];window.__drawOut=null;window.__WB.fetchDraws().then(o=>{window.__drawOut=o;return o;})`);
    const snap = await evalJs(browser, sessionId, SNAP);
    const bad = (snap.log || []).filter((u) => /kai8\.us|macaumarksix|38\.11\.67\.161|104\.233\.144\.245|api\/draws|bmjg/.test(u));
    if (bad.length) throw new Error("开奖路径回退了: " + bad.join(" | "));
    for (const file of Object.values(FILES)) {
      if (!(snap.log || []).some((u) => u.includes(file))) throw new Error("没有请求同站 " + file + " log=" + (snap.log || []).join(" | "));
    }
    if ((snap.log || []).length !== 3) throw new Error("同站缓存应各请求一次，实际 " + (snap.log || []).join(" | "));
    const out = (snap.out || []).join(" ");
    for (const label of ["澳门", "香港", "老澳门"]) {
      const mm = out.match(new RegExp(label + "\\+(\\d+)"));
      if (!mm || Number(mm[1]) < 1) throw new Error("ingest 计数不对: " + out);
    }
    if (/✗/.test(out)) throw new Error("有彩种失败: " + out);
    for (const lot of Object.keys(expect)) {
      const got = snap.draws[lot];
      const exp = expect[lot];
      if (!got) throw new Error(lot + " 没有写入 DRAWS");
      if (got.issue !== exp.issue) throw new Error(lot + " 期号 " + got.issue + " != " + exp.issue);
      if (got.nums.join() !== exp.nums.join()) throw new Error(lot + " 号码 " + got.nums + " != " + exp.nums);
      if (got.date !== exp.date) throw new Error(lot + " 日期 " + got.date + " != " + exp.date);
      if (got.n < exp.n) throw new Error(lot + " 只 ingest 了 " + got.n + " / " + exp.n);
    }
    if (!snap.version.includes("v21.4") || !snap.version.includes("开奖自动含新澳、香港、老澳")) {
      throw new Error("版本文案不对: " + snap.version);
    }
    const lao = expect.老澳;
    const balls = await evalJs(browser, sessionId, `(() => { const el=document.getElementById("wb_date"); el.value=${JSON.stringify(lao.date)}; window.__WB.renderBalls(); return document.getElementById("wb_balls").innerText; })()`);
    const laoNums = lao.nums.map((n) => String(n).padStart(2, "0"));
    if (!balls.includes("老澳门") || !balls.includes(laoNums[6]) || !balls.includes(String(lao.issue).slice(-3))) {
      throw new Error("老澳彩球未显示最新期: " + balls);
    }
    const kIngest = await evalJs(browser, sessionId, `(() => {
      const X=window.__WB;
      X.setTestData(X.D, {});
      const n=X.ingestLao(${JSON.stringify(lao.k)}, ${JSON.stringify(lao.date)});
      const d=Object.values(X.DRAWS).find(x=>x.lot==="老澳");
      return { n, issue: d&&String(d.issue), nums: d&&d.nums.map(Number), date: d&&d.date };
    })()`);
    if (!kIngest || kIngest.issue !== lao.issue || (kIngest.nums || []).join() !== lao.nums.join()) {
      throw new Error("旧 k 字段不能 ingest 老澳最新期: " + JSON.stringify(kIngest));
    }
    const loaded2 = browser.waitEvent("Page.loadEventFired", sessionId, 30000);
    await browser.send("Page.reload", {}, sessionId);
    await loaded2;
    await pollText(browser, sessionId, (t) => t.includes("测试模式"), 15000);
    const again = await evalJs(browser, sessionId, SNAP);
    const lao2 = again.draws.老澳;
    if (!lao2 || lao2.issue !== lao.issue || lao2.nums.join() !== lao.nums.join() || lao2.date !== lao.date) {
      throw new Error("刷新后老澳日期被改写: " + JSON.stringify(lao2));
    }
    console.log("ok 同站缓存 ingest，未回退 kai8/旧站");
    console.log(out);
    console.log("老澳", lao.issue, lao.date, lao.nums.map((n) => String(n).padStart(2, "0")).join(","));
    console.log("新澳", expect.新澳.issue, expect.新澳.date, expect.新澳.nums.map((n) => String(n).padStart(2, "0")).join(","));
    console.log("香港", expect.香港.issue, expect.香港.date, expect.香港.nums.map((n) => String(n).padStart(2, "0")).join(","));
    browser.close();
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
