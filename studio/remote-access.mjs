import fs from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest();

export function remoteAccess(env=process.env,now=Date.now){
  const publicURL=env.CARD_STUDIO_PUBLIC_URL?new URL(env.CARD_STUDIO_PUBLIC_URL):null;
  if(publicURL&&(publicURL.protocol!=='https:'||publicURL.username||publicURL.password||publicURL.pathname!=='/'||publicURL.search||publicURL.hash))throw Error('CARD_STUDIO_PUBLIC_URL must be an HTTPS origin.');
  const username=env.CARD_STUDIO_USERNAME||'studio';
  const password=env.CARD_STUDIO_PASSWORD_FILE?fs.readFileSync(env.CARD_STUDIO_PASSWORD_FILE,'utf8').trim():'';
  if(publicURL&&!password)throw Error('Public hosting requires a nonempty password file.');
  const expected=password?digest(username+':'+password):null;
  const failed=new Map(),windowMs=10*60*1000;
  let global={count:0,until:0};
  const access={
    origin(host,port){
      if(publicURL&&host===publicURL.host)return publicURL.origin;
      if(host===`127.0.0.1:${port}`||host===`localhost:${port}`)return `http://${host}`;
      return null;
    },
    authorized(header=''){
      if(!expected)return true;
      if(!header.startsWith('Basic '))return false;
      return timingSafeEqual(expected,digest(Buffer.from(header.slice(6),'base64').toString('utf8')));
    },
    attempt(header='',client='local'){
      const time=now();
      if(global.until<=time)global={count:0,until:time+windowMs};
      const entry=failed.get(client);
      const blockedUntil=Math.max(global.count>=40?global.until:0,entry?.count>=8?entry.until:0);
      if(blockedUntil>time)return {authorized:false,retryAfter:Math.ceil((blockedUntil-time)/1000)};
      if(access.authorized(header)){failed.delete(client);return {authorized:true};}
      if(header){
        for(const [key,value]of failed)if(value.until<=time)failed.delete(key);
        const current=failed.get(client)||{count:0,until:time+windowMs};
        current.count++;failed.set(client,current);global.count++;
      }
      return {authorized:false,retryAfter:0};
    },
  };
  return access;
}
