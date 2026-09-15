/* ==========================================================
   PEGクリップ  sw.js
   役割は2つだけ
     1. 共有メニューから送られてきたもの（POST）を受け取って
        IndexedDBの inbox に入れ、アプリを開き直す
     2. 最低限のキャッシュ（オフラインでも開けるように）
   ※ バージョン番号の更新はPEGさんが手で行う
   ========================================================== */

const VERSION = 'pegclip-v4';
const ASSETS  = ['./', './index.html', './manifest.json'];

const DB_NAME = 'pegclip';
const DB_VER  = 2;
const INBOX   = 'inbox';
const STORE   = 'cards';

/* ---------- インストールと更新 ---------- */
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then(c => c.addAll(ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- 通信の横取り ---------- */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 共有メニューからの送信をここで受け止める
  if(event.request.method === 'POST' && url.pathname.endsWith('/share-target')){
    event.respondWith(handleShare(event.request));
    return;
  }

  if(event.request.method !== 'GET') return;

  // 通信優先。つながらないときだけキャッシュを使う（更新が反映されやすい）
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then(hit => hit || caches.match('./')))
  );
});

/* ---------- 共有の受け取り ---------- */
async function handleShare(request){
  try{
    const form  = await request.formData();
    const title = (form.get('title') || '').toString().trim();
    const text  = (form.get('text')  || '').toString().trim();
    const url   = (form.get('url')   || '').toString().trim();
    const files = form.getAll('files').filter(f => f && f.size > 0);

    const now = Date.now();
    const items = [];

    files.forEach((f, i) => {
      items.push({ id: newId(), kind:'image', blob:f, title:title, createdAt: now + i });
    });

    // URLとテキストの両方が来ることがある。URLを優先し、別内容のテキストがあれば分けて入れる
    if(url){
      items.push({ id:newId(), kind:'text', text:url, title:title, createdAt: now + 100 });
      if(text && text !== url && !text.includes(url)){
        items.push({ id:newId(), kind:'text', text:text, title:title, createdAt: now + 101 });
      }
    } else if(text){
      items.push({ id:newId(), kind:'text', text:text, title:title, createdAt: now + 100 });
    }

    if(items.length > 0) await putInbox(items);
  }catch(err){
    // 受け取りに失敗してもアプリは開く
    console.error(err);
  }

  return Response.redirect(new URL('./?shared=1', self.location).href, 303);
}

/* ---------- IndexedDB（アプリ側と同じDBを使う） ---------- */
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if(!d.objectStoreNames.contains(STORE)){
        const store = d.createObjectStore(STORE, { keyPath:'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if(!d.objectStoreNames.contains(INBOX)){
        d.createObjectStore(INBOX, { keyPath:'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function putInbox(items){
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(INBOX, 'readwrite');
    const store = tx.objectStore(INBOX);
    items.forEach(it => store.put(it));
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
  db.close();
}

function newId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
