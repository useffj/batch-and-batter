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
import {AdminNavigation} from '/@fs/${web}src/components/admin/navigation.tsx';
import {summaryOf} from '/@fs/${web}src/lib/admin/products.ts';
import '/@fs/${web}src/app/globals.css';
import '/@fs/${web}src/app/admin/admin.css';
const original = {productId:'01K00000000000000000000001',name:'Synthetic chocolate cookie',slug:'synthetic-chocolate-cookie',description:'Preview fixture only. No real catalog or AWS connection.',ingredients:['Synthetic flour','Synthetic cocoa'],allergens:['Wheat'],active:true,createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:00:00.000Z'};
let products = new URLSearchParams(location.search).has('empty') ? [] : [original,{...original,productId:'01K00000000000000000000002',name:'Synthetic inactive cookie',slug:'synthetic-inactive-cookie',active:false}];
let calls=0;
window.fetch=async(input,init={})=>{
 const url=new URL(String(input),location.origin);if(url.origin!==location.origin || !url.pathname.startsWith('/api/admin/')) throw new Error('Preview blocks all non-mocked requests');
 await new Promise(r=>setTimeout(r,150));
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 if(url.pathname==='/api/admin/logout') return reply({revocationConfirmed:false});
 if(new URLSearchParams(location.search).has('error'))return reply({code:'UNAVAILABLE',message:'Synthetic service failure.'},503);
 const id=url.pathname.split('/')[4];const method=init.method||'GET';
 if(method==='GET')return id?products.some(p=>p.productId===id)?reply({product:products.find(p=>p.productId===id)}):reply({code:'PRODUCT_NOT_FOUND',message:'Synthetic product missing.'},404):reply({products:products.map(summaryOf),nextCursor:null,loadedAt:new Date().toISOString()});
 if(!['POST','PUT'].includes(method))throw new Error('Unsupported preview request');
 const {revision,...fields}=JSON.parse(init.body);const previous=products.find(p=>p.productId===id);
 if(method==='PUT'&&(!previous||previous.updatedAt!==revision))return reply({code:'PRODUCT_CONFLICT',message:'Synthetic stale revision.'},409);
 const stamp=new Date().toISOString();const p={...fields,productId:id||'01K000000000000000'+String(++calls+10).padStart(8,'0'),createdAt:previous?.createdAt||stamp,updatedAt:stamp};products=[p,...products.filter(x=>x.productId!==p.productId)];return reply({product:p},method==='POST'?201:200);
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
 return <><div style={{padding:'12px',background:'#ffedb6',fontFamily:'sans-serif'}} role="note"><strong>SYNTHETIC LOCAL PREVIEW</strong> — in-memory fixtures only. No authentication, AWS, or real business-data access. Sidebar navigation preserves this session; a full browser refresh resets fixtures. <a href="/?empty">Empty (reset)</a> · <a href="/?error">Error (reset)</a> · <a href="/">Catalog</a></div>{section==='products'?<Products key={visit} expiresAt={Date.now()+900000}/>:<div className="admin-shell"><AdminNavigation current="overview"/><main className="admin-main"><h1>Preview overview</h1><p>This preview demonstrates product management only. Use Products to return to your synthetic catalog. Your changes remain in memory until a full browser refresh.</p></main></div>}</>;
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
