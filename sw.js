const C='wb-v2114';const A=['./','index.html','simple.html','manifest.json','icon.svg','draws_xinao.json','draws_hk.json','draws_lao.json'];
const OCR='wb-ocr-1'; // 图片识别库（tesseract.js 及中文模型），第一次用时下载，之后离线可用
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(A.map(u=>new Request(u,{cache:'reload'})))).catch(()=>{}))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C&&k!==OCR).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET')return;
  if(u.hostname==='cdn.jsdelivr.net'&&/tesseract/.test(u.pathname)){
    e.respondWith(caches.open(OCR).then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(n=>{if(n.ok||n.type==='opaque')c.put(e.request,n.clone());return n}))));return}
  if(u.origin!==location.origin)return;
  if(/\/draws_(xinao|hk|lao)\.json$/.test(u.pathname)){
    const stable=u.origin+u.pathname;
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(stable,cp))}return r}).catch(()=>caches.match(stable)));
    return;
  }
  if(u.pathname.startsWith('/api/')||/\/admin(\.html)?$/.test(u.pathname))return; // 授权接口和后台永远走网络
  if(/\/ocr\//.test(u.pathname)){e.respondWith(caches.open(OCR).then(c=>c.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(n=>{if(n.ok)c.put(e.request,n.clone());return n}))));return}
  e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))))});
