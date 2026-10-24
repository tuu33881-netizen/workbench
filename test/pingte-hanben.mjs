/**
 * 平特中奖进输赢按含本：本金 100、平特尾赔率 0.8（不含本录入）中奖，
 * 计入盈亏的派彩是 180，客户输赢 +80、老板输赢 −80。退水仍为 0。
 *
 * 用法: node test/pingte-hanben.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = process.env.CHROME || "google-chrome";

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
    } else {
      waits.forEach((w) => w(m));
    }
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

const CHECK = `(() => {
  const X = window.__WB;
  if (!X || !X.judge) return { err: "no __WB" };
  const apply = (b, nums) => {
    const j = X.judge(b, nums);
    b.res = j.res; b.ret = j.ret;
    return {
      res: j.res, ret: j.ret, win: X.winAmt(b), pl: X.pl(b),
      agg: X.agg([b]).pl, reb: X.rebInfo(b).amt,
      boss: X.settleOf([b]).find(x => x.k === "输赢").t,
      cust: (X.settleOf([b]).find(x => x.k === "客户") || {}).t || ""
    };
  };
  const tail = apply(
    { type: "平特尾数", content: "8", amount: 100, odds: 0.8, net: true, lot: "新澳" },
    [18, 1, 2, 3, 4, 5, 6]
  );
  const zod = apply(
    { type: "平特一肖", content: "蛇", amount: 100, odds: 1, net: true, lot: "新澳" },
    [2, 10, 11, 12, 13, 14, 15]
  );
  const ma = apply(
    { type: "平特", content: "马", amount: 100, odds: 0.8, net: true, lot: "新澳" },
    [1, 10, 11, 12, 13, 14, 15]
  );
  const lian = apply(
    { type: "二连肖", content: "马蛇", amount: 100, odds: 4, net: false, lot: "新澳" },
    [1, 2, 10, 11, 12, 13, 14]
  );
  const tema = apply(
    { type: "特码单码", content: "15", amount: 100, odds: 47, net: false, lot: "新澳" },
    [1, 2, 10, 11, 12, 13, 15]
  );
  const note = (document.querySelector("#set .note") || {}).innerText || "";
  const dt = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const mig = (() => {
    const base = { date: dt, grp: 1, lot: "新澳", issue: "9", res: "win" };
    const payload = {
      rev: 1,
      bets: [
        Object.assign({ id: "p", type: "平特一肖", content: "蛇", amount: 200, odds: 2, net: true, ret: 600 }, base),
        Object.assign({ id: "o", type: "平特", content: "蛇", amount: 200, odds: 1.8, net: true, ret: 560 }, base),
        Object.assign({ id: "k", type: "平特一肖", content: "蛇", amount: 200, odds: 1, net: true, ret: 400 }, base),
        Object.assign({ id: "u", type: "平特", content: "蛇", amount: 200, odds: 2, ret: 400 }, base),
        Object.assign({ id: "w", type: "平特尾数", content: "8", amount: 200, odds: 0.8, net: true, ret: 360 }, base),
        Object.assign({ id: "w2", type: "平特尾数", content: "8", amount: 200, odds: 2, net: true, ret: 600 }, base),
        Object.assign({ id: "t", type: "特码单码", content: "15", amount: 100, odds: 47, net: false, ret: 4700 }, base)
      ],
      settings: { odds: { 平特一肖: 2, 平特: 2, 平特尾数: 0.8, 特码单码: 47 }, auto: false, rebate: { 特码: 4, 平特: 4, 连肖: 4 } },
      trash: [{ id: "tr", date: dt, grp: 2, bets: [Object.assign({ id: "tp", type: "平特一肖", content: "蛇", amount: 200, odds: 2, net: true }, base)] }]
    };
    const raw = JSON.stringify(payload);
    X.Store.setItem("wb_data_v1_local", raw);
    X.Store.setItem("wb_data_v2", raw);
    const d = X.loadData();
    X.setTestData(d, { "新澳|9": { lot: "新澳", issue: "9", date: dt, nums: [18, 2, 10, 11, 12, 14, 15] } });
    X.settleAll();
    const by = (id) => X.D.bets.find((b) => b.id === id) || {};
    const snap = (b) => ({ odds: +b.odds, net: b.net, ret: b.ret, res: b.res });
    const saved = ["wb_data_v1_local", "wb_data_v2"].map((k) => { try { return JSON.parse(X.Store.getItem(k) || "null"); } catch (e) { return null; } }).find((o) => o && o.bets && o.bets.some((b) => b.id === "p"));
    const savedBet = saved && saved.bets.find((b) => b.id === "p");
    const trashBet = ((X.D.trash || [])[0] || {}).bets;
    X.Store.removeItem("wb_data_v1_local");
    X.Store.removeItem("wb_data_v2");
    const fresh = X.loadData();
    const fo = fresh.settings.odds;
    const judgeAt = (type, odds) => X.judge({ type, content: type === "平特尾数" ? "8" : type === "特码单码" ? "15" : "蛇", amount: 200, odds, net: type !== "特码单码", lot: "新澳" }, [18, 2, 10, 11, 12, 14, 15]).ret;
    return {
      ping: snap(by("p")), old: snap(by("o")), keep: snap(by("k")), unset: snap(by("u")),
      tail: snap(by("w")), tail2: snap(by("w2")), tema: snap(by("t")),
      setPing: X.D.settings.odds.平特一肖, setPing2: X.D.settings.odds.平特,
      setTail: X.D.settings.odds.平特尾数, setTema: X.D.settings.odds.特码单码,
      savedOdds: savedBet && +savedBet.odds, savedSet: saved && +saved.settings.odds.平特一肖,
      trashOdds: trashBet && +trashBet[0].odds,
      freshPing: fo.平特一肖, freshPing2: fo.平特, freshTail: fo.平特尾数, freshTema: fo.特码单码,
      freshRet: judgeAt("平特一肖", fo.平特一肖), freshTailRet: judgeAt("平特尾数", fo.平特尾数), freshTemaRet: judgeAt("特码单码", fo.特码单码),
      labelPing: document.getElementById("o_平特一肖").closest("label").textContent,
      labelTail: document.getElementById("o_平特尾数").closest("label").textContent
    };
  })();
  X.setTestData({
    bets: [{ id: "t1", date: dt, grp: 1, type: "平特尾数", content: "8", amount: 100, odds: 0.8, net: true, lot: "新澳", res: "win", ret: 180, issue: "1" }],
    settings: Object.assign({}, X.D.settings, { auto: false, view: "客户" }),
    trash: [], unlock: {}, learn: []
  }, {});
  const dateEl = document.getElementById("wb_date");
  dateEl.value = dt;
  dateEl.dispatchEvent(new Event("change"));
  const mxDate = document.getElementById("mx_date");
  if (mxDate) mxDate.value = dt;
  X.renderMX();
  return {
    tail, zod, ma, lian, tema, note, mig,
    sum: document.getElementById("wb_sum").innerText,
    cards: document.getElementById("wb_cards").innerText,
    mx: document.getElementById("mx_body").innerText
  };
})()`;

function assertCase(name, got, exp) {
  const bad = [];
  for (const [k, v] of Object.entries(exp)) {
    if (k === "boss" || k === "cust") {
      if (!String(got[k] || "").includes(v)) bad.push(`${k} expected to include ${v}, got ${got[k]}`);
    } else if (typeof v === "string") {
      if (got[k] !== v) bad.push(`${k} expected ${v}, got ${got[k]}`);
    } else if (Math.abs(+got[k] - v) > 1e-6) bad.push(`${k} expected ${v}, got ${got[k]}`);
  }
  if (bad.length) throw new Error(name + "\\n  " + bad.join("\\n  ") + "\\n  full " + JSON.stringify(got));
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const userDir = fs.mkdtempSync("/tmp/wb-chrome-");
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userDir}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let browserWs;
  try {
    const m = await waitLine(chrome.stderr, /DevTools listening on (ws:\/\/\S+)/, 15000);
    browserWs = m[1];
    const ver = await fetch(browserWs.replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/version")).then((r) => r.json());
    const b = await cdp(ver.webSocketDebuggerUrl);
    const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
    await b.send("Page.enable", {}, sessionId);
    await b.send("Runtime.enable", {}, sessionId);
    await b.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__WBTEST=true" }, sessionId);
    const loaded = b.waitEvent("Page.loadEventFired", sessionId, 30000);
    await b.send("Page.navigate", { url }, sessionId);
    await loaded;
    const ev = await b.send("Runtime.evaluate", { expression: CHECK, returnByValue: true, awaitPromise: true }, sessionId);
    if (ev.exceptionDetails) throw new Error(JSON.stringify(ev.exceptionDetails));
    const r = ev.result.value;
    if (r.err) throw new Error(r.err);
    assertCase("平特尾 100@0.8", r.tail, { res: "win", ret: 180, win: 180, pl: 80, agg: 80, reb: 0, boss: "-80", cust: "客户赢 80" });
    assertCase("平特一肖 100@1", r.zod, { res: "win", ret: 200, win: 200, pl: 100, reb: 4, boss: "-100" });
    assertCase("平特马 100@0.8", r.ma, { res: "win", ret: 180, win: 180, pl: 80, reb: 0, boss: "-80" });
    assertCase("二连肖 unchanged", r.lian, { res: "win", ret: 400, win: 400, pl: 300, reb: 4 });
    assertCase("特码 unchanged", r.tema, { res: "win", ret: 4700, win: 4700, pl: 4600, reb: 4 });
    if (!r.note.includes("版本 v21.8")) throw new Error("version note missing v21.8: " + r.note);
    if (!/平特中奖含本|平特中奖都含本|特码、平特中奖都含本/.test(r.note)) throw new Error("settings note still not 含本: " + r.note);
    if (/平特中奖=中本金×赔率不含本|平特中奖不含本/.test(r.note)) throw new Error("settings note still says 不含本 payout: " + r.note);
    if (!r.sum.includes("平特尾数") || !r.sum.includes("180")) throw new Error("中奖情况 missing 含本 180: " + r.sum);
    if (!r.sum.includes("-80")) throw new Error("输赢 missing -80: " + r.sum);
    if (!r.cards.includes("100+100*0.8=180") && !r.cards.includes("100+100×0.8=180")) throw new Error("slip formula not 含本: " + r.cards);
    if (!r.mx.includes("180")) throw new Error("兑奖明细 missing 含本 180: " + r.mx);
    if (/不含本/.test(r.mx)) throw new Error("兑奖明细 still says 不含本: " + r.mx);
    if (!r.mx.includes("100+100*0.8=180") && !r.mx.includes("100+100×0.8=180")) throw new Error("兑奖明细 formula not 含本: " + r.mx);
    const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
    if (!sw.includes("wb-v218")) throw new Error("sw cache not bumped");
    const mig = r.mig || {};
    const eq = (name, got, exp) => { if (JSON.stringify(got) !== JSON.stringify(exp)) throw new Error(name + " expected " + JSON.stringify(exp) + " got " + JSON.stringify(got)); };
    eq("saved 平特 odds 2", mig.ping, { odds: 1, net: true, ret: 400, res: "win" });
    eq("saved 平特 odds 1.8", mig.old, { odds: 0.8, net: true, ret: 360, res: "win" });
    eq("saved 平特 odds 1", mig.keep, { odds: 1, net: true, ret: 400, res: "win" });
    eq("unset net odds 2", mig.unset, { odds: 1, net: true, ret: 400, res: "win" });
    eq("平尾 0.8", mig.tail, { odds: 0.8, net: true, ret: 360, res: "win" });
    eq("平尾 odds 2 left alone", mig.tail2, { odds: 2, net: true, ret: 600, res: "win" });
    eq("特码 unchanged", mig.tema, { odds: 47, net: false, ret: 4700, res: "win" });
    if (mig.setPing !== 1 || mig.setPing2 !== 1) throw new Error("settings 平特 not coerced to 1: " + mig.setPing + "/" + mig.setPing2);
    if (mig.setTail !== 0.8) throw new Error("settings 平特尾 changed: " + mig.setTail);
    if (mig.setTema !== 47) throw new Error("settings 特码 changed: " + mig.setTema);
    if (mig.savedOdds !== 1 || mig.savedSet !== 1) throw new Error("migrated odds not persisted: " + mig.savedOdds + " settings " + mig.savedSet);
    if (mig.trashOdds !== 1) throw new Error("trash 平特 odds 2 not migrated: " + mig.trashOdds);
    if (mig.freshPing !== 1 || mig.freshPing2 !== 1 || mig.freshTail !== 0.8 || mig.freshTema !== 47) throw new Error("fresh defaults " + JSON.stringify(mig));
    if (mig.freshRet !== 400) throw new Error("fresh 平特 200 → " + mig.freshRet);
    if (mig.freshTailRet !== 360) throw new Error("fresh 平尾 200 → " + mig.freshTailRet);
    if (mig.freshTemaRet !== 9400) throw new Error("fresh 特码 200@47 → " + mig.freshTemaRet);
    if (!/不含本/.test(mig.labelPing) || !/不含本/.test(mig.labelTail)) throw new Error("settings labels lost 不含本: " + mig.labelPing + " / " + mig.labelTail);
    const simple = fs.readFileSync(path.join(root, "simple.html"), "utf8");
    if (simple.includes("平特中本金")) throw new Error("simple.html still says 平特中本金");
    if (!simple.includes("pps=pw.reduce((a,b)=>a+X.winAmt(b),0)")) throw new Error("simple.html 输赢 still uses 平特本金");
    console.log("ok 平特尾 100@0.8 → 派彩 180，客户 +80 / 老板 -80");
    console.log(r.tail.boss);
    console.log(r.tail.cust);
    const art = process.env.ARTIFACTS || "/opt/cursor/artifacts";
    fs.mkdirSync(art, { recursive: true });
    const saveShot = async (file) => {
      const { data } = await b.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(art, file), Buffer.from(data, "base64"));
    };
    await b.send("Runtime.evaluate", { expression: "document.getElementById('wb_sum').scrollIntoView()" }, sessionId);
    await saveShot("pingte_pnl_slip.png");
    await b.send("Runtime.evaluate", { expression: "document.getElementById('set').classList.add('on'); document.querySelector('#set .note').scrollIntoView({block:'center'})" }, sessionId);
    await saveShot("pingte_settings_note.png");
    await b.send("Runtime.evaluate", { expression: "document.querySelector('#set .note small').scrollIntoView({block:'center'})" }, sessionId);
    await saveShot("pingte_settings_version.png");
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
