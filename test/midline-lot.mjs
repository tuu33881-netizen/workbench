/**
 * v21.19：同一行里贴在注后面的彩种归前一段。
 * 尾数N各X 仍是特码。平尾 / N尾 的平特尾，以及尾0.5各200 的现网结果，都不改。
 *
 * 用法: node test/midline-lot.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const BLUE = ["03", "04", "09", "10", "14", "15", "20", "25", "26", "31", "36", "37", "41", "42", "47", "48"];
const RED = ["01", "02", "07", "08", "12", "13", "18", "19", "23", "24", "29", "30", "34", "35", "40", "45", "46"];
const TAIL3 = ["03", "13", "23", "33", "43"];

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
    throw new Error(d.text || (d.exception && d.exception.description) || JSON.stringify(d));
  }
  return ev.result && ev.result.value;
}

const SLIPS = [
  "蓝波各数10港 红波各5新",
  "特码12.24各10港 平羊50新",
  "尾数3各10",
  "平尾0.5各200",
  "0.5尾各200",
  "尾0.5各200",
  "平龙200港",
  "06各10新",
  "06各10老",
  "香港\n平龙200",
  "平龙200港\n平羊50",
  "香港平龙200新",
  "特6尾20",
  "6尾500",
  "二连肖羊鸡虎各30",
  "老平龙100",
  "香港\n特码8各10奥 平羊20",
  "香港\n平羊50老澳 特码8各10",
  "老澳\n特码12各10香 平羊50",
  "平羊50新奥",
];

const CHECK = `(() => {
  const X = window.__WB;
  const pack = (r) => ({
    type: r.type, content: String(r.content), amount: r.amount,
    lot: r.lot || "", warn: r.warn || "", bad: badOf(r)
  });
  const cases = {};
  for (const s of ${JSON.stringify(SLIPS)}) cases[s] = X.parseBets(s).map(pack);
  return {
    version: (document.querySelector("#set .note small") || {}).textContent || "",
    cases
  };
})()`;

function brief(rows) {
  return rows.map((r) => [r.lot, r.type, r.content, r.amount, r.warn].filter((x) => x !== "").join("|")).join(" ; ");
}

function assertSeg(name, rows, lot, type, contents, amount) {
  if (rows.length !== contents.length) throw new Error(name + " 注数 " + rows.length + " != " + contents.length + " " + brief(rows));
  rows.forEach((r, i) => {
    if (r.lot !== lot || r.type !== type || r.content !== contents[i] || r.amount !== amount || r.warn || r.bad) {
      throw new Error(name + " #" + i + " " + JSON.stringify(r));
    }
  });
}

function assertRows(name, rows, expect) {
  const got = rows.map((r) => [r.lot, r.type, r.content, r.amount, r.warn || ""]);
  const want = expect.map((r) => [r.lot, r.type, r.content, r.amount, r.warn || ""]);
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(name + "\n got " + JSON.stringify(got) + "\n want " + JSON.stringify(want));
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const userDir = fs.mkdtempSync("/tmp/wb-lot-");
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
      source: "window.__WBTEST=true;window.alert=function(){};window.confirm=function(){return true;};",
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
    const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
    if (!r.version.includes("v21.19") || !r.version.includes("同行彩种标签归前段")) throw new Error("版本不对: " + r.version);
    if (!sw.includes("wb-v2119")) throw new Error("缓存名不对");
    const c = r.cases;

    const wave = c["蓝波各数10港 红波各5新"];
    assertSeg("蓝波", wave.slice(0, BLUE.length), "香港", "特码单码", BLUE, 10);
    assertSeg("红波", wave.slice(BLUE.length), "新澳", "特码单码", RED, 5);

    const tema = c["特码12.24各10港 平羊50新"];
    assertRows("特码12.24各10港 平羊50新", tema, [
      { lot: "香港", type: "特码单码", content: "12", amount: 10 },
      { lot: "香港", type: "特码单码", content: "24", amount: 10 },
      { lot: "新澳", type: "平特一肖", content: "羊", amount: 50 },
    ]);

    assertSeg("尾数3各10", c["尾数3各10"], "新澳", "特码单码", TAIL3, 10);
    assertRows("平尾0.5各200", c["平尾0.5各200"], [
      { lot: "新澳", type: "平特尾数", content: "0", amount: 200 },
      { lot: "新澳", type: "平特尾数", content: "5", amount: 200 },
    ]);
    assertRows("0.5尾各200", c["0.5尾各200"], [
      { lot: "新澳", type: "平特尾数", content: "0", amount: 200 },
      { lot: "新澳", type: "平特尾数", content: "5", amount: 200 },
    ]);
    // 现网：裸「尾」加小数点只吃到第一个尾，后面的号被当成特码。这个不改。
    assertRows("尾0.5各200", c["尾0.5各200"], [
      { lot: "新澳", type: "平特尾数", content: "0", amount: 200 },
      { lot: "新澳", type: "特码单码", content: "05", amount: 200 },
    ]);

    assertRows("平龙200港", c["平龙200港"], [{ lot: "香港", type: "平特一肖", content: "龙", amount: 200 }]);
    assertRows("06各10新", c["06各10新"], [{ lot: "新澳", type: "特码单码", content: "06", amount: 10 }]);
    assertRows("06各10老", c["06各10老"], [{ lot: "老澳", type: "特码单码", content: "06", amount: 10 }]);
    assertRows("香港\\n平龙200", c["香港\n平龙200"], [{ lot: "香港", type: "平特一肖", content: "龙", amount: 200 }]);
    assertRows("平龙200港\\n平羊50", c["平龙200港\n平羊50"], [
      { lot: "香港", type: "平特一肖", content: "龙", amount: 200 },
      { lot: "香港", type: "平特一肖", content: "羊", amount: 50 },
    ]);
    assertRows("香港平龙200新", c["香港平龙200新"], [{ lot: "香港", type: "平特一肖", content: "龙", amount: 200 }]);
    assertSeg("特6尾20", c["特6尾20"], "新澳", "特码单码", ["06", "16", "26", "36", "46"], 20);
    assertRows("6尾500", c["6尾500"], [{ lot: "新澳", type: "平特尾数", content: "6", amount: 500 }]);
    const lian = c["二连肖羊鸡虎各30"];
    if (lian.length !== 1 || !lian[0].bad || !/应选/.test(lian[0].warn)) throw new Error("连肖缺复式应标红: " + JSON.stringify(lian));
    assertRows("老平龙100", c["老平龙100"], [{ lot: "老澳", type: "平特一肖", content: "龙", amount: 100 }]);
    assertRows("奥归前段", c["香港\n特码8各10奥 平羊20"], [
      { lot: "新澳", type: "特码单码", content: "08", amount: 10 },
      { lot: "香港", type: "平特一肖", content: "羊", amount: 20 },
    ]);
    assertRows("老澳归前段", c["香港\n平羊50老澳 特码8各10"], [
      { lot: "老澳", type: "平特一肖", content: "羊", amount: 50 },
      { lot: "香港", type: "特码单码", content: "08", amount: 10 },
    ]);
    assertRows("香归前段", c["老澳\n特码12各10香 平羊50"], [
      { lot: "香港", type: "特码单码", content: "12", amount: 10 },
      { lot: "老澳", type: "平特一肖", content: "羊", amount: 50 },
    ]);
    assertRows("平羊50新奥", c["平羊50新奥"], [{ lot: "新澳", type: "平特一肖", content: "羊", amount: 50 }]);

    console.log("ok v21.19 蓝波各数10港 → 香港", BLUE.length, "注；红波各5新 → 新澳", RED.length, "注");
    console.log("ok 特码12.24各10港 / 平羊50新；尾数3各10；平尾与尾0.5各200 保持现网");
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
