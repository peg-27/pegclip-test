/* ==========================================================
   PEGクリップ  sw.js
   役割は2つだけ
     1. 共有メニューから送られてきたもの（POST）を受け取って
        IndexedDBの inbox に入れ、アプリを開き直す
     2. 最低限のキャッシュ（オフラインでも開けるように）
   ※ バージョン番号の更新はPEGさんが手で行う
   ========================================================== */

const VERSION = 'pegclip-v7';
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
  // 送信先はアプリのトップ（./）。旧設定の ./share-target も念のため受け付ける
  const scopePath = new URL('./', self.location).pathname;
  if(event.request.method === 'POST' &&
     (url.pathname === scopePath || url.pathname === scopePath + 'index.html' || url.pathname.endsWith('/share-target'))){
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
// 診断モード：受け取った中身の一覧を【診断】カードとして残す。原因が分かったら false にする
const DEBUG_SHARE = true;

async function handleShare(request){
  const log = [];
  const items = [];
  try{
    // 診断用：Chromeが送ってきたデータの大きさと形式を記録する（読むのは複製の方）
    const type = (request.headers.get('content-type') || 'なし').split(';')[0];
    const size = (await request.clone().arrayBuffer()).byteLength;
    log.push(`送信形式: ${type}`);
    log.push(`送信サイズ: ${size}バイト`);

    const form  = await request.formData();
    const title = (form.get('title') || '').toString().trim();
    const text  = (form.get('text')  || '').toString().trim();
    const url   = (form.get('url')   || '').toString().trim();
    const now = Date.now();

    // 項目名に関係なく、届いたファイルをすべて拾う
    let n = 0;
    for(const [key, value] of form.entries()){
      if(typeof value === 'string'){
        log.push(`${key}: 文字 ${value.length}字`);
        continue;
      }
      log.push(`${key}: ファイル ${value.type || '種類不明'} ${value.size}バイト`);
      if(value.size > 0){
        // ファイルのままではなく中身を読み出してから保存する（保存失敗の対策）
        const buf  = await value.arrayBuffer();
        const blob = new Blob([buf], { type: value.type || 'image/png' });
        items.push({ id: newId(), kind:'image', blob:blob, title:title, createdAt: now + n });
        n++;
      }
    }
    if(log.length === 0) log.push('届いた項目なし');

    // URLとテキストの両方が来ることがある。URLを優先し、別内容のテキストがあれば分けて入れる
    if(url){
      items.push({ id:newId(), kind:'text', text:url, title:title, createdAt: now + 100 });
      if(text && text !== url && !text.includes(url)){
        items.push({ id:newId(), kind:'text', text:text, title:title, createdAt: now + 101 });
      }
    } else if(text){
      items.push({ id:newId(), kind:'text', text:text, title:title, createdAt: now + 100 });
    }
  }catch(err){
    log.push('受け取り失敗: ' + (err && err.message || err));
  }

  if(DEBUG_SHARE){
    items.push({ id:newId(), kind:'text', text:'【診断】\n' + log.join('\n'), title:'', createdAt: Date.now() + 200 });
  }

  // 1件ずつ保存する（1件の失敗で全部が消えないように）
  for(const it of items){
    try{
      await putInbox([it]);
    }catch(err){
      try{
        await putInbox([{ id:newId(), kind:'text', text:'【診断】保存失敗: ' + it.kind + ' / ' + (err && err.message || err), title:'', createdAt: Date.now() + 300 }]);
      }catch(e){}
    }
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
