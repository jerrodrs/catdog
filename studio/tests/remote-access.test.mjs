import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {remoteAccess} from '../remote-access.mjs';
import {Readable,Writable} from 'node:stream';
import {createStudio} from '../server.mjs';

test('local-only hosting retains exact host restrictions',()=>{
  const access=remoteAccess({});
  assert.equal(access.origin('localhost:4317',4317),'http://localhost:4317');
  assert.equal(access.origin('127.0.0.1:4317',4317),'http://127.0.0.1:4317');
  for(const host of ['evil.test','localhost:4318','localhost:4317.evil.test'])assert.equal(access.origin(host,4317),null);
  assert.equal(access.authorized(),true);
});

test('remote hosting requires credentials and pins the HTTPS origin',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-access-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'password');fs.writeFileSync(file,'a-long-random-test-password\n',{mode:0o600});
  const env={CARD_STUDIO_PUBLIC_URL:'https://cards.example.com',CARD_STUDIO_PASSWORD_FILE:file};
  const access=remoteAccess(env),basic=value=>'Basic '+Buffer.from(value).toString('base64');
  assert.equal(access.origin('cards.example.com',4317),'https://cards.example.com');
  assert.equal(access.origin('other.example.com',4317),null);
  assert.equal(access.authorized(),false);
  assert.equal(access.authorized('Bearer anything'),false);
  assert.equal(access.authorized(basic('studio:wrong')),false);
  assert.equal(access.authorized(basic('other:a-long-random-test-password')),false);
  assert.equal(access.authorized(basic('studio:a-long-random-test-password')),true);
  assert.throws(()=>remoteAccess({CARD_STUDIO_PUBLIC_URL:'https://cards.example.com'}),/password/);
  for(const url of ['http://cards.example.com','https://cards.example.com/path','https://user@cards.example.com'])assert.throws(()=>remoteAccess({...env,CARD_STUDIO_PUBLIC_URL:url}),/HTTPS origin/);
});

test('failed logins are throttled per client and globally, then expire',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-auth-throttle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'password');fs.writeFileSync(file,'foig');
  let now=1000;
  const access=remoteAccess({CARD_STUDIO_PUBLIC_URL:'https://cards.example.com',CARD_STUDIO_USERNAME:'big',CARD_STUDIO_PASSWORD_FILE:file},()=>now);
  const good='Basic '+Buffer.from('big:foig').toString('base64');
  assert.equal(access.attempt(good,'owner').authorized,true);
  for(let i=0;i<8;i++)assert.equal(access.attempt('Basic wrong','attacker').authorized,false);
  assert.equal(access.attempt(good,'attacker').retryAfter,600);
  assert.equal(access.attempt(good,'owner').authorized,true);
  for(let i=0;i<32;i++)access.attempt('Basic wrong','attacker-'+i);
  assert.equal(access.attempt(good,'owner').retryAfter,600);
  now+=600001;
  assert.equal(access.attempt(good,'owner').authorized,true);
});

test('public requests require login before bootstrap and keep cross-origin writes blocked',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-remote-http-'));
  const password=path.join(dir,'password');fs.writeFileSync(password,'a-long-random-test-password');
  const app=createStudio({library:path.join(dir,'library'),seed:false,status:{installed:false,signed_in:false},
    accessEnvironment:{CARD_STUDIO_PUBLIC_URL:'https://cards.example.com',CARD_STUDIO_PASSWORD_FILE:password}});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const auth='Basic '+Buffer.from('studio:a-long-random-test-password').toString('base64');
  const request=(url,headers={},method='GET',body='')=>new Promise(resolve=>{
    const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{url,method,headers:{host:'cards.example.com',...headers}});
    const chunks=[];const res=new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}});
    res.statusCode=200;res.setHeader=()=>{};res.writeHead=code=>{res.statusCode=code;};
    res.on('finish',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));
    app.server.emit('request',req,res);
  });
  assert.equal((await request('/api/bootstrap')).status,401);
  assert.equal((await request('/style.css')).status,401);
  const boot=await request('/api/bootstrap',{authorization:auth});assert.equal(boot.status,200);
  const token=JSON.parse(boot.text).token;
  const headers={authorization:auth,'content-type':'application/json','x-studio-token':token};
  assert.equal((await request('/api/queue',{...headers,origin:'https://evil.example'},'POST','{"paused":true}')).status,403);
  assert.equal((await request('/api/queue',{...headers,origin:'https://cards.example.com'},'POST','{"paused":true}')).status,200);
  assert.equal((await request('/api/bootstrap',{authorization:auth,host:'evil.example'})).status,403);
});
