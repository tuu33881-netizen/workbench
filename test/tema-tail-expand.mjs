/**
 * v21.18：特N尾 / 特码N尾各X 展开成特码单码。
 * 平特尾、各数N尾、连肖缺复式（应选标红）保持原样。
 *
 * 用法: node test/tema-tail-expand.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";
const TAIL6 = ["06", "16", "26", "36", "46"];
const TAIL8 = ["08", "18", "28", "38", "48"];
const TAIL68 = [...TAIL6, ...TAIL8];

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

const CHECK = `(() => {
  const X = window.__WB;
  const pack = (r) => ({
    type: r.type, content: String(r.content), amount: r.amount, odds: r.odds,
    warn: r.warn || "", lot: r.lot || "", bad: badOf(r), zexp: r.zexp || ""
  });
  const one = (s) => X.parseBets(s).map(pack);
  const tema = one("06各20")[0];
  const slip = "特6.8尾各20";
  document.getElementById("wb_text").value = slip;
  document.getElementById("wb_save").click();
  const saved = X.D.bets.map((b) => ({
    type: b.type, content: String(b.content), amount: b.amount, odds: b.odds, lot: b.lot
  }));
  const draw16 = [1, 2, 3, 4, 5, 7, 16];
  const judged = saved.map((b) => ({ content: b.content, ...X.judge(b, draw16) }));
  return {
    version: (document.querySelector("#set .note small") || {}).textContent || "",
    sw: ${JSON.stringify((fs.readFileSync(path.join(root, "sw.js"), "utf8").match(/wb-v\d+/) || [""])[0])},
    temaOdds: tema && tema.odds,
    temaReb: X.rebInfo({ type: "特码单码", content: "06", amount: 20 }),
    expReb: X.rebInfo(X.parseBets(slip)[0] || {}),
    cases: {
      "特6.8尾各20": one(slip),
      "特6尾20": one("特6尾20"),
      "特码6尾各20": one("特码6尾各20"),
      "特6尾各20": one("特6尾各20"),
      "6尾各数20": one("6尾各数20"),
      "各数6尾20": one("各数6尾20"),
      "6尾500": one("6尾500"),
      "二连肖羊鸡虎各30": one("二连肖羊鸡虎各30"),
      "二连肖羊鸡各30": one("二连肖羊鸡各30"),
      "特6.8尾20": one("特6.8尾20"),
      "香港特6尾20": one("香港特6尾20")
    },
    saved,
    msg: (document.getElementById("wb_msg") || {}).textContent || "",
    alerts: window.__alerts || [],
    sum: (document.getElementById("wb_sum") || {}).textContent || "",
    judged
  };
})()`;

function contents(rows) {
  return rows.map((r) => r.content);
}

function assertTema(name, rows, expect, amount) {
  const got = contents(rows);
  if (rows.some((r) => r.type !== "特码单码")) throw new Error(name + " 不是特码: " + JSON.stringify(rows.slice(0, 3)));
  if (rows.some((r) => r.type === "特码尾数")) throw new Error(name + " 仍是特码尾数");
  if (got.join(" ") !== expect.join(" ")) throw new Error(name + " 号码 " + got.join(" ") + " != " + expect.join(" "));
  if (rows.some((r) => r.amount !== amount || r.warn || r.bad)) throw new Error(name + " 金额/警告不对: " + JSON.stringify(rows[0]));
  const stake = rows.reduce((a, r) => a + r.amount, 0);
  if (stake !== expect.length * amount) throw new Error(name + " 总额 " + stake);
}

async function main() {
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
    const c = r.cases;
    assertTema("特6.8尾各20", c["特6.8尾各20"], TAIL68, 20);
    assertTema("特6尾20", c["特6尾20"], TAIL6, 20);
    assertTema("特码6尾各20", c["特码6尾各20"], TAIL6, 20);
    assertTema("特6尾各20", c["特6尾各20"], TAIL6, 20);
    assertTema("6尾各数20", c["6尾各数20"], TAIL6, 20);
    assertTema("各数6尾20", c["各数6尾20"], TAIL6, 20);
    if (c["特6.8尾各20"].some((x) => x.odds !== r.temaOdds)) throw new Error("特尾展开赔率不是普通特码 " + c["特6.8尾各20"][0].odds + " vs " + r.temaOdds);
    if (!r.expReb || r.expReb.rate !== r.temaReb.rate || r.expReb.amt !== r.temaReb.amt) throw new Error("退点不是特码: " + JSON.stringify(r.expReb) + " vs " + JSON.stringify(r.temaReb));
    const ping = c["6尾500"];
    if (ping.length !== 1 || ping[0].type !== "平特尾数" || ping[0].amount !== 500 || ping[0].bad) throw new Error("6尾500 应仍是平特尾: " + JSON.stringify(ping));
    const lian = c["二连肖羊鸡虎各30"];
    if (lian.length !== 1 || !lian[0].bad || !/应选/.test(lian[0].warn)) throw new Error("连肖缺复式应标红: " + JSON.stringify(lian));
    const lianOk = c["二连肖羊鸡各30"];
    if (lianOk.length !== 1 || lianOk[0].bad || lianOk[0].type !== "二连肖") throw new Error("正常二连肖被挡: " + JSON.stringify(lianOk));
    const noEach = c["特6.8尾20"];
    if (!noEach.length || noEach.some((x) => !x.bad) || !noEach.some((x) => /没写各/.test(x.warn))) throw new Error("多尾没写各应标红: " + JSON.stringify(noEach));
    const hk = c["香港特6尾20"];
    assertTema("香港特6尾20", hk, TAIL6, 20);
    if (hk.some((x) => x.lot !== "香港")) throw new Error("香港彩种丢了: " + JSON.stringify(hk[0]));
    if (r.alerts.length) throw new Error("特6.8尾各20 保存被拦: " + r.alerts.join(" | "));
    if (r.saved.length !== 10 || r.saved.some((x) => x.type !== "特码单码" || x.amount !== 20)) throw new Error("没有存成 10 注特码: " + r.msg + " " + JSON.stringify(r.saved));
    if (contents(r.saved).join(" ") !== TAIL68.join(" ")) throw new Error("存下的号码不对: " + contents(r.saved).join(" "));
    const win = r.judged.find((x) => x.content === "16");
    const lose6 = r.judged.find((x) => x.content === "06");
    const lose8 = r.judged.find((x) => x.content === "08");
    if (!win || win.res !== "win") throw new Error("特码 16 未中 6 尾: " + JSON.stringify(win));
    if (!lose6 || lose6.res !== "lose" || !lose8 || lose8.res !== "lose") throw new Error("不中的尾被算中: " + JSON.stringify(r.judged));
    if (win.ret !== 20 * r.temaOdds) throw new Error("中奖金额不是普通特码: " + win.ret);
    if (!r.version.includes("v21.19") || !r.version.includes("特N尾各X展开成特码") || !r.version.includes("同行彩种标签归前段")) throw new Error("版本不对: " + r.version);
    if (!r.sw.includes("wb-v2119")) throw new Error("缓存名不对: " + r.sw);
    console.log("ok v21.19 特6.8尾各20 →", TAIL68.join(" "), "各20，共", r.saved.length, "注可保存");
    console.log("平特尾", JSON.stringify(ping[0]));
    console.log("连肖仍红", lian[0].warn);
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
