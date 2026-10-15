// Local-only synthetic component preview; never added to Next routes or builds.
import { createServer } from 'vite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.env.NODE_ENV === 'production')
  throw new Error('Preview is development-only.');
const web = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'bb-product-preview-'));
await writeFile(
  join(root, 'index.html'),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SYNTHETIC LOCAL PREVIEW — Products</title><body><div id="root"></div><script type="module" src="/preview.tsx"></script></body></html>',
);
await writeFile(
  join(root, 'preview.tsx'),
  `
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Products} from '/@fs/${web}src/components/admin/products.tsx';
import {ProductGallery} from '/@fs/${web}src/components/admin/gallery.tsx';
import {mediaFixture} from '/@fs/${web}scripts/media-fixture.ts';
import {AdminNavigation} from '/@fs/${web}src/components/admin/navigation.tsx';
import {summaryOf} from '/@fs/${web}src/lib/admin/products.ts';
import '/@fs/${web}src/app/globals.css';
import '/@fs/${web}src/app/admin/admin.css';
const original = {productId:'01K00000000000000000000001',name:'Synthetic chocolate cookie',slug:'synthetic-chocolate-cookie',description:'Preview fixture only. No real catalog or AWS connection.',ingredients:['Synthetic flour','Synthetic cocoa'],allergens:['Wheat'],active:true,createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:00:00.000Z'};
const recoveryMode=new URLSearchParams(location.search).has('recover');
const fixtureKey='bb-synthetic-preview-fixtures';
if(!recoveryMode){sessionStorage.removeItem('bb-product-create:synthetic-preview');sessionStorage.removeItem(fixtureKey);}
const saved=recoveryMode?JSON.parse(sessionStorage.getItem(fixtureKey)||'null'):null;
let products = new URLSearchParams(location.search).has('empty') ? [] : [original,{...original,productId:'01K00000000000000000000002',name:'Synthetic inactive cookie',slug:'synthetic-inactive-cookie',active:false}];
let calls=saved?.calls||0;const receipts=new Map(saved?.receipts||[]);let loseOnce=saved?.loseOnce??new URLSearchParams(location.search).has('lost');
if(saved)products=saved.products;
const persist=()=>{if(recoveryMode)sessionStorage.setItem(fixtureKey,JSON.stringify({products,calls,receipts:[...receipts],loseOnce}));};
const galleryFixture=mediaFixture(sessionStorage);
window.fetch=async(input,init={})=>{
 const url=new URL(String(input),location.origin);if(url.origin!==location.origin || !url.pathname.startsWith('/api/admin/')) throw new Error('Preview blocks all non-mocked requests');
 await new Promise(r=>setTimeout(r,150));
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 if(url.pathname==='/api/admin/logout') return reply({revocationConfirmed:false});
 if(new URLSearchParams(location.search).has('error'))return reply({code:'UNAVAILABLE',message:'Synthetic service failure.'},503);
 const media=await galleryFixture.handle(url,init);if(media)return media;
 const id=url.pathname.split('/')[4];const method=init.method||'GET';
 if(url.searchParams.has('creationKey'))return reply({creation:receipts.get(url.searchParams.get('creationKey'))?.product||null});
 if(method==='GET')return id?products.some(p=>p.productId===id)?reply({product:products.find(p=>p.productId===id)}):reply({code:'PRODUCT_NOT_FOUND',message:'Synthetic product missing.'},404):reply({products:products.map(summaryOf),nextCursor:null,loadedAt:new Date().toISOString()});
 if(!['POST','PUT'].includes(method))throw new Error('Unsupported preview request');
 const {revision,...fields}=JSON.parse(init.body);const previous=products.find(p=>p.productId===id);
 const key=new Headers(init.headers).get('idempotency-key');
 const hash=JSON.stringify(fields);
 if(method==='POST'&&!key)return reply({code:'IDEMPOTENCY_KEY_INVALID',message:'Synthetic creation identity missing.'},400);
 if(method==='POST'&&receipts.has(key)){const old=receipts.get(key);return old.hash===hash?reply({product:old.product},201):reply({code:'IDEMPOTENCY_CONFLICT',message:'This creation request was already used with different details.'},409);}
 if(products.some(p=>p.slug===fields.slug&&p.productId!==id))return reply({code:'SLUG_CONFLICT',message:'This slug is already used. Choose another in Advanced Details.'},409);
 if(method==='PUT'&&(!previous||previous.updatedAt!==revision))return reply({code:'PRODUCT_CONFLICT',message:'Synthetic stale revision.'},409);
 const stamp=new Date().toISOString();const p={...fields,productId:id||'01K000000000000000'+String(++calls+10).padStart(8,'0'),createdAt:previous?.createdAt||stamp,updatedAt:stamp};products=[p,...products.filter(x=>x.productId!==p.productId)];if(method==='POST'){receipts.set(key,{hash,product:structuredClone(p)});if(loseOnce){loseOnce=false;persist();throw new Error('Synthetic lost response after commit');}}persist();return reply({product:p},method==='POST'?201:200);
};
function Preview() {
 const [section,setSection]=useState('products'),[visit,setVisit]=useState(0);
 useEffect(()=>{
   const navigate=(event)=>{
     const a=event.target.closest?.('a');
     if(!a||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
     const url=new URL(a.href);
     if(url.origin!==location.origin||url.search||url.hash||!['/','/admin','/admin/products'].includes(url.pathname))return;
     event.preventDefault();
     const leave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leave);
     if(leave.defaultPrevented&&!window.confirm('Discard unsaved synthetic product changes?'))return;
     setSection(url.pathname==='/admin'?'overview':'products');setVisit(v=>v+1);
   };
   document.addEventListener('click',navigate);
   return ()=>document.removeEventListener('click',navigate);
 },[]);
 return <><aside aria-label="Synthetic media controls"><button onClick={()=>galleryFixture.conflict()}>Simulate next gallery conflict</button><button onClick={()=>galleryFixture.lost()}>Lose next gallery save response</button><button onClick={()=>galleryFixture.enable()}>Enable synthetic processing</button><button onClick={()=>galleryFixture.deny()}>Simulate unauthorized media</button></aside><div style={{padding:'12px',background:'#ffedb6',fontFamily:'sans-serif'}} role="note"><strong>SYNTHETIC LOCAL PREVIEW</strong> — in-memory fixtures only. No authentication, AWS, or real business-data access. Sidebar navigation preserves this session; media manifests and synthetic upload receipts persist in this tab; Product fixtures reset on refresh unless recovery mode is selected. {recoveryMode&&<strong>Recovery mode: synthetic fixtures persist in this tab only.</strong>} <a href="/?empty">Empty (reset)</a> · <a href="/?error">Error (reset)</a> · <a href="/?lost">Lost response (reset)</a> · <a href="/?recover&amp;lost">Reload recovery (synthetic only)</a> · <a href="/">Catalog</a></div>{section==='products'?<Products renderMedia={(product,onDirty)=><ProductGallery key={product.productId} productId={product.productId} recoveryScope="synthetic-preview-gallery" name={product.name} onDirty={onDirty} transfer={async()=>{await new Promise(r=>setTimeout(r,400));}}/>} catalogScope="synthetic-preview" key={visit} expiresAt={Date.now()+900000}/>:<div className="admin-shell"><AdminNavigation current="overview"/><main className="admin-main"><h1>Preview overview</h1><p>This preview demonstrates product management only. Use Products to return to your synthetic catalog. Changes remain in memory; explicit recovery mode also preserves synthetic fixtures across reloads in this tab.</p></main></div>}</>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
`,
);
const server = await createServer({
  configFile: false,
  root,
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      react: resolve(web, 'node_modules/react'),
      'react-dom': resolve(web, 'node_modules/react-dom'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
    fs: { allow: [root, web] },
  },
});
await server.listen();
console.log(
  'Synthetic products preview: http://127.0.0.1:4175 (no AWS access)',
);
