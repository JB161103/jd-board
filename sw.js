// 휴대폰 '앱처럼 설치' + '공유 → JD 보드' 기능을 담당하는 파일입니다. 고칠 일은 거의 없습니다.
const CACHE = "jd-shell-v1";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json", "./icons/icon-192.png"];
const scoped = (p) => new URL(p, self.registration.scope).href;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== "share-target").map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 갤럭시에서 스크린샷을 '공유 → JD 보드'로 보냈을 때
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const files = fd.getAll("images");
      const c = await caches.open("share-target");
      for (const k of await c.keys()) await c.delete(k);
      let i = 0;
      for (const f of files) {
        await c.put(scoped(`shared/${i++}`), new Response(f, { headers: { "content-type": f.type, "x-name": encodeURIComponent(f.name || "shared.jpg") } }));
      }
      return Response.redirect(scoped("./?shared=1"), 303);
    })());
    return;
  }

  // 사이트 파일: 항상 최신 버전을 먼저 받고, 인터넷이 끊기면 저장본 사용
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
