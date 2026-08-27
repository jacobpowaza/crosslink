"use strict";var CrosslinkSDK=(()=>{var nn=Object.defineProperty;var eo=Object.getOwnPropertyDescriptor;var to=Object.getOwnPropertyNames;var no=Object.prototype.hasOwnProperty;var rn=(t,e)=>()=>(t&&(e=t(t=0)),e);var on=(t,e)=>{for(var n in e)nn(t,n,{get:e[n],enumerable:!0})},ro=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of to(e))!no.call(t,i)&&i!==n&&nn(t,i,{get:()=>e[i],enumerable:!(r=eo(e,i))||r.enumerable});return t};var io=t=>ro(nn({},"__esModule",{value:!0}),t);var Vi={};on(Vi,{JsonStore:()=>Oe,LocalStorageSecureStorage:()=>Ge,MemorySecureStorage:()=>We});var We,Ge,Oe,gt=rn(()=>{"use strict";We=class{map=new Map;get(e){return this.map.get(e)??null}set(e,n){this.map.set(e,n)}delete(e){this.map.delete(e)}},Ge=class{constructor(e){this.ls=e}get(e){return this.ls.getItem(e)}set(e,n){this.ls.setItem(e,n)}delete(e){this.ls.removeItem(e)}},Oe=class{constructor(e,n){this.storage=e;this.key=n}load(e){let n=this.storage.get(this.key);if(!n)return e;try{return{...e,...JSON.parse(n)}}catch{return e}}save(e){this.storage.set(this.key,JSON.stringify(e))}}});function na(){return new Promise((t,e)=>{let n=indexedDB.open(ta,1);n.onupgradeneeded=()=>{let r=n.result;r.objectStoreNames.contains(Ne)||r.createObjectStore(Ne),r.objectStoreNames.contains(re)||r.createObjectStore(re)},n.onsuccess=()=>t(n.result),n.onerror=()=>e(n.error??new Error("indexedDB open failed")),n.onblocked=()=>e(new Error("indexedDB open blocked by another tab"))})}function Kt(t){return new Promise((e,n)=>{t.oncomplete=()=>e(),t.onerror=()=>n(t.error??new Error("indexedDB transaction failed")),t.onabort=()=>n(t.error??new Error("indexedDB transaction aborted"))})}function Zn(t){return new Promise((e,n)=>{t.onsuccess=()=>e(t.result),t.onerror=()=>n(t.error??new Error("indexedDB request failed"))})}async function tt(t={}){try{let r=await mt.open();return{storage:await yt.hydrate(r,{...t.onWriteError?{onWriteError:t.onWriteError}:{}}),kind:r.kind,encrypted:!0}}catch(r){if(t.allowPlaintextFallback===!1)throw r}let{LocalStorageSecureStorage:e,MemorySecureStorage:n}=await Promise.resolve().then(()=>(gt(),Vi));return typeof localStorage<"u"?{storage:new e(localStorage),kind:"localstorage",encrypted:!1}:{storage:new n,kind:"memory",encrypted:!1}}var ta,Ne,re,Wi,mt,zt,yt,Zt=rn(()=>{"use strict";ta="crosslink-secure",Ne="keys",re="values",Wi="master";mt=class t{constructor(e,n){this.db=e;this.key=n}kind="indexeddb-aes-gcm";encrypted=!0;static async open(){if(typeof indexedDB>"u")throw new Error("IndexedDB is not available in this environment");let e=globalThis.crypto?.subtle;if(!e)throw new Error("WebCrypto subtle is not available (requires a secure origin)");let n=await na(),r=await Zn(n.transaction(Ne,"readonly").objectStore(Ne).get(Wi));if(!r){r=await e.generateKey({name:"AES-GCM",length:256},!1,["encrypt","decrypt"]);let i=n.transaction(Ne,"readwrite");i.objectStore(Ne).put(r,Wi),await Kt(i)}return new t(n,r)}async get(e){let n=await Zn(this.db.transaction(re,"readonly").objectStore(re).get(e));if(!n)return null;try{let r=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(n.iv)},this.key,n.data);return new TextDecoder().decode(r)}catch{return null}}async set(e,n){let r=crypto.getRandomValues(new Uint8Array(12)),i=await crypto.subtle.encrypt({name:"AES-GCM",iv:r},this.key,new TextEncoder().encode(n)),o=this.db.transaction(re,"readwrite");o.objectStore(re).put({iv:r.buffer,data:i},e),await Kt(o)}async delete(e){let n=this.db.transaction(re,"readwrite");n.objectStore(re).delete(e),await Kt(n)}async keys(){return(await Zn(this.db.transaction(re,"readonly").objectStore(re).getAllKeys())).map(String)}async wipe(){let e=this.db.transaction([re,Ne],"readwrite");e.objectStore(re).clear(),e.objectStore(Ne).clear(),await Kt(e)}},zt=class{constructor(e,n="sync-adapter",r=new Set){this.inner=e;this.knownKeys=r;this.kind=n}kind;encrypted=!1;async get(e){return this.inner.get(e)}async set(e,n){this.knownKeys.add(e),this.inner.set(e,n)}async delete(e){this.knownKeys.delete(e),this.inner.delete(e)}async keys(){return[...this.knownKeys]}},yt=class t{constructor(e,n){this.backend=e;this.onWriteError=n}cache=new Map;flushChain=Promise.resolve();pendingWrites=0;static async hydrate(e,n={}){let r=new t(e,n.onWriteError);for(let i of await e.keys()){let o=await e.get(i);o!==null&&r.cache.set(i,o)}return r}get kind(){return this.backend.kind}get encrypted(){return this.backend.encrypted}get(e){return this.cache.get(e)??null}set(e,n){this.cache.set(e,n),this.enqueue(e,()=>this.backend.set(e,n))}delete(e){this.cache.delete(e),this.enqueue(e,()=>this.backend.delete(e))}flushed(){return this.flushChain}get pending(){return this.pendingWrites}enqueue(e,n){this.pendingWrites+=1,this.flushChain=this.flushChain.then(n).catch(r=>{this.onWriteError?.(r,e)}).finally(()=>{this.pendingWrites-=1})}}});var Gi={};on(Gi,{SecureDeviceCryptoStorage:()=>Xn});var Xn,Ki=rn(()=>{"use strict";Zt();Xn=class t{storage;constructor(e){this.storage=e}static async open(){let{storage:e}=await tt({allowPlaintextFallback:!1});return new t(e)}storageKey(e){return`crosslink.device-crypto.${e}`}async load(e){let n=this.storageKey(e??"default"),r=this.storage.get(n);if(!r)return null;try{let i=JSON.parse(r);if(i&&typeof i.deviceId=="string"&&typeof i.edPrivateSeedB64=="string")return{deviceId:i.deviceId,edPrivateSeedB64:i.edPrivateSeedB64}}catch{}return null}async save(e,n){let r=this.storageKey(n??"default");this.storage.set(r,JSON.stringify(e))}async clear(e){let n=this.storageKey(e??"default");this.storage.delete(n)}}});var pa={};on(pa,{AsyncStorageAdapter:()=>zt,CrosslinkClient:()=>le,CrosslinkMobileBootstrap:()=>Et,CrosslinkOfflineShell:()=>xt,DEFAULT_OFFLINE_CONFIG:()=>Ke,DEFAULT_SERVICE_WORKER:()=>tr,DEFAULT_SERVICE_WORKER_CONFIG:()=>Ct,HydratedSecureStorage:()=>yt,IndexedDbSecureStorage:()=>mt,JsonStore:()=>Oe,LocalStorageSecureStorage:()=>Ge,MemoryLogSink:()=>Di,MemorySecureStorage:()=>We,MockSocket:()=>Yt,NotificationHandler:()=>Jt,PairingCard:()=>wt,SignalingPeer:()=>nt,consoleLogger:()=>Pi,createCrosslinkClient:()=>da,createLogger:()=>Wt,createOfflineUI:()=>rt,createPairingCard:()=>Xi,createSecureCrosslinkClient:()=>fa,createSecureStorage:()=>tt,createServiceWorkerConfig:()=>nr,generateServiceWorker:()=>tn,injectBootstrapStyles:()=>en,injectPairingCardStyles:()=>Jn,isStandalone:()=>Qt,noopLogger:()=>Ve,removeOfflineUI:()=>er,resetDeviceStorage:()=>vt,updateOfflineStatus:()=>Qn,wsTransport:()=>bt});function cr(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function St(t){if(typeof t!="boolean")throw new Error(`boolean expected, not ${t}`)}function kt(t){if(!Number.isSafeInteger(t)||t<0)throw new Error("positive integer expected, got "+t)}function X(t,...e){if(!cr(t))throw new Error("Uint8Array expected");if(e.length>0&&!e.includes(t.length))throw new Error("Uint8Array expected of length "+e+", got length="+t.length)}function sn(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function lr(t,e){X(t);let n=e.outputLen;if(t.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}function ye(t){return new Uint32Array(t.buffer,t.byteOffset,Math.floor(t.byteLength/4))}function be(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function oo(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}var so=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function ao(t){if(typeof t!="string")throw new Error("string expected");return new Uint8Array(new TextEncoder().encode(t))}function At(t){if(typeof t=="string")t=ao(t);else if(cr(t))t=Tt(t);else throw new Error("Uint8Array expected, got "+typeof t);return t}function dr(t,e){if(e==null||typeof e!="object")throw new Error("options must be defined");return Object.assign(t,e)}function fr(t,e){if(t.length!==e.length)return!1;let n=0;for(let r=0;r<t.length;r++)n|=t[r]^e[r];return n===0}var an=(t,e)=>{function n(r,...i){if(X(r),!so)throw new Error("Non little-endian hardware is not yet supported");if(t.nonceLength!==void 0){let l=i[0];if(!l)throw new Error("nonce / iv required");t.varSizeNonce?X(l):X(l,t.nonceLength)}let o=t.tagLength;o&&i[1]!==void 0&&X(i[1]);let s=e(r,...i),c=(l,p)=>{if(p!==void 0){if(l!==2)throw new Error("cipher output not supported");X(p)}},a=!1;return{encrypt(l,p){if(a)throw new Error("cannot encrypt() twice with same key + nonce");return a=!0,X(l),c(s.encrypt.length,p),s.encrypt(l,p)},decrypt(l,p){if(X(l),o&&l.length<o)throw new Error("invalid ciphertext length: smaller than tagLength="+o);return c(s.decrypt.length,p),s.decrypt(l,p)}}}return Object.assign(n,t),n};function cn(t,e,n=!0){if(e===void 0)return new Uint8Array(t);if(e.length!==t)throw new Error("invalid output length, expected "+t+", got: "+e.length);if(n&&!co(e))throw new Error("invalid output, must be aligned");return e}function ar(t,e,n,r){if(typeof t.setBigUint64=="function")return t.setBigUint64(e,n,r);let i=BigInt(32),o=BigInt(4294967295),s=Number(n>>i&o),c=Number(n&o),a=r?4:0,d=r?0:4;t.setUint32(e+a,s,r),t.setUint32(e+d,c,r)}function pr(t,e,n){St(n);let r=new Uint8Array(16),i=oo(r);return ar(i,0,BigInt(e),n),ar(i,8,BigInt(t),n),r}function co(t){return t.byteOffset%4===0}function Tt(t){return Uint8Array.from(t)}var ur=t=>Uint8Array.from(t.split("").map(e=>e.charCodeAt(0))),lo=ur("expand 16-byte k"),fo=ur("expand 32-byte k"),po=ye(lo),ho=ye(fo);function A(t,e){return t<<e|t>>>32-e}function ln(t){return t.byteOffset%4===0}var It=64,uo=16,gr=2**32-1,hr=new Uint32Array;function go(t,e,n,r,i,o,s,c){let a=i.length,d=new Uint8Array(It),l=ye(d),p=ln(i)&&ln(o),f=p?ye(i):hr,g=p?ye(o):hr;for(let h=0;h<a;s++){if(t(e,n,r,l,s,c),s>=gr)throw new Error("arx: counter overflow");let m=Math.min(It,a-h);if(p&&m===It){let y=h/4;if(h%4!==0)throw new Error("arx: invalid block position");for(let u=0,x;u<uo;u++)x=y+u,g[x]=f[x]^l[u];h+=It;continue}for(let y=0,u;y<m;y++)u=h+y,o[u]=i[u]^d[y];h+=m}}function dn(t,e){let{allowShortKeys:n,extendNonceFn:r,counterLength:i,counterRight:o,rounds:s}=dr({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},e);if(typeof t!="function")throw new Error("core must be a function");return kt(i),kt(s),St(o),St(n),(c,a,d,l,p=0)=>{X(c),X(a),X(d);let f=d.length;if(l===void 0&&(l=new Uint8Array(f)),X(l),kt(p),p<0||p>=gr)throw new Error("arx: counter overflow");if(l.length<f)throw new Error(`arx: output (${l.length}) is shorter than data (${f})`);let g=[],h=c.length,m,y;if(h===32)g.push(m=Tt(c)),y=ho;else if(h===16&&n)m=new Uint8Array(32),m.set(c),m.set(c,16),y=po,g.push(m);else throw new Error(`arx: invalid 32-byte key, got length=${h}`);ln(a)||g.push(a=Tt(a));let u=ye(m);if(r){if(a.length!==24)throw new Error("arx: extended nonce must be 24 bytes");r(y,u,ye(a.subarray(0,16)),u),a=a.subarray(16)}let x=16-i;if(x!==a.length)throw new Error(`arx: nonce must be ${x} or 16 bytes`);if(x!==12){let T=new Uint8Array(12);T.set(a,o?0:12-a.length),a=T,g.push(a)}let b=ye(a);return go(t,y,u,b,d,l,p,s),be(...g),l}}var K=(t,e)=>t[e++]&255|(t[e++]&255)<<8,fn=class{constructor(e){this.blockLen=16,this.outputLen=16,this.buffer=new Uint8Array(16),this.r=new Uint16Array(10),this.h=new Uint16Array(10),this.pad=new Uint16Array(8),this.pos=0,this.finished=!1,e=At(e),X(e,32);let n=K(e,0),r=K(e,2),i=K(e,4),o=K(e,6),s=K(e,8),c=K(e,10),a=K(e,12),d=K(e,14);this.r[0]=n&8191,this.r[1]=(n>>>13|r<<3)&8191,this.r[2]=(r>>>10|i<<6)&7939,this.r[3]=(i>>>7|o<<9)&8191,this.r[4]=(o>>>4|s<<12)&255,this.r[5]=s>>>1&8190,this.r[6]=(s>>>14|c<<2)&8191,this.r[7]=(c>>>11|a<<5)&8065,this.r[8]=(a>>>8|d<<8)&8191,this.r[9]=d>>>5&127;for(let l=0;l<8;l++)this.pad[l]=K(e,16+2*l)}process(e,n,r=!1){let i=r?0:2048,{h:o,r:s}=this,c=s[0],a=s[1],d=s[2],l=s[3],p=s[4],f=s[5],g=s[6],h=s[7],m=s[8],y=s[9],u=K(e,n+0),x=K(e,n+2),b=K(e,n+4),T=K(e,n+6),L=K(e,n+8),R=K(e,n+10),I=K(e,n+12),N=K(e,n+14),w=o[0]+(u&8191),v=o[1]+((u>>>13|x<<3)&8191),k=o[2]+((x>>>10|b<<6)&8191),B=o[3]+((b>>>7|T<<9)&8191),E=o[4]+((T>>>4|L<<12)&8191),S=o[5]+(L>>>1&8191),O=o[6]+((L>>>14|R<<2)&8191),P=o[7]+((R>>>11|I<<5)&8191),D=o[8]+((I>>>8|N<<8)&8191),M=o[9]+(N>>>5|i),C=0,H=C+w*c+v*(5*y)+k*(5*m)+B*(5*h)+E*(5*g);C=H>>>13,H&=8191,H+=S*(5*f)+O*(5*p)+P*(5*l)+D*(5*d)+M*(5*a),C+=H>>>13,H&=8191;let q=C+w*a+v*c+k*(5*y)+B*(5*m)+E*(5*h);C=q>>>13,q&=8191,q+=S*(5*g)+O*(5*f)+P*(5*p)+D*(5*l)+M*(5*d),C+=q>>>13,q&=8191;let F=C+w*d+v*a+k*c+B*(5*y)+E*(5*m);C=F>>>13,F&=8191,F+=S*(5*h)+O*(5*g)+P*(5*f)+D*(5*p)+M*(5*l),C+=F>>>13,F&=8191;let Z=C+w*l+v*d+k*a+B*c+E*(5*y);C=Z>>>13,Z&=8191,Z+=S*(5*m)+O*(5*h)+P*(5*g)+D*(5*f)+M*(5*p),C+=Z>>>13,Z&=8191;let de=C+w*p+v*l+k*d+B*a+E*c;C=de>>>13,de&=8191,de+=S*(5*y)+O*(5*m)+P*(5*h)+D*(5*g)+M*(5*f),C+=de>>>13,de&=8191;let fe=C+w*f+v*p+k*l+B*d+E*a;C=fe>>>13,fe&=8191,fe+=S*c+O*(5*y)+P*(5*m)+D*(5*h)+M*(5*g),C+=fe>>>13,fe&=8191;let pe=C+w*g+v*f+k*p+B*l+E*d;C=pe>>>13,pe&=8191,pe+=S*a+O*c+P*(5*y)+D*(5*m)+M*(5*h),C+=pe>>>13,pe&=8191;let he=C+w*h+v*g+k*f+B*p+E*l;C=he>>>13,he&=8191,he+=S*d+O*a+P*c+D*(5*y)+M*(5*m),C+=he>>>13,he&=8191;let ge=C+w*m+v*h+k*g+B*f+E*p;C=ge>>>13,ge&=8191,ge+=S*l+O*d+P*a+D*c+M*(5*y),C+=ge>>>13,ge&=8191;let me=C+w*y+v*m+k*h+B*g+E*f;C=me>>>13,me&=8191,me+=S*p+O*l+P*d+D*a+M*c,C+=me>>>13,me&=8191,C=(C<<2)+C|0,C=C+H|0,H=C&8191,C=C>>>13,q+=C,o[0]=H,o[1]=q,o[2]=F,o[3]=Z,o[4]=de,o[5]=fe,o[6]=pe,o[7]=he,o[8]=ge,o[9]=me}finalize(){let{h:e,pad:n}=this,r=new Uint16Array(10),i=e[1]>>>13;e[1]&=8191;for(let c=2;c<10;c++)e[c]+=i,i=e[c]>>>13,e[c]&=8191;e[0]+=i*5,i=e[0]>>>13,e[0]&=8191,e[1]+=i,i=e[1]>>>13,e[1]&=8191,e[2]+=i,r[0]=e[0]+5,i=r[0]>>>13,r[0]&=8191;for(let c=1;c<10;c++)r[c]=e[c]+i,i=r[c]>>>13,r[c]&=8191;r[9]-=8192;let o=(i^1)-1;for(let c=0;c<10;c++)r[c]&=o;o=~o;for(let c=0;c<10;c++)e[c]=e[c]&o|r[c];e[0]=(e[0]|e[1]<<13)&65535,e[1]=(e[1]>>>3|e[2]<<10)&65535,e[2]=(e[2]>>>6|e[3]<<7)&65535,e[3]=(e[3]>>>9|e[4]<<4)&65535,e[4]=(e[4]>>>12|e[5]<<1|e[6]<<14)&65535,e[5]=(e[6]>>>2|e[7]<<11)&65535,e[6]=(e[7]>>>5|e[8]<<8)&65535,e[7]=(e[8]>>>8|e[9]<<5)&65535;let s=e[0]+n[0];e[0]=s&65535;for(let c=1;c<8;c++)s=(e[c]+n[c]|0)+(s>>>16)|0,e[c]=s&65535;be(r)}update(e){sn(this),e=At(e),X(e);let{buffer:n,blockLen:r}=this,i=e.length;for(let o=0;o<i;){let s=Math.min(r-this.pos,i-o);if(s===r){for(;r<=i-o;o+=r)this.process(e,o);continue}n.set(e.subarray(o,o+s),this.pos),this.pos+=s,o+=s,this.pos===r&&(this.process(n,0,!1),this.pos=0)}return this}destroy(){be(this.h,this.r,this.buffer,this.pad)}digestInto(e){sn(this),lr(e,this),this.finished=!0;let{buffer:n,h:r}=this,{pos:i}=this;if(i){for(n[i++]=1;i<16;i++)n[i]=0;this.process(n,0,!0)}this.finalize();let o=0;for(let s=0;s<8;s++)e[o++]=r[s]>>>0,e[o++]=r[s]>>>8;return e}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}};function mo(t){let e=(r,i)=>t(i).update(At(r)).digest(),n=t(new Uint8Array(32));return e.outputLen=n.outputLen,e.blockLen=n.blockLen,e.create=r=>t(r),e}var mr=mo(t=>new fn(t));function wr(t,e,n,r,i,o=20){let s=t[0],c=t[1],a=t[2],d=t[3],l=e[0],p=e[1],f=e[2],g=e[3],h=e[4],m=e[5],y=e[6],u=e[7],x=i,b=n[0],T=n[1],L=n[2],R=s,I=c,N=a,w=d,v=l,k=p,B=f,E=g,S=h,O=m,P=y,D=u,M=x,C=b,H=T,q=L;for(let Z=0;Z<o;Z+=2)R=R+v|0,M=A(M^R,16),S=S+M|0,v=A(v^S,12),R=R+v|0,M=A(M^R,8),S=S+M|0,v=A(v^S,7),I=I+k|0,C=A(C^I,16),O=O+C|0,k=A(k^O,12),I=I+k|0,C=A(C^I,8),O=O+C|0,k=A(k^O,7),N=N+B|0,H=A(H^N,16),P=P+H|0,B=A(B^P,12),N=N+B|0,H=A(H^N,8),P=P+H|0,B=A(B^P,7),w=w+E|0,q=A(q^w,16),D=D+q|0,E=A(E^D,12),w=w+E|0,q=A(q^w,8),D=D+q|0,E=A(E^D,7),R=R+k|0,q=A(q^R,16),P=P+q|0,k=A(k^P,12),R=R+k|0,q=A(q^R,8),P=P+q|0,k=A(k^P,7),I=I+B|0,M=A(M^I,16),D=D+M|0,B=A(B^D,12),I=I+B|0,M=A(M^I,8),D=D+M|0,B=A(B^D,7),N=N+E|0,C=A(C^N,16),S=S+C|0,E=A(E^S,12),N=N+E|0,C=A(C^N,8),S=S+C|0,E=A(E^S,7),w=w+v|0,H=A(H^w,16),O=O+H|0,v=A(v^O,12),w=w+v|0,H=A(H^w,8),O=O+H|0,v=A(v^O,7);let F=0;r[F++]=s+R|0,r[F++]=c+I|0,r[F++]=a+N|0,r[F++]=d+w|0,r[F++]=l+v|0,r[F++]=p+k|0,r[F++]=f+B|0,r[F++]=g+E|0,r[F++]=h+S|0,r[F++]=m+O|0,r[F++]=y+P|0,r[F++]=u+D|0,r[F++]=x+M|0,r[F++]=b+C|0,r[F++]=T+H|0,r[F++]=L+q|0}function yo(t,e,n,r){let i=t[0],o=t[1],s=t[2],c=t[3],a=e[0],d=e[1],l=e[2],p=e[3],f=e[4],g=e[5],h=e[6],m=e[7],y=n[0],u=n[1],x=n[2],b=n[3];for(let L=0;L<20;L+=2)i=i+a|0,y=A(y^i,16),f=f+y|0,a=A(a^f,12),i=i+a|0,y=A(y^i,8),f=f+y|0,a=A(a^f,7),o=o+d|0,u=A(u^o,16),g=g+u|0,d=A(d^g,12),o=o+d|0,u=A(u^o,8),g=g+u|0,d=A(d^g,7),s=s+l|0,x=A(x^s,16),h=h+x|0,l=A(l^h,12),s=s+l|0,x=A(x^s,8),h=h+x|0,l=A(l^h,7),c=c+p|0,b=A(b^c,16),m=m+b|0,p=A(p^m,12),c=c+p|0,b=A(b^c,8),m=m+b|0,p=A(p^m,7),i=i+d|0,b=A(b^i,16),h=h+b|0,d=A(d^h,12),i=i+d|0,b=A(b^i,8),h=h+b|0,d=A(d^h,7),o=o+l|0,y=A(y^o,16),m=m+y|0,l=A(l^m,12),o=o+l|0,y=A(y^o,8),m=m+y|0,l=A(l^m,7),s=s+p|0,u=A(u^s,16),f=f+u|0,p=A(p^f,12),s=s+p|0,u=A(u^s,8),f=f+u|0,p=A(p^f,7),c=c+a|0,x=A(x^c,16),g=g+x|0,a=A(a^g,12),c=c+a|0,x=A(x^c,8),g=g+x|0,a=A(a^g,7);let T=0;r[T++]=i,r[T++]=o,r[T++]=s,r[T++]=c,r[T++]=y,r[T++]=u,r[T++]=x,r[T++]=b}var bo=dn(wr,{counterRight:!1,counterLength:4,allowShortKeys:!1}),wo=dn(wr,{counterRight:!1,counterLength:8,extendNonceFn:yo,allowShortKeys:!1});var xo=new Uint8Array(16),yr=(t,e)=>{t.update(e);let n=e.length%16;n&&t.update(xo.subarray(n))},vo=new Uint8Array(32);function br(t,e,n,r,i){let o=t(e,n,vo),s=mr.create(o);i&&yr(s,i),yr(s,r);let c=pr(r.length,i?i.length:0,!0);s.update(c);let a=s.digest();return be(o,c),a}var xr=t=>(e,n,r)=>({encrypt(o,s){let c=o.length;s=cn(c+16,s,!1),s.set(o);let a=s.subarray(0,-16);t(e,n,a,a,1);let d=br(t,e,n,a,r);return s.set(d,c),be(d),s},decrypt(o,s){s=cn(o.length-16,s,!1);let c=o.subarray(0,-16),a=o.subarray(-16),d=br(t,e,n,c,r);if(!fr(a,d))throw new Error("invalid tag");return s.set(o.subarray(0,-16)),t(e,n,s,s,1),be(d),s}}),Ca=an({blockSize:64,nonceLength:12,tagLength:16},xr(bo)),pn=an({blockSize:64,nonceLength:24,tagLength:16},xr(wo));var Le=typeof globalThis=="object"&&"crypto"in globalThis?globalThis.crypto:void 0;function Pe(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Re(t){if(!Number.isSafeInteger(t)||t<0)throw new Error("positive integer expected, got "+t)}function Y(t,...e){if(!Pe(t))throw new Error("Uint8Array expected");if(e.length>0&&!e.includes(t.length))throw new Error("Uint8Array expected of length "+e+", got length="+t.length)}function it(t){if(typeof t!="function"||typeof t.create!="function")throw new Error("Hash should be wrapped by utils.createHasher");Re(t.outputLen),Re(t.blockLen)}function Ze(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function Er(t,e){Y(t);let n=e.outputLen;if(t.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}function ie(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function _t(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function oe(t,e){return t<<32-e|t>>>e}var Cr=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",Eo=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function De(t){if(Y(t),Cr)return t.toHex();let e="";for(let n=0;n<t.length;n++)e+=Eo[t[n]];return e}var we={_0:48,_9:57,A:65,F:70,a:97,f:102};function vr(t){if(t>=we._0&&t<=we._9)return t-we._0;if(t>=we.A&&t<=we.F)return t-(we.A-10);if(t>=we.a&&t<=we.f)return t-(we.a-10)}function Bt(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);if(Cr)return Uint8Array.fromHex(t);let e=t.length,n=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);let r=new Uint8Array(n);for(let i=0,o=0;i<n;i++,o+=2){let s=vr(t.charCodeAt(o)),c=vr(t.charCodeAt(o+1));if(s===void 0||c===void 0){let a=t[o]+t[o+1];throw new Error('hex string expected, got non-hex character "'+a+'" at index '+o)}r[i]=s*16+c}return r}function hn(t){if(typeof t!="string")throw new Error("string expected");return new Uint8Array(new TextEncoder().encode(t))}function Ae(t){return typeof t=="string"&&(t=hn(t)),Y(t),t}function Xe(...t){let e=0;for(let r=0;r<t.length;r++){let i=t[r];Y(i),e+=i.length}let n=new Uint8Array(e);for(let r=0,i=0;r<t.length;r++){let o=t[r];n.set(o,i),i+=o.length}return n}var ze=class{};function un(t){let e=r=>t().update(Ae(r)).digest(),n=t();return e.outputLen=n.outputLen,e.blockLen=n.blockLen,e.create=()=>t(),e}function Me(t=32){if(Le&&typeof Le.getRandomValues=="function")return Le.getRandomValues(new Uint8Array(t));if(Le&&typeof Le.randomBytes=="function")return Uint8Array.from(Le.randomBytes(t));throw new Error("crypto.getRandomValues must be defined")}function Co(t,e,n,r){if(typeof t.setBigUint64=="function")return t.setBigUint64(e,n,r);let i=BigInt(32),o=BigInt(4294967295),s=Number(n>>i&o),c=Number(n&o),a=r?4:0,d=r?0:4;t.setUint32(e+a,s,r),t.setUint32(e+d,c,r)}function Sr(t,e,n){return t&e^~t&n}function kr(t,e,n){return t&e^t&n^e&n}var ot=class extends ze{constructor(e,n,r,i){super(),this.finished=!1,this.length=0,this.pos=0,this.destroyed=!1,this.blockLen=e,this.outputLen=n,this.padOffset=r,this.isLE=i,this.buffer=new Uint8Array(e),this.view=_t(this.buffer)}update(e){Ze(this),e=Ae(e),Y(e);let{view:n,buffer:r,blockLen:i}=this,o=e.length;for(let s=0;s<o;){let c=Math.min(i-this.pos,o-s);if(c===i){let a=_t(e);for(;i<=o-s;s+=i)this.process(a,s);continue}r.set(e.subarray(s,s+c),this.pos),this.pos+=c,s+=c,this.pos===i&&(this.process(n,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){Ze(this),Er(e,this),this.finished=!0;let{buffer:n,view:r,blockLen:i,isLE:o}=this,{pos:s}=this;n[s++]=128,ie(this.buffer.subarray(s)),this.padOffset>i-s&&(this.process(r,0),s=0);for(let p=s;p<i;p++)n[p]=0;Co(r,i-8,BigInt(this.length*8),o),this.process(r,0);let c=_t(e),a=this.outputLen;if(a%4)throw new Error("_sha2: outputLen should be aligned to 32bit");let d=a/4,l=this.get();if(d>l.length)throw new Error("_sha2: outputLen bigger than state");for(let p=0;p<d;p++)c.setUint32(4*p,l[p],o)}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}_cloneInto(e){e||(e=new this.constructor),e.set(...this.get());let{blockLen:n,buffer:r,length:i,finished:o,destroyed:s,pos:c}=this;return e.destroyed=s,e.finished=o,e.length=i,e.pos=c,i%n&&e.buffer.set(r),e}clone(){return this._cloneInto()}},xe=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var z=Uint32Array.from([1779033703,4089235720,3144134277,2227873595,1013904242,4271175723,2773480762,1595750129,1359893119,2917565137,2600822924,725511199,528734635,4215389547,1541459225,327033209]);var Ot=BigInt(4294967295),Ar=BigInt(32);function So(t,e=!1){return e?{h:Number(t&Ot),l:Number(t>>Ar&Ot)}:{h:Number(t>>Ar&Ot)|0,l:Number(t&Ot)|0}}function Tr(t,e=!1){let n=t.length,r=new Uint32Array(n),i=new Uint32Array(n);for(let o=0;o<n;o++){let{h:s,l:c}=So(t[o],e);[r[o],i[o]]=[s,c]}return[r,i]}var gn=(t,e,n)=>t>>>n,mn=(t,e,n)=>t<<32-n|e>>>n,Ue=(t,e,n)=>t>>>n|e<<32-n,He=(t,e,n)=>t<<32-n|e>>>n,st=(t,e,n)=>t<<64-n|e>>>n-32,at=(t,e,n)=>t>>>n-32|e<<64-n;function ue(t,e,n,r){let i=(e>>>0)+(r>>>0);return{h:t+n+(i/2**32|0)|0,l:i|0}}var Ir=(t,e,n)=>(t>>>0)+(e>>>0)+(n>>>0),_r=(t,e,n,r)=>e+n+r+(t/2**32|0)|0,Br=(t,e,n,r)=>(t>>>0)+(e>>>0)+(n>>>0)+(r>>>0),Or=(t,e,n,r,i)=>e+n+r+i+(t/2**32|0)|0,Nr=(t,e,n,r,i)=>(t>>>0)+(e>>>0)+(n>>>0)+(r>>>0)+(i>>>0),Lr=(t,e,n,r,i,o)=>e+n+r+i+o+(t/2**32|0)|0;var Ao=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),Te=new Uint32Array(64),Nt=class extends ot{constructor(e=32){super(64,e,8,!1),this.A=xe[0]|0,this.B=xe[1]|0,this.C=xe[2]|0,this.D=xe[3]|0,this.E=xe[4]|0,this.F=xe[5]|0,this.G=xe[6]|0,this.H=xe[7]|0}get(){let{A:e,B:n,C:r,D:i,E:o,F:s,G:c,H:a}=this;return[e,n,r,i,o,s,c,a]}set(e,n,r,i,o,s,c,a){this.A=e|0,this.B=n|0,this.C=r|0,this.D=i|0,this.E=o|0,this.F=s|0,this.G=c|0,this.H=a|0}process(e,n){for(let p=0;p<16;p++,n+=4)Te[p]=e.getUint32(n,!1);for(let p=16;p<64;p++){let f=Te[p-15],g=Te[p-2],h=oe(f,7)^oe(f,18)^f>>>3,m=oe(g,17)^oe(g,19)^g>>>10;Te[p]=m+Te[p-7]+h+Te[p-16]|0}let{A:r,B:i,C:o,D:s,E:c,F:a,G:d,H:l}=this;for(let p=0;p<64;p++){let f=oe(c,6)^oe(c,11)^oe(c,25),g=l+f+Sr(c,a,d)+Ao[p]+Te[p]|0,m=(oe(r,2)^oe(r,13)^oe(r,22))+kr(r,i,o)|0;l=d,d=a,a=c,c=s+g|0,s=o,o=i,i=r,r=g+m|0}r=r+this.A|0,i=i+this.B|0,o=o+this.C|0,s=s+this.D|0,c=c+this.E|0,a=a+this.F|0,d=d+this.G|0,l=l+this.H|0,this.set(r,i,o,s,c,a,d,l)}roundClean(){ie(Te)}destroy(){this.set(0,0,0,0,0,0,0,0),ie(this.buffer)}};var Rr=Tr(["0x428a2f98d728ae22","0x7137449123ef65cd","0xb5c0fbcfec4d3b2f","0xe9b5dba58189dbbc","0x3956c25bf348b538","0x59f111f1b605d019","0x923f82a4af194f9b","0xab1c5ed5da6d8118","0xd807aa98a3030242","0x12835b0145706fbe","0x243185be4ee4b28c","0x550c7dc3d5ffb4e2","0x72be5d74f27b896f","0x80deb1fe3b1696b1","0x9bdc06a725c71235","0xc19bf174cf692694","0xe49b69c19ef14ad2","0xefbe4786384f25e3","0x0fc19dc68b8cd5b5","0x240ca1cc77ac9c65","0x2de92c6f592b0275","0x4a7484aa6ea6e483","0x5cb0a9dcbd41fbd4","0x76f988da831153b5","0x983e5152ee66dfab","0xa831c66d2db43210","0xb00327c898fb213f","0xbf597fc7beef0ee4","0xc6e00bf33da88fc2","0xd5a79147930aa725","0x06ca6351e003826f","0x142929670a0e6e70","0x27b70a8546d22ffc","0x2e1b21385c26c926","0x4d2c6dfc5ac42aed","0x53380d139d95b3df","0x650a73548baf63de","0x766a0abb3c77b2a8","0x81c2c92e47edaee6","0x92722c851482353b","0xa2bfe8a14cf10364","0xa81a664bbc423001","0xc24b8b70d0f89791","0xc76c51a30654be30","0xd192e819d6ef5218","0xd69906245565a910","0xf40e35855771202a","0x106aa07032bbd1b8","0x19a4c116b8d2d0c8","0x1e376c085141ab53","0x2748774cdf8eeb99","0x34b0bcb5e19b48a8","0x391c0cb3c5c95a63","0x4ed8aa4ae3418acb","0x5b9cca4f7763e373","0x682e6ff3d6b2b8a3","0x748f82ee5defb2fc","0x78a5636f43172f60","0x84c87814a1f0ab72","0x8cc702081a6439ec","0x90befffa23631e28","0xa4506cebde82bde9","0xbef9a3f7b2c67915","0xc67178f2e372532b","0xca273eceea26619c","0xd186b8c721c0c207","0xeada7dd6cde0eb1e","0xf57d4f7fee6ed178","0x06f067aa72176fba","0x0a637dc5a2c898a6","0x113f9804bef90dae","0x1b710b35131c471b","0x28db77f523047d84","0x32caab7b40c72493","0x3c9ebe0a15c9bebc","0x431d67c49c100d4c","0x4cc5d4becb3e42b6","0x597f299cfc657e2a","0x5fcb6fab3ad6faec","0x6c44198c4a475817"].map(t=>BigInt(t))),To=Rr[0],Io=Rr[1],Ie=new Uint32Array(80),_e=new Uint32Array(80),yn=class extends ot{constructor(e=64){super(128,e,16,!1),this.Ah=z[0]|0,this.Al=z[1]|0,this.Bh=z[2]|0,this.Bl=z[3]|0,this.Ch=z[4]|0,this.Cl=z[5]|0,this.Dh=z[6]|0,this.Dl=z[7]|0,this.Eh=z[8]|0,this.El=z[9]|0,this.Fh=z[10]|0,this.Fl=z[11]|0,this.Gh=z[12]|0,this.Gl=z[13]|0,this.Hh=z[14]|0,this.Hl=z[15]|0}get(){let{Ah:e,Al:n,Bh:r,Bl:i,Ch:o,Cl:s,Dh:c,Dl:a,Eh:d,El:l,Fh:p,Fl:f,Gh:g,Gl:h,Hh:m,Hl:y}=this;return[e,n,r,i,o,s,c,a,d,l,p,f,g,h,m,y]}set(e,n,r,i,o,s,c,a,d,l,p,f,g,h,m,y){this.Ah=e|0,this.Al=n|0,this.Bh=r|0,this.Bl=i|0,this.Ch=o|0,this.Cl=s|0,this.Dh=c|0,this.Dl=a|0,this.Eh=d|0,this.El=l|0,this.Fh=p|0,this.Fl=f|0,this.Gh=g|0,this.Gl=h|0,this.Hh=m|0,this.Hl=y|0}process(e,n){for(let b=0;b<16;b++,n+=4)Ie[b]=e.getUint32(n),_e[b]=e.getUint32(n+=4);for(let b=16;b<80;b++){let T=Ie[b-15]|0,L=_e[b-15]|0,R=Ue(T,L,1)^Ue(T,L,8)^gn(T,L,7),I=He(T,L,1)^He(T,L,8)^mn(T,L,7),N=Ie[b-2]|0,w=_e[b-2]|0,v=Ue(N,w,19)^st(N,w,61)^gn(N,w,6),k=He(N,w,19)^at(N,w,61)^mn(N,w,6),B=Br(I,k,_e[b-7],_e[b-16]),E=Or(B,R,v,Ie[b-7],Ie[b-16]);Ie[b]=E|0,_e[b]=B|0}let{Ah:r,Al:i,Bh:o,Bl:s,Ch:c,Cl:a,Dh:d,Dl:l,Eh:p,El:f,Fh:g,Fl:h,Gh:m,Gl:y,Hh:u,Hl:x}=this;for(let b=0;b<80;b++){let T=Ue(p,f,14)^Ue(p,f,18)^st(p,f,41),L=He(p,f,14)^He(p,f,18)^at(p,f,41),R=p&g^~p&m,I=f&h^~f&y,N=Nr(x,L,I,Io[b],_e[b]),w=Lr(N,u,T,R,To[b],Ie[b]),v=N|0,k=Ue(r,i,28)^st(r,i,34)^st(r,i,39),B=He(r,i,28)^at(r,i,34)^at(r,i,39),E=r&o^r&c^o&c,S=i&s^i&a^s&a;u=m|0,x=y|0,m=g|0,y=h|0,g=p|0,h=f|0,{h:p,l:f}=ue(d|0,l|0,w|0,v|0),d=c|0,l=a|0,c=o|0,a=s|0,o=r|0,s=i|0;let O=Ir(v,B,S);r=_r(O,w,k,E),i=O|0}({h:r,l:i}=ue(this.Ah|0,this.Al|0,r|0,i|0)),{h:o,l:s}=ue(this.Bh|0,this.Bl|0,o|0,s|0),{h:c,l:a}=ue(this.Ch|0,this.Cl|0,c|0,a|0),{h:d,l}=ue(this.Dh|0,this.Dl|0,d|0,l|0),{h:p,l:f}=ue(this.Eh|0,this.El|0,p|0,f|0),{h:g,l:h}=ue(this.Fh|0,this.Fl|0,g|0,h|0),{h:m,l:y}=ue(this.Gh|0,this.Gl|0,m|0,y|0),{h:u,l:x}=ue(this.Hh|0,this.Hl|0,u|0,x|0),this.set(r,i,o,s,c,a,d,l,p,f,g,h,m,y,u,x)}roundClean(){ie(Ie,_e)}destroy(){ie(this.buffer),this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)}};var Pr=un(()=>new Nt);var Dr=un(()=>new yn);var xn=BigInt(0),wn=BigInt(1);function Lt(t,e=""){if(typeof t!="boolean"){let n=e&&`"${e}"`;throw new Error(n+"expected boolean, got type="+typeof t)}return t}function ct(t,e,n=""){let r=Pe(t),i=t?.length,o=e!==void 0;if(!r||o&&i!==e){let s=n&&`"${n}" `,c=o?` of length ${e}`:"",a=r?`length=${i}`:`type=${typeof t}`;throw new Error(s+"expected Uint8Array"+c+", got "+a)}return t}function Mr(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?xn:BigInt("0x"+t)}function Ur(t){return Mr(De(t))}function se(t){return Y(t),Mr(De(Uint8Array.from(t).reverse()))}function vn(t,e){return Bt(t.toString(16).padStart(e*2,"0"))}function Rt(t,e){return vn(t,e).reverse()}function J(t,e,n){let r;if(typeof e=="string")try{r=Bt(e)}catch(o){throw new Error(t+" must be hex string or Uint8Array, cause: "+o)}else if(Pe(e))r=Uint8Array.from(e);else throw new Error(t+" must be hex string or Uint8Array");let i=r.length;if(typeof n=="number"&&i!==n)throw new Error(t+" of length "+n+" expected, got "+i);return r}function Hr(t,e){if(t.length!==e.length)return!1;let n=0;for(let r=0;r<t.length;r++)n|=t[r]^e[r];return n===0}function En(t){return Uint8Array.from(t)}var bn=t=>typeof t=="bigint"&&xn<=t;function _o(t,e,n){return bn(t)&&bn(e)&&bn(n)&&e<=t&&t<n}function Ye(t,e,n,r){if(!_o(e,n,r))throw new Error("expected valid "+t+": "+n+" <= n < "+r+", got "+e)}function qr(t){let e;for(e=0;t>xn;t>>=wn,e+=1);return e}var lt=t=>(wn<<BigInt(t))-wn;function qe(t,e,n={}){if(!t||typeof t!="object")throw new Error("expected valid options object");function r(i,o,s){let c=t[i];if(s&&c===void 0)return;let a=typeof c;if(a!==o||c===null)throw new Error(`param "${i}" is invalid: expected ${o}, got ${a}`)}Object.entries(e).forEach(([i,o])=>r(i,o,!1)),Object.entries(n).forEach(([i,o])=>r(i,o,!0))}var Cn=()=>{throw new Error("not implemented")};function Sn(t){let e=new WeakMap;return(n,...r)=>{let i=e.get(n);if(i!==void 0)return i;let o=t(n,...r);return e.set(n,o),o}}var ee=BigInt(0),Q=BigInt(1),Fe=BigInt(2),jr=BigInt(3),Vr=BigInt(4),Wr=BigInt(5),Bo=BigInt(7),Gr=BigInt(8),Oo=BigInt(9),Kr=BigInt(16);function V(t,e){let n=t%e;return n>=ee?n:e+n}function ne(t,e,n){let r=t;for(;e-- >ee;)r*=r,r%=n;return r}function Fr(t,e){if(t===ee)throw new Error("invert: expected non-zero number");if(e<=ee)throw new Error("invert: expected positive modulus, got "+e);let n=V(t,e),r=e,i=ee,o=Q,s=Q,c=ee;for(;n!==ee;){let d=r/n,l=r%n,p=i-s*d,f=o-c*d;r=n,n=l,i=s,o=c,s=p,c=f}if(r!==Q)throw new Error("invert: does not exist");return V(i,e)}function kn(t,e,n){if(!t.eql(t.sqr(e),n))throw new Error("Cannot find square root")}function zr(t,e){let n=(t.ORDER+Q)/Vr,r=t.pow(e,n);return kn(t,r,e),r}function No(t,e){let n=(t.ORDER-Wr)/Gr,r=t.mul(e,Fe),i=t.pow(r,n),o=t.mul(e,i),s=t.mul(t.mul(o,Fe),i),c=t.mul(o,t.sub(s,t.ONE));return kn(t,c,e),c}function Lo(t){let e=Ee(t),n=Zr(t),r=n(e,e.neg(e.ONE)),i=n(e,r),o=n(e,e.neg(r)),s=(t+Bo)/Kr;return(c,a)=>{let d=c.pow(a,s),l=c.mul(d,r),p=c.mul(d,i),f=c.mul(d,o),g=c.eql(c.sqr(l),a),h=c.eql(c.sqr(p),a);d=c.cmov(d,l,g),l=c.cmov(f,p,h);let m=c.eql(c.sqr(l),a),y=c.cmov(d,l,m);return kn(c,y,a),y}}function Zr(t){if(t<jr)throw new Error("sqrt is not defined for small field");let e=t-Q,n=0;for(;e%Fe===ee;)e/=Fe,n++;let r=Fe,i=Ee(t);for(;$r(i,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return zr;let o=i.pow(r,e),s=(e+Q)/Fe;return function(a,d){if(a.is0(d))return d;if($r(a,d)!==1)throw new Error("Cannot find square root");let l=n,p=a.mul(a.ONE,o),f=a.pow(d,e),g=a.pow(d,s);for(;!a.eql(f,a.ONE);){if(a.is0(f))return a.ZERO;let h=1,m=a.sqr(f);for(;!a.eql(m,a.ONE);)if(h++,m=a.sqr(m),h===l)throw new Error("Cannot find square root");let y=Q<<BigInt(l-h-1),u=a.pow(p,y);l=h,p=a.sqr(u),f=a.mul(f,p),g=a.mul(g,u)}return g}}function Ro(t){return t%Vr===jr?zr:t%Gr===Wr?No:t%Kr===Oo?Lo(t):Zr(t)}var ve=(t,e)=>(V(t,e)&Q)===Q,Po=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function Xr(t){let e={ORDER:"bigint",MASK:"bigint",BYTES:"number",BITS:"number"},n=Po.reduce((r,i)=>(r[i]="function",r),e);return qe(t,n),t}function Do(t,e,n){if(n<ee)throw new Error("invalid exponent, negatives unsupported");if(n===ee)return t.ONE;if(n===Q)return e;let r=t.ONE,i=e;for(;n>ee;)n&Q&&(r=t.mul(r,i)),i=t.sqr(i),n>>=Q;return r}function Pt(t,e,n=!1){let r=new Array(e.length).fill(n?t.ZERO:void 0),i=e.reduce((s,c,a)=>t.is0(c)?s:(r[a]=s,t.mul(s,c)),t.ONE),o=t.inv(i);return e.reduceRight((s,c,a)=>t.is0(c)?s:(r[a]=t.mul(s,r[a]),t.mul(s,c)),o),r}function $r(t,e){let n=(t.ORDER-Q)/Fe,r=t.pow(e,n),i=t.eql(r,t.ONE),o=t.eql(r,t.ZERO),s=t.eql(r,t.neg(t.ONE));if(!i&&!o&&!s)throw new Error("invalid Legendre symbol result");return i?1:o?0:-1}function Yr(t,e){e!==void 0&&Re(e);let n=e!==void 0?e:t.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}function Ee(t,e,n=!1,r={}){if(t<=ee)throw new Error("invalid field: expected ORDER > 0, got "+t);let i,o,s=!1,c;if(typeof e=="object"&&e!=null){if(r.sqrt||n)throw new Error("cannot specify opts in two arguments");let f=e;f.BITS&&(i=f.BITS),f.sqrt&&(o=f.sqrt),typeof f.isLE=="boolean"&&(n=f.isLE),typeof f.modFromBytes=="boolean"&&(s=f.modFromBytes),c=f.allowedLengths}else typeof e=="number"&&(i=e),r.sqrt&&(o=r.sqrt);let{nBitLength:a,nByteLength:d}=Yr(t,i);if(d>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");let l,p=Object.freeze({ORDER:t,isLE:n,BITS:a,BYTES:d,MASK:lt(a),ZERO:ee,ONE:Q,allowedLengths:c,create:f=>V(f,t),isValid:f=>{if(typeof f!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof f);return ee<=f&&f<t},is0:f=>f===ee,isValidNot0:f=>!p.is0(f)&&p.isValid(f),isOdd:f=>(f&Q)===Q,neg:f=>V(-f,t),eql:(f,g)=>f===g,sqr:f=>V(f*f,t),add:(f,g)=>V(f+g,t),sub:(f,g)=>V(f-g,t),mul:(f,g)=>V(f*g,t),pow:(f,g)=>Do(p,f,g),div:(f,g)=>V(f*Fr(g,t),t),sqrN:f=>f*f,addN:(f,g)=>f+g,subN:(f,g)=>f-g,mulN:(f,g)=>f*g,inv:f=>Fr(f,t),sqrt:o||(f=>(l||(l=Ro(t)),l(p,f))),toBytes:f=>n?Rt(f,d):vn(f,d),fromBytes:(f,g=!0)=>{if(c){if(!c.includes(f.length)||f.length>d)throw new Error("Field.fromBytes: expected "+c+" bytes, got "+f.length);let m=new Uint8Array(d);m.set(f,n?0:m.length-f.length),f=m}if(f.length!==d)throw new Error("Field.fromBytes: expected "+d+" bytes, got "+f.length);let h=n?se(f):Ur(f);if(s&&(h=V(h,t)),!g&&!p.isValid(h))throw new Error("invalid field element: outside of range 0..ORDER");return h},invertBatch:f=>Pt(p,f),cmov:(f,g,h)=>h?g:f});return Object.freeze(p)}var Dt=BigInt(0),_n=BigInt(1);function Jr(t,e){let n=e.negate();return t?n:e}function dt(t,e){let n=Pt(t.Fp,e.map(r=>r.Z));return e.map((r,i)=>t.fromAffine(r.toAffine(n[i])))}function ni(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function An(t,e){ni(t,e);let n=Math.ceil(e/t)+1,r=2**(t-1),i=2**t,o=lt(t),s=BigInt(t);return{windows:n,windowSize:r,mask:o,maxNumber:i,shiftBy:s}}function Qr(t,e,n){let{windowSize:r,mask:i,maxNumber:o,shiftBy:s}=n,c=Number(t&i),a=t>>s;c>r&&(c-=o,a+=_n);let d=e*r,l=d+Math.abs(c)-1,p=c===0,f=c<0,g=e%2!==0;return{nextN:a,offset:l,isZero:p,isNeg:f,isNegF:g,offsetF:d}}function Mo(t,e){if(!Array.isArray(t))throw new Error("array expected");t.forEach((n,r)=>{if(!(n instanceof e))throw new Error("invalid point at index "+r)})}function Uo(t,e){if(!Array.isArray(t))throw new Error("array of scalars expected");t.forEach((n,r)=>{if(!e.isValid(n))throw new Error("invalid scalar at index "+r)})}var Tn=new WeakMap,ri=new WeakMap;function In(t){return ri.get(t)||1}function ei(t){if(t!==Dt)throw new Error("invalid wNAF")}var Mt=class{constructor(e,n){this.BASE=e.BASE,this.ZERO=e.ZERO,this.Fn=e.Fn,this.bits=n}_unsafeLadder(e,n,r=this.ZERO){let i=e;for(;n>Dt;)n&_n&&(r=r.add(i)),i=i.double(),n>>=_n;return r}precomputeWindow(e,n){let{windows:r,windowSize:i}=An(n,this.bits),o=[],s=e,c=s;for(let a=0;a<r;a++){c=s,o.push(c);for(let d=1;d<i;d++)c=c.add(s),o.push(c);s=c.double()}return o}wNAF(e,n,r){if(!this.Fn.isValid(r))throw new Error("invalid scalar");let i=this.ZERO,o=this.BASE,s=An(e,this.bits);for(let c=0;c<s.windows;c++){let{nextN:a,offset:d,isZero:l,isNeg:p,isNegF:f,offsetF:g}=Qr(r,c,s);r=a,l?o=o.add(Jr(f,n[g])):i=i.add(Jr(p,n[d]))}return ei(r),{p:i,f:o}}wNAFUnsafe(e,n,r,i=this.ZERO){let o=An(e,this.bits);for(let s=0;s<o.windows&&r!==Dt;s++){let{nextN:c,offset:a,isZero:d,isNeg:l}=Qr(r,s,o);if(r=c,!d){let p=n[a];i=i.add(l?p.negate():p)}}return ei(r),i}getPrecomputes(e,n,r){let i=Tn.get(n);return i||(i=this.precomputeWindow(n,e),e!==1&&(typeof r=="function"&&(i=r(i)),Tn.set(n,i))),i}cached(e,n,r){let i=In(e);return this.wNAF(i,this.getPrecomputes(i,e,r),n)}unsafe(e,n,r,i){let o=In(e);return o===1?this._unsafeLadder(e,n,i):this.wNAFUnsafe(o,this.getPrecomputes(o,e,r),n,i)}createCache(e,n){ni(n,this.bits),ri.set(e,n),Tn.delete(e)}hasCache(e){return In(e)!==1}};function Ut(t,e,n,r){Mo(n,t),Uo(r,e);let i=n.length,o=r.length;if(i!==o)throw new Error("arrays of points and scalars must have equal length");let s=t.ZERO,c=qr(BigInt(i)),a=1;c>12?a=c-3:c>4?a=c-2:c>0&&(a=2);let d=lt(a),l=new Array(Number(d)+1).fill(s),p=Math.floor((e.BITS-1)/a)*a,f=s;for(let g=p;g>=0;g-=a){l.fill(s);for(let m=0;m<o;m++){let y=r[m],u=Number(y>>BigInt(g)&d);l[u]=l[u].add(n[m])}let h=s;for(let m=l.length-1,y=s;m>0;m--)y=y.add(l[m]),h=h.add(y);if(f=f.add(h),g!==0)for(let m=0;m<a;m++)f=f.double()}return f}function ti(t,e,n){if(e){if(e.ORDER!==t)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return Xr(e),e}else return Ee(t,{isLE:n})}function ii(t,e,n={},r){if(r===void 0&&(r=t==="edwards"),!e||typeof e!="object")throw new Error(`expected valid ${t} CURVE object`);for(let a of["p","n","h"]){let d=e[a];if(!(typeof d=="bigint"&&d>Dt))throw new Error(`CURVE.${a} must be positive bigint`)}let i=ti(e.p,n.Fp,r),o=ti(e.n,n.Fn,r),c=["Gx","Gy","a",t==="weierstrass"?"b":"d"];for(let a of c)if(!i.isValid(e[a]))throw new Error(`CURVE.${a} must be valid field element of CURVE.Fp`);return e=Object.freeze(Object.assign({},e)),{CURVE:e,Fp:i,Fn:o}}var Be=BigInt(0),G=BigInt(1),Bn=BigInt(2),Ho=BigInt(8);function qo(t,e,n,r){let i=t.sqr(n),o=t.sqr(r),s=t.add(t.mul(e.a,i),o),c=t.add(t.ONE,t.mul(e.d,t.mul(i,o)));return t.eql(s,c)}function Fo(t,e={}){let n=ii("edwards",t,e,e.FpFnLE),{Fp:r,Fn:i}=n,o=n.CURVE,{h:s}=o;qe(e,{},{uvRatio:"function"});let c=Bn<<BigInt(i.BYTES*8)-G,a=y=>r.create(y),d=e.uvRatio||((y,u)=>{try{return{isValid:!0,value:r.sqrt(r.div(y,u))}}catch{return{isValid:!1,value:Be}}});if(!qo(r,o,o.Gx,o.Gy))throw new Error("bad curve params: generator point");function l(y,u,x=!1){let b=x?G:Be;return Ye("coordinate "+y,u,b,c),u}function p(y){if(!(y instanceof h))throw new Error("ExtendedPoint expected")}let f=Sn((y,u)=>{let{X:x,Y:b,Z:T}=y,L=y.is0();u==null&&(u=L?Ho:r.inv(T));let R=a(x*u),I=a(b*u),N=r.mul(T,u);if(L)return{x:Be,y:G};if(N!==G)throw new Error("invZ was invalid");return{x:R,y:I}}),g=Sn(y=>{let{a:u,d:x}=o;if(y.is0())throw new Error("bad point: ZERO");let{X:b,Y:T,Z:L,T:R}=y,I=a(b*b),N=a(T*T),w=a(L*L),v=a(w*w),k=a(I*u),B=a(w*a(k+N)),E=a(v+a(x*a(I*N)));if(B!==E)throw new Error("bad point: equation left != right (1)");let S=a(b*T),O=a(L*R);if(S!==O)throw new Error("bad point: equation left != right (2)");return!0});class h{constructor(u,x,b,T){this.X=l("x",u),this.Y=l("y",x),this.Z=l("z",b,!0),this.T=l("t",T),Object.freeze(this)}static CURVE(){return o}static fromAffine(u){if(u instanceof h)throw new Error("extended point not allowed");let{x,y:b}=u||{};return l("x",x),l("y",b),new h(x,b,G,a(x*b))}static fromBytes(u,x=!1){let b=r.BYTES,{a:T,d:L}=o;u=En(ct(u,b,"point")),Lt(x,"zip215");let R=En(u),I=u[b-1];R[b-1]=I&-129;let N=se(R),w=x?c:r.ORDER;Ye("point.y",N,Be,w);let v=a(N*N),k=a(v-G),B=a(L*v-T),{isValid:E,value:S}=d(k,B);if(!E)throw new Error("bad point: invalid y coordinate");let O=(S&G)===G,P=(I&128)!==0;if(!x&&S===Be&&P)throw new Error("bad point: x=0 and x_0=1");return P!==O&&(S=a(-S)),h.fromAffine({x:S,y:N})}static fromHex(u,x=!1){return h.fromBytes(J("point",u),x)}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(u=8,x=!0){return m.createCache(this,u),x||this.multiply(Bn),this}assertValidity(){g(this)}equals(u){p(u);let{X:x,Y:b,Z:T}=this,{X:L,Y:R,Z:I}=u,N=a(x*I),w=a(L*T),v=a(b*I),k=a(R*T);return N===w&&v===k}is0(){return this.equals(h.ZERO)}negate(){return new h(a(-this.X),this.Y,this.Z,a(-this.T))}double(){let{a:u}=o,{X:x,Y:b,Z:T}=this,L=a(x*x),R=a(b*b),I=a(Bn*a(T*T)),N=a(u*L),w=x+b,v=a(a(w*w)-L-R),k=N+R,B=k-I,E=N-R,S=a(v*B),O=a(k*E),P=a(v*E),D=a(B*k);return new h(S,O,D,P)}add(u){p(u);let{a:x,d:b}=o,{X:T,Y:L,Z:R,T:I}=this,{X:N,Y:w,Z:v,T:k}=u,B=a(T*N),E=a(L*w),S=a(I*b*k),O=a(R*v),P=a((T+L)*(N+w)-B-E),D=O-S,M=O+S,C=a(E-x*B),H=a(P*D),q=a(M*C),F=a(P*C),Z=a(D*M);return new h(H,q,Z,F)}subtract(u){return this.add(u.negate())}multiply(u){if(!i.isValidNot0(u))throw new Error("invalid scalar: expected 1 <= sc < curve.n");let{p:x,f:b}=m.cached(this,u,T=>dt(h,T));return dt(h,[x,b])[0]}multiplyUnsafe(u,x=h.ZERO){if(!i.isValid(u))throw new Error("invalid scalar: expected 0 <= sc < curve.n");return u===Be?h.ZERO:this.is0()||u===G?this:m.unsafe(this,u,b=>dt(h,b),x)}isSmallOrder(){return this.multiplyUnsafe(s).is0()}isTorsionFree(){return m.unsafe(this,o.n).is0()}toAffine(u){return f(this,u)}clearCofactor(){return s===G?this:this.multiplyUnsafe(s)}toBytes(){let{x:u,y:x}=this.toAffine(),b=r.toBytes(x);return b[b.length-1]|=u&G?128:0,b}toHex(){return De(this.toBytes())}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}get ex(){return this.X}get ey(){return this.Y}get ez(){return this.Z}get et(){return this.T}static normalizeZ(u){return dt(h,u)}static msm(u,x){return Ut(h,i,u,x)}_setWindowSize(u){this.precompute(u)}toRawBytes(){return this.toBytes()}}h.BASE=new h(o.Gx,o.Gy,G,a(o.Gx*o.Gy)),h.ZERO=new h(Be,G,G,Be),h.Fp=r,h.Fn=i;let m=new Mt(h,i.BITS);return h.BASE.precompute(8),h}var Ht=class{constructor(e){this.ep=e}static fromBytes(e){Cn()}static fromHex(e){Cn()}get x(){return this.toAffine().x}get y(){return this.toAffine().y}clearCofactor(){return this}assertValidity(){this.ep.assertValidity()}toAffine(e){return this.ep.toAffine(e)}toHex(){return De(this.toBytes())}toString(){return this.toHex()}isTorsionFree(){return!0}isSmallOrder(){return!1}add(e){return this.assertSame(e),this.init(this.ep.add(e.ep))}subtract(e){return this.assertSame(e),this.init(this.ep.subtract(e.ep))}multiply(e){return this.init(this.ep.multiply(e))}multiplyUnsafe(e){return this.init(this.ep.multiplyUnsafe(e))}double(){return this.init(this.ep.double())}negate(){return this.init(this.ep.negate())}precompute(e,n){return this.init(this.ep.precompute(e,n))}toRawBytes(){return this.toBytes()}};function $o(t,e,n={}){if(typeof e!="function")throw new Error('"hash" function param is required');qe(n,{},{adjustScalarBytes:"function",randomBytes:"function",domain:"function",prehash:"function",mapToCurve:"function"});let{prehash:r}=n,{BASE:i,Fp:o,Fn:s}=t,c=n.randomBytes||Me,a=n.adjustScalarBytes||(w=>w),d=n.domain||((w,v,k)=>{if(Lt(k,"phflag"),v.length||k)throw new Error("Contexts/pre-hash are not supported");return w});function l(w){return s.create(se(w))}function p(w){let v=b.secretKey;w=J("private key",w,v);let k=J("hashed private key",e(w),2*v),B=a(k.slice(0,v)),E=k.slice(v,2*v),S=l(B);return{head:B,prefix:E,scalar:S}}function f(w){let{head:v,prefix:k,scalar:B}=p(w),E=i.multiply(B),S=E.toBytes();return{head:v,prefix:k,scalar:B,point:E,pointBytes:S}}function g(w){return f(w).pointBytes}function h(w=Uint8Array.of(),...v){let k=Xe(...v);return l(e(d(k,J("context",w),!!r)))}function m(w,v,k={}){w=J("message",w),r&&(w=r(w));let{prefix:B,scalar:E,pointBytes:S}=f(v),O=h(k.context,B,w),P=i.multiply(O).toBytes(),D=h(k.context,P,S,w),M=s.create(O+D*E);if(!s.isValid(M))throw new Error("sign failed: invalid s");let C=Xe(P,s.toBytes(M));return ct(C,b.signature,"result")}let y={zip215:!0};function u(w,v,k,B=y){let{context:E,zip215:S}=B,O=b.signature;w=J("signature",w,O),v=J("message",v),k=J("publicKey",k,b.publicKey),S!==void 0&&Lt(S,"zip215"),r&&(v=r(v));let P=O/2,D=w.subarray(0,P),M=se(w.subarray(P,O)),C,H,q;try{C=t.fromBytes(k,S),H=t.fromBytes(D,S),q=i.multiplyUnsafe(M)}catch{return!1}if(!S&&C.isSmallOrder())return!1;let F=h(E,H.toBytes(),C.toBytes(),v);return H.add(C.multiplyUnsafe(F)).subtract(q).clearCofactor().is0()}let x=o.BYTES,b={secretKey:x,publicKey:x,signature:2*x,seed:x};function T(w=c(b.seed)){return ct(w,b.seed,"seed")}function L(w){let v=N.randomSecretKey(w);return{secretKey:v,publicKey:g(v)}}function R(w){return Pe(w)&&w.length===s.BYTES}function I(w,v){try{return!!t.fromBytes(w,v)}catch{return!1}}let N={getExtendedPublicKey:f,randomSecretKey:T,isValidSecretKey:R,isValidPublicKey:I,toMontgomery(w){let{y:v}=t.fromBytes(w),k=b.publicKey,B=k===32;if(!B&&k!==57)throw new Error("only defined for 25519 and 448");let E=B?o.div(G+v,G-v):o.div(v-G,v+G);return o.toBytes(E)},toMontgomerySecret(w){let v=b.secretKey;ct(w,v);let k=e(w.subarray(0,v));return a(k).subarray(0,v)},randomPrivateKey:T,precompute(w=8,v=t.BASE){return v.precompute(w,!1)}};return Object.freeze({keygen:L,getPublicKey:g,sign:m,verify:u,utils:N,Point:t,lengths:b})}function jo(t){let e={a:t.a,d:t.d,p:t.Fp.ORDER,n:t.n,h:t.h,Gx:t.Gx,Gy:t.Gy},n=t.Fp,r=Ee(e.n,t.nBitLength,!0),i={Fp:n,Fn:r,uvRatio:t.uvRatio},o={randomBytes:t.randomBytes,adjustScalarBytes:t.adjustScalarBytes,domain:t.domain,prehash:t.prehash,mapToCurve:t.mapToCurve};return{CURVE:e,curveOpts:i,hash:t.hash,eddsaOpts:o}}function Vo(t,e){let n=e.Point;return Object.assign({},e,{ExtendedPoint:n,CURVE:t,nBitLength:n.Fn.BITS,nByteLength:n.Fn.BYTES})}function oi(t){let{CURVE:e,curveOpts:n,hash:r,eddsaOpts:i}=jo(t),o=Fo(e,n),s=$o(o,r,i);return Vo(t,s)}var ft=BigInt(0),Je=BigInt(1),qt=BigInt(2);function Wo(t){return qe(t,{adjustScalarBytes:"function",powPminus2:"function"}),Object.freeze({...t})}function si(t){let e=Wo(t),{P:n,type:r,adjustScalarBytes:i,powPminus2:o,randomBytes:s}=e,c=r==="x25519";if(!c&&r!=="x448")throw new Error("invalid type");let a=s||Me,d=c?255:448,l=c?32:56,p=BigInt(c?9:5),f=BigInt(c?121665:39081),g=c?qt**BigInt(254):qt**BigInt(447),h=c?BigInt(8)*qt**BigInt(251)-Je:BigInt(4)*qt**BigInt(445)-Je,m=g+h+Je,y=E=>V(E,n),u=x(p);function x(E){return Rt(y(E),l)}function b(E){let S=J("u coordinate",E,l);return c&&(S[31]&=127),y(se(S))}function T(E){return se(i(J("scalar",E,l)))}function L(E,S){let O=N(b(S),T(E));if(O===ft)throw new Error("invalid private or public key received");return x(O)}function R(E){return L(E,u)}function I(E,S,O){let P=y(E*(S-O));return S=y(S-P),O=y(O+P),{x_2:S,x_3:O}}function N(E,S){Ye("u",E,ft,n),Ye("scalar",S,g,m);let O=S,P=E,D=Je,M=ft,C=E,H=Je,q=ft;for(let Z=BigInt(d-1);Z>=ft;Z--){let de=O>>Z&Je;q^=de,{x_2:D,x_3:C}=I(q,D,C),{x_2:M,x_3:H}=I(q,M,H),q=de;let fe=D+M,pe=y(fe*fe),he=D-M,ge=y(he*he),me=pe-ge,Ji=C+H,Qi=C-H,rr=y(Qi*fe),ir=y(Ji*he),or=rr+ir,sr=rr-ir;C=y(or*or),H=y(P*y(sr*sr)),D=y(pe*ge),M=y(me*(pe+y(f*me)))}({x_2:D,x_3:C}=I(q,D,C)),{x_2:M,x_3:H}=I(q,M,H);let F=o(M);return y(D*F)}let w={secretKey:l,publicKey:l,seed:l},v=(E=a(l))=>(Y(E,w.seed),E);function k(E){let S=v(E);return{secretKey:S,publicKey:R(S)}}return{keygen:k,getSharedSecret:(E,S)=>L(E,S),getPublicKey:E=>R(E),scalarMult:L,scalarMultBase:R,utils:{randomSecretKey:v,randomPrivateKey:v},GuBytes:u.slice(),lengths:w}}var Go=BigInt(0),Se=BigInt(1),ai=BigInt(2),Ko=BigInt(3),zo=BigInt(5),Zo=BigInt(8),Qe=BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed"),pt={p:Qe,n:BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),h:Zo,a:BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),d:BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),Gx:BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),Gy:BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")};function di(t){let e=BigInt(10),n=BigInt(20),r=BigInt(40),i=BigInt(80),o=Qe,c=t*t%o*t%o,a=ne(c,ai,o)*c%o,d=ne(a,Se,o)*t%o,l=ne(d,zo,o)*d%o,p=ne(l,e,o)*l%o,f=ne(p,n,o)*p%o,g=ne(f,r,o)*f%o,h=ne(g,i,o)*g%o,m=ne(h,i,o)*g%o,y=ne(m,e,o)*l%o;return{pow_p_5_8:ne(y,ai,o)*t%o,b2:c}}function fi(t){return t[0]&=248,t[31]&=127,t[31]|=64,t}var On=BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");function Rn(t,e){let n=Qe,r=V(e*e*e,n),i=V(r*r*e,n),o=di(t*i).pow_p_5_8,s=V(t*r*o,n),c=V(e*s*s,n),a=s,d=V(s*On,n),l=c===t,p=c===V(-t,n),f=c===V(-t*On,n);return l&&(s=a),(p||f)&&(s=d),ve(s,n)&&(s=V(-s,n)),{isValid:l||p,value:s}}var Ce=Ee(pt.p,{isLE:!0}),Xo=Ee(pt.n,{isLE:!0}),Yo={...pt,Fp:Ce,hash:Dr,adjustScalarBytes:fi,uvRatio:Rn},ae=oi(Yo);var Pn=(()=>{let t=Ce.ORDER;return si({P:t,type:"x25519",powPminus2:e=>{let{pow_p_5_8:n,b2:r}=di(e);return V(ne(n,Ko,t)*r,t)},adjustScalarBytes:fi})})();var Nn=On,Jo=BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235"),Qo=BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578"),es=BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838"),ts=BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952"),ci=t=>Rn(Se,t),ns=BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),Ln=t=>ae.Point.Fp.create(se(t)&ns);function li(t){let{d:e}=pt,n=Qe,r=u=>Ce.create(u),i=r(Nn*t*t),o=r((i+Se)*es),s=BigInt(-1),c=r((s-e*i)*r(i+e)),{isValid:a,value:d}=Rn(o,c),l=r(d*t);ve(l,n)||(l=r(-l)),a||(d=l),a||(s=i);let p=r(s*(i-Se)*ts-c),f=d*d,g=r((d+d)*c),h=r(p*Jo),m=r(Se-f),y=r(Se+f);return new ae.Point(r(g*y),r(m*h),r(h*y),r(g*m))}function rs(t){Y(t,64);let e=Ln(t.subarray(0,32)),n=li(e),r=Ln(t.subarray(32,64)),i=li(r);return new ke(n.add(i))}var ke=class t extends Ht{constructor(e){super(e)}static fromAffine(e){return new t(ae.Point.fromAffine(e))}assertSame(e){if(!(e instanceof t))throw new Error("RistrettoPoint expected")}init(e){return new t(e)}static hashToCurve(e){return rs(J("ristrettoHash",e,64))}static fromBytes(e){Y(e,32);let{a:n,d:r}=pt,i=Qe,o=T=>Ce.create(T),s=Ln(e);if(!Hr(Ce.toBytes(s),e)||ve(s,i))throw new Error("invalid ristretto255 encoding 1");let c=o(s*s),a=o(Se+n*c),d=o(Se-n*c),l=o(a*a),p=o(d*d),f=o(n*r*l-p),{isValid:g,value:h}=ci(o(f*p)),m=o(h*d),y=o(h*m*f),u=o((s+s)*m);ve(u,i)&&(u=o(-u));let x=o(a*y),b=o(u*x);if(!g||ve(b,i)||x===Go)throw new Error("invalid ristretto255 encoding 2");return new t(new ae.Point(u,x,Se,b))}static fromHex(e){return t.fromBytes(J("ristrettoHex",e,32))}static msm(e,n){return Ut(t,ae.Point.Fn,e,n)}toBytes(){let{X:e,Y:n,Z:r,T:i}=this.ep,o=Qe,s=y=>Ce.create(y),c=s(s(r+n)*s(r-n)),a=s(e*n),d=s(a*a),{value:l}=ci(s(c*d)),p=s(l*c),f=s(l*a),g=s(p*f*i),h;if(ve(i*g,o)){let y=s(n*Nn),u=s(e*Nn);e=y,n=u,h=s(p*Qo)}else h=f;ve(e*g,o)&&(n=s(-n));let m=s((r-n)*h);return ve(m,o)&&(m=s(-m)),Ce.toBytes(m)}equals(e){this.assertSame(e);let{X:n,Y:r}=this.ep,{X:i,Y:o}=e.ep,s=d=>Ce.create(d),c=s(n*o)===s(r*i),a=s(r*o)===s(n*i);return c||a}is0(){return this.equals(t.ZERO)}};ke.BASE=new ke(ae.Point.BASE);ke.ZERO=new ke(ae.Point.ZERO);ke.Fp=Ce;ke.Fn=Xo;var Ft=class extends ze{constructor(e,n){super(),this.finished=!1,this.destroyed=!1,it(e);let r=Ae(n);if(this.iHash=e.create(),typeof this.iHash.update!="function")throw new Error("Expected instance of class which extends utils.Hash");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;let i=this.blockLen,o=new Uint8Array(i);o.set(r.length>i?e.create().update(r).digest():r);for(let s=0;s<o.length;s++)o[s]^=54;this.iHash.update(o),this.oHash=e.create();for(let s=0;s<o.length;s++)o[s]^=106;this.oHash.update(o),ie(o)}update(e){return Ze(this),this.iHash.update(e),this}digestInto(e){Ze(this),Y(e,this.outputLen),this.finished=!0,this.iHash.digestInto(e),this.oHash.update(e),this.oHash.digestInto(e),this.destroy()}digest(){let e=new Uint8Array(this.oHash.outputLen);return this.digestInto(e),e}_cloneInto(e){e||(e=Object.create(Object.getPrototypeOf(this),{}));let{oHash:n,iHash:r,finished:i,destroyed:o,blockLen:s,outputLen:c}=this;return e=e,e.finished=i,e.destroyed=o,e.blockLen=s,e.outputLen=c,e.oHash=n._cloneInto(e.oHash),e.iHash=r._cloneInto(e.iHash),e}clone(){return this._cloneInto()}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}},$t=(t,e,n)=>new Ft(t,e).update(n).digest();$t.create=(t,e)=>new Ft(t,e);function is(t,e,n){return it(t),n===void 0&&(n=new Uint8Array(t.outputLen)),$t(t,Ae(n),Ae(e))}var Dn=Uint8Array.from([0]),pi=Uint8Array.of();function os(t,e,n,r=32){it(t),Re(r);let i=t.outputLen;if(r>255*i)throw new Error("Length should be <= 255*HashLen");let o=Math.ceil(r/i);n===void 0&&(n=pi);let s=new Uint8Array(o*i),c=$t.create(t,e),a=c._cloneInto(),d=new Uint8Array(c.outputLen);for(let l=0;l<o;l++)Dn[0]=l+1,a.update(l===0?pi:d).update(n).update(Dn).digestInto(d),s.set(d,i*l),c._cloneInto(a);return c.destroy(),a.destroy(),ie(d,Dn),s.slice(0,r)}var hi=(t,e,n,r,i)=>os(t,is(t,e,n),r,i);var jt=Pr;var _={PARSE_ERROR:"parse_error",INVALID_MESSAGE:"invalid_message",VERSION_UNSUPPORTED:"version_unsupported",UNAUTHORIZED:"unauthorized",CAPABILITY_DENIED:"capability_denied",METHOD_NOT_FOUND:"method_not_found",VALIDATION_FAILED:"validation_failed",PAYLOAD_TOO_LARGE:"payload_too_large",RATE_LIMITED:"rate_limited",DEVICE_REVOKED:"device_revoked",SESSION_EXPIRED:"session_expired",PAIRING_EXPIRED:"pairing_expired",PAIRING_INVALID:"pairing_invalid",HOST_OFFLINE:"host_offline",TIMEOUT:"timeout",CANCELLED:"cancelled",INTERNAL:"internal",NOT_CONNECTED:"not_connected",PEER_LOST:"peer_lost",GRANT_EXPIRED:"grant_expired",CONSENT_DENIED:"consent_denied",CONSENT_TIMEOUT:"consent_timeout",POLICY_DENIED:"policy_denied"},ss=Object.values(_),U=class Un extends Error{code;data;constructor(e,n,r){super(n),this.name="CrosslinkError",this.code=e,this.data=r}toWire(){return{code:this.code,message:this.message,data:this.data}}static from(e){if(e instanceof Un)return e;let n=e instanceof Error?e.message:String(e);return new Un(_.INTERNAL,n)}static isInternal(e){return e===_.INTERNAL||e===_.PARSE_ERROR||e===_.INVALID_MESSAGE}};function ht(t){return Hn(t)}function Hn(t){if(t===null)return"null";let e=typeof t;if(e==="boolean")return t?"true":"false";if(e==="number"){if(!Number.isFinite(t))throw new TypeError("canonicalJson: non-finite number");return String(t)}if(e==="bigint")throw new TypeError("canonicalJson: bigint not allowed");if(e==="string")return JSON.stringify(t);if(Array.isArray(t)){let n="[";for(let r=0;r<t.length;r++)r>0&&(n+=","),n+=Hn(t[r]);return n+"]"}if(e==="object"){let n=t,r=Object.keys(n).filter(o=>n[o]!==void 0).sort(),i="{";for(let o=0;o<r.length;o++)o>0&&(i+=","),i+=`${JSON.stringify(r[o])}:${Hn(n[r[o]])}`;return i+"}"}throw new TypeError(`canonicalJson: unsupported type ${e}`)}var mi=typeof Buffer<"u";function j(t){if(mi)return Buffer.from(t).toString("base64");let e="";for(let n=0;n<t.length;n++)e+=String.fromCharCode(t[n]);return btoa(e)}function W(t){if(mi){let r=Buffer.from(t,"base64");return new Uint8Array(r)}let e=atob(t),n=new Uint8Array(e.length);for(let r=0;r<e.length;r++)n[r]=e.charCodeAt(r);return n}var ui="0123456789abcdef";function Fn(t){let e="";for(let n=0;n<t.length;n++)e+=ui[t[n]>>4]+ui[t[n]&15];return e}function yi(t){if(t.length%2!==0||/[^0-9a-f]/i.test(t))throw new TypeError("invalid hex string");let e=new Uint8Array(t.length/2);for(let n=0;n<e.length;n++)e[n]=parseInt(t.slice(n*2,n*2+2),16);return e}var as=new TextEncoder,cs=new TextDecoder,ce=t=>as.encode(t),ls=t=>cs.decode(t);var $={HELLO:"hello",HELLO_OK:"hello_ok",REQ:"req",RES:"res",ERR:"err",CHUNK:"chunk",END:"end",EVT:"evt",SUB:"sub",UNSUB:"unsub",CANCEL:"cancel",PING:"ping",PONG:"pong",BYE:"bye"},et=/^[A-Za-z0-9_-]{1,64}$/,ds=/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/,gi=/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/,fs=/^cd1_[0-9a-f]{32}$/,Mn=/^\d+\.\d+$/;function $n(t){return ps(t(12))}function ps(t){let e="";for(let r=0;r<t.length;r++)e+=String.fromCharCode(t[r]);return(globalThis.btoa!==void 0?btoa(e):hs(e)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}function hs(t){return Buffer.from(t).toString("base64")}function us(t){if(typeof t!="object"||t===null)return"not-an-object";let e=t;if(typeof e.v!="string"||!Mn.test(e.v))return"bad-version";if(!gs(e.t))return"bad-type";switch(e.t){case $.HELLO:{if(!Array.isArray(e.versions)||e.versions.length===0)return"hello-versions";if(!e.versions.every(n=>typeof n=="string"&&Mn.test(n)))return"hello-version-format";if(typeof e.deviceId!="string"||!fs.test(e.deviceId))return"hello-device-id";if(typeof e.appId!="string"||e.appId.length===0||e.appId.length>256)return"hello-app-id";break}case $.HELLO_OK:if(typeof e.version!="string"||!Mn.test(e.version))return"hello-ok-version";break;case $.REQ:if(typeof e.i!="string"||!et.test(e.i))return"req-id";if(typeof e.m!="string"||!ds.test(e.m))return"req-method";if(e.idem!==void 0&&e.idem!==!0)return"req-idem-flag";break;case $.RES:case $.END:case $.CANCEL:if(typeof e.i!="string"||!et.test(e.i))return`${e.t}-id`;break;case $.ERR:if(typeof e.i!="string"||!et.test(e.i))return"err-id";if(typeof e.e!="object"||e.e===null||typeof e.e.code!="string"||!ss.includes(e.e.code)||typeof e.e.message!="string")return"err-body";break;case $.CHUNK:if(typeof e.i!="string"||!et.test(e.i))return"chunk-id";if(typeof e.n!="number"||!Number.isInteger(e.n)||e.n<0)return"chunk-n";if(e.d===void 0)return"chunk-data-missing";break;case $.EVT:if(typeof e.s!="string"||!et.test(e.s))return"evt-sub";if(typeof e.e!="string"||!gi.test(e.e))return"evt-name";break;case $.SUB:case $.UNSUB:if(typeof e.s!="string"||!et.test(e.s))return`${e.t}-sub`;if(e.t===$.SUB&&(typeof e.e!="string"||!gi.test(e.e)))return"sub-event";break;case $.PING:case $.PONG:if(typeof e.ts!="number"||!Number.isFinite(e.ts))return"ts";break;case $.BYE:break}return null}function gs(t){return typeof t=="string"&&Object.values($).includes(t)}var te={DEFAULT_MAX_FRAME_BYTES:4*1024*1024,MAX_FRAME_BYTES_HARD:16*1024*1024,DEFAULT_CHUNK_BYTES:256*1024,DEFAULT_REQUEST_TIMEOUT_MS:3e4,DEFAULT_MAX_INFLIGHT:32,DEFAULT_RATE_PER_SEC:50,PAIRING_CODE_TTL_MS:12e4,HEARTBEAT_INTERVAL_MS:15e3,HEARTBEAT_TIMEOUT_MS:45e3,CLOCK_SKEW_MS:12e4};function $e(t){return ce(ht(t))}function bi(t){let e;try{e=typeof t=="string"?t:ls(t)}catch{throw new U(_.PARSE_ERROR,"payload is not valid UTF-8")}let n;try{n=JSON.parse(e)}catch{throw new U(_.PARSE_ERROR,"payload is not valid JSON")}qn(n,0);let r=us(n);if(r)throw new U(_.INVALID_MESSAGE,`invalid message: ${r}`);return n}function qn(t,e){if(e>64)throw new U(_.INVALID_MESSAGE,"payload nesting exceeds 64");if(Array.isArray(t))for(let n of t)qn(n,e+1);else if(t!==null&&typeof t=="object")for(let n of Object.values(t))qn(n,e+1)}function wi(t){return t==="sinit"||t==="sack"||t==="srej"||t==="enc"||t==="oping"||t==="opong"||t==="bye"}function je(t){return Me(t)}function Vt(...t){let e=0;for(let i of t)e+=i.length;let n=new Uint8Array(e),r=0;for(let i of t)n.set(i,r),r+=i.length;return jt(n)}function Gn(t,e,n,r){return hi(jt,t,e,ce(n),r)}function Bi(t,e){return ae.sign(t,e)}function Kn(t,e,n){try{return ae.verify(t,e,n)}catch{return!1}}function Oi(t){return Pn.getPublicKey(t)}function xi(t,e){let n=Pn.getSharedSecret(t,e),r=new Uint8Array(32),i=0;for(let o=0;o<32;o++)i|=n[o]^r[o];if(i===0)throw new Error("x25519: all-zero shared secret rejected");return n}function ms(t,e,n,r){return pn(t,e,r).encrypt(n)}function ys(t,e,n,r){return pn(t,e,r).decrypt(n)}var bs="cd1_",vi=t=>new TextEncoder().encode(t),zn=class ut{constructor(e){if(this.seed=e,e.length!==32)throw new TypeError("identity seed must be 32 bytes")}seed;_xPriv;_edPub;_xPub;static create(){return new ut(je(32))}static fromSeed(e){return new ut(e)}get edPrivateKey(){return this.seed}get edPublicKey(){return this._edPub||(this._edPub=ae.getPublicKey(this.seed)),this._edPub}get xPrivateKey(){return this._xPriv||(this._xPriv=Gn(this.seed,new Uint8Array(0),"crosslink-x25519-v1",32)),this._xPriv}get xPublicKey(){return this._xPub||(this._xPub=Oi(this.xPrivateKey)),this._xPub}get deviceId(){let e=Vt(vi("deviceId"),this.edPublicKey);return bs+Fn(e).slice(0,32)}get fingerprint(){return Fn(Vt(vi("fingerprint"),this.edPublicKey))}sign(e){return Bi(e,this.edPrivateKey)}verifyOwn(e,n){return Kn(e,n,this.edPublicKey)}toJson(){return{v:1,seed_b64:j(this.seed)}}static fromJson(e){if(!e||e.v!==1||typeof e.seed_b64!="string")throw new TypeError("invalid identity json");return ut.fromSeed(W(e.seed_b64))}static import(e){return ut.fromSeed(yi(e))}};function ws(t,e,n){let[r,i]=xs(e,n)<=0?[e,n]:[n,e],o=Gn(vs(r,i),ce("crosslink-sas-v1"),t,6),s=[];for(let c=0;c<3;c++){let a=(o[c*2]<<8|o[c*2+1])%1e3;s.push(String(a).padStart(3,"0"))}return s.join(" ")}function xs(t,e){let n=Math.min(t.length,e.length);for(let r=0;r<n;r++)if(t[r]!==e[r])return t[r]-e[r];return t.length-e.length}function vs(t,e){let n=new Uint8Array(t.length+e.length);return n.set(t),n.set(e,t.length),n}var Ei={client:"c2h",host:"h2c"},Ci={client:"h2c",host:"c2h"},Es=class{constructor(t,e,n){this.keys=t,this.role=e,this.maxFrameBytes=n}keys;role;maxFrameBytes;sendCounter=0;recvExpected=1;get role_(){return this.role}seal(t){this.sendCounter+=1;let e=this.sendCounter,n=je(24),r=ce(`${Ei[this.role]}:${e}`),i=$e(t);if(i.length>this.maxFrameBytes)throw new U(_.PAYLOAD_TOO_LARGE,`message ${i.length}B exceeds session limit ${this.maxFrameBytes}B`);let o=this.keys[Ei[this.role]],s=ms(o,n,i,r);return{kind:"enc",n:e,iv:j(n),ct:j(s)}}open(t){if(typeof t.n!="number"||!Number.isInteger(t.n)||t.n!==this.recvExpected)throw new U(_.INVALID_MESSAGE,`replay/out-of-order frame: expected n=${this.recvExpected}, got ${String(t.n)}`);let e=t.n;this.recvExpected+=1;let n=W(t.iv);if(n.length!==24)throw new U(_.INVALID_MESSAGE,"bad nonce length");let r=ce(`${Ci[this.role]}:${e}`),i;try{i=ys(this.keys[Ci[this.role]],n,W(t.ct),r)}catch{throw new U(_.INVALID_MESSAGE,"frame failed authentication")}return bi(i)}};var Cs="CLX1",Ss="crosslink-session-keys-v1";function Ni(t,e,n,r,i,o,s,c,a){let d=[Cs,t,e,n,r,i,o,s];return c!==void 0&&a!==void 0&&d.push(c,a),Vt(new TextEncoder().encode(ht(d)))}function Si(t,e){let n=new Uint8Array(t.length+e.length);return n.set(t),n.set(e,t.length),n}function ks(t,e,n={}){let r=je(32),i=Oi(r),o=je(32),s=Bi(Ni(e.appId,t.deviceId,j(t.xPublicKey),j(i),j(o),e.pubEdB64,e.pubXB64),t.edPrivateKey);return{init:{kind:"sinit",v:"1.0",app:e.appId,dev:t.deviceId,sx:j(t.xPublicKey),epk:j(i),nc:j(o),ts:n.nowMs??Date.now(),sig:j(s)},state:{ephPrivate:r,nonceClient:o}}}function As(t,e,n,r,i){let o=W(r.epk),s=W(r.nh);if(o.length!==32||s.length!==32)throw new U(_.INVALID_MESSAGE,"bad accept key material lengths");let c=Ni(n.app,n.dev,n.sx,n.epk,n.nc,j(i.pubEd),j(i.pubX),r.epk,r.nh);if(!Kn(W(r.sig),c,i.pubEd))throw new U(_.UNAUTHORIZED,"host handshake signature invalid");let a=xi(e.ephPrivate,o),d=xi(t.xPrivateKey,i.pubX),l=Gn(Si(a,d),Si(e.nonceClient,s),Ss,64);return{c2h:l.slice(0,32),h2c:l.slice(32,64)}}var ki={trace:10,debug:20,info:30,warn:40,error:50},Ts=/(^|[._-])(secret|token|password|passphrase|seed|privkey|private_?key|auth|authorization|cookie|api_?key|credential)s?([._-]|$)/i,jn=512,Is=4;function _s(t){return Vn(t,0)}function Vn(t,e){if(e>Is)return"[depth]";if(t==null)return t;if(typeof t=="string")return t.length>jn?`${t.slice(0,jn)}\u2026[+${t.length-jn}]`:t;if(typeof t=="number"||typeof t=="boolean"||typeof t=="bigint")return typeof t=="bigint"?t.toString():t;if(t instanceof Error)return{name:t.name,message:t.message,code:t.code};if(t instanceof Uint8Array)return`[bytes ${t.length}]`;if(Array.isArray(t))return t.slice(0,32).map(n=>Vn(n,e+1));if(typeof t=="object"){let n={};for(let[r,i]of Object.entries(t))n[r]=Ts.test(r)?Bs(i):Vn(i,e+1);return n}return String(t)}function Bs(t){return typeof t=="string"?`[redacted ${t.length}]`:t instanceof Uint8Array?`[redacted ${t.length}]`:"[redacted]"}var Os=class Li{constructor(e,n,r){this.sink=e,this.minLevel=n,this.bindings=r}sink;minLevel;bindings;isEnabled(e){return ki[e]>=ki[this.minLevel]}child(e){return new Li(this.sink,this.minLevel,{...this.bindings,...e})}trace(e,n){this.emit("trace",e,n)}debug(e,n){this.emit("debug",e,n)}info(e,n){this.emit("info",e,n)}warn(e,n){this.emit("warn",e,n)}error(e,n){this.emit("error",e,n)}emit(e,n,r){if(!this.isEnabled(e))return;let i;try{i={level:e,time:Date.now(),event:n,fields:_s({...this.bindings,...r??{}})}}catch{i={level:e,time:Date.now(),event:n,fields:{_logError:"field-serialization-failed"}}}try{this.sink(i)}catch{}}},Ri={trace(){},debug(){},info(){},warn(){},error(){},isEnabled:()=>!1,child:()=>Ri},Ve=Ri;function Wt(t,e={}){return new Os(t,e.level??"info",e.bindings??{})}function Pi(t={}){let e=t.console??console;return Wt(r=>{let i=r.level==="error"?e.error:r.level==="warn"?e.warn:r.level==="info"?e.info:e.debug;if(t.json){i.call(e,JSON.stringify(r));return}let o=new Date(r.time).toISOString().slice(11,23),s=Object.entries(r.fields).map(([c,a])=>`${c}=${Ns(a)}`).join(" ");i.call(e,`${o} ${r.level.toUpperCase().padEnd(5)} ${r.event}${s?` ${s}`:""}`)},t)}function Ns(t){return typeof t=="string"?/\s/.test(t)?JSON.stringify(t):t:t==null?String(t):typeof t=="object"?JSON.stringify(t):String(t)}var Di=class{constructor(t=1e3){this.limit=t}limit;records=[];sink=t=>{this.records.push(t),this.records.length>this.limit&&this.records.shift()};logger(t={}){return Wt(this.sink,{level:"trace",...t})}matching(t){return this.records.filter(e=>e.event===t||e.event.startsWith(`${t}.`))}clear(){this.records.length=0}};var Ls=class{constructor(t,e,n,r,i={}){if(this.transport=t,this.meta=n,this.handlers=r,this.maxFrameBytes=i.maxFrameBytes??te.DEFAULT_MAX_FRAME_BYTES,this.cipher=new Es(e,n.role,this.maxFrameBytes),this.log=(i.logger??Ve).child({role:n.role,appId:n.appId,peer:n.peerDeviceId,transport:n.transportKind}),this.log.info("session.opened"),t.onData(o=>this.handleData(o)),t.onClose(o=>this.handleClosed(o)),i.heartbeat!==!1){let o=i.heartbeatIntervalMs??te.HEARTBEAT_INTERVAL_MS,s=i.heartbeatTimeoutMs??te.HEARTBEAT_TIMEOUT_MS;this.hbTimer=setInterval(()=>{let c=Date.now()-this.lastRecvAt;if(c>s){this.log.warn("session.heartbeat-timeout",{silentForMs:c,timeoutMs:s}),this.close("heartbeat-timeout");return}try{this.sendOuter({kind:"oping",ts:Date.now()})}catch{}},o)}}transport;meta;handlers;cipher;log;closed=!1;lastRecvAt=Date.now();hbTimer;maxFrameBytes;get isOpen(){return!this.closed}send(t){this.sendOuter(this.cipher.seal(t))}sendOuter(t){if(this.closed)throw Object.assign(new Error("session closed"),{code:"not_connected"});this.transport.send($e(t))}handleData(t){this.lastRecvAt=Date.now();let e;try{let n=new TextDecoder().decode(t);e=JSON.parse(n)}catch{this.log.warn("session.malformed-frame",{bytes:t.length}),this.close("malformed-outer-frame");return}if(!wi(e.kind)){this.log.warn("session.unknown-frame-kind",{kind:String(e.kind).slice(0,32)}),this.close("unknown-outer-kind");return}switch(e.kind){case"enc":try{let n=this.cipher.open(e);this.handlers.onMessage(n,this)}catch(n){this.log.error("session.decrypt-failed",{error:n}),this.close(n)}break;case"oping":try{this.sendOuter({kind:"opong",ts:e.ts})}catch{}break;case"opong":break;case"bye":case"srej":this.handleClosed(e.reason??e.code??"bye");break;default:break}}close(t){if(!this.closed){this.closed=!0,this.log.info("session.closed",{reason:Ai(t),initiator:"local"}),this.hbTimer&&clearInterval(this.hbTimer);try{let e={kind:"bye",reason:typeof t=="string"?t.slice(0,128):void 0};this.transport.send($e(e))}catch{}try{this.transport.close(t)}catch{}this.handlers.onClose(t)}}handleClosed(t){this.closed||(this.closed=!0,this.log.info("session.closed",{reason:Ai(t),initiator:"peer"}),this.hbTimer&&clearInterval(this.hbTimer),this.handlers.onClose(t))}};function Ai(t){return t===void 0?"unspecified":typeof t=="string"?t.slice(0,128):t instanceof Error?`${t.name}: ${t.message.slice(0,96)}`:String(t).slice(0,128)}var Rs=class{constructor(t,e=te.DEFAULT_REQUEST_TIMEOUT_MS){this.session=t,this.defaultTimeoutMs=e}session;defaultTimeoutMs;pending=new Map;nextSeq=0;subs=new Map;get activeRequests(){return this.pending.size}async call(t,e,n={}){return await this.execute(t,e,void 0,n)}async stream(t,e,n,r={}){return await this.execute(t,e,n,r)}subscribe(t,e){let n=this.subs.get(t);if(!n){let r=`sub_${this.nextSeq++}_${Ps(je(6))}`;n={subId:r,cbs:new Set},this.subs.set(t,n),this.session.send({v:"1.0",t:$.SUB,s:r,e:t})}return n.cbs.add(e),()=>{let r=this.subs.get(t);if(r&&(r.cbs.delete(e),r.cbs.size===0)){this.subs.delete(t);try{this.session.send({v:"1.0",t:$.UNSUB,s:r.subId})}catch{}}}}subscribedEvents(){return[...this.subs.keys()]}cancel(t){try{this.session.send({v:"1.0",t:$.CANCEL,i:t})}catch{}}handleMessage(t){switch(t.t){case $.RES:{let e=this.pending.get(t.i);e&&(this.clearPending(t.i,e),e.resolve(t.p));break}case $.END:{let e=this.pending.get(t.i);e&&(this.clearPending(t.i,e),e.resolve(t.p));break}case $.ERR:{let e=this.pending.get(t.i);e&&(this.clearPending(t.i,e),e.reject(new U(t.e.code,t.e.message,t.e.data)));break}case $.CHUNK:{this.pending.get(t.i)?.onChunk?.(t.d,t.n);break}case $.EVT:{let e=this.subs.get(t.e);if(e&&t.s===e.subId)for(let n of[...e.cbs])try{n(t.p)}catch{}break}default:break}}failAll(t=_.PEER_LOST,e="connection lost"){for(let[n,r]of[...this.pending])this.clearPending(n,r),r.reject(new U(t,e))}execute(t,e,n,r){let i=$n(()=>je(12)),o=r.timeoutMs??this.defaultTimeoutMs;return new Promise((s,c)=>{let a={resolve:s,reject:c,onChunk:n};a.timer=setTimeout(()=>{this.pending.delete(i),a.reject(new U(_.TIMEOUT,`${t} timed out after ${o}ms`)),this.cancel(i)},o),this.pending.set(i,a);try{this.session.send({v:"1.0",t:$.REQ,i,m:t,...e!==void 0?{p:e}:{},ts:Date.now()})}catch{this.clearPending(i,a),a.reject(new U(_.NOT_CONNECTED,"session closed"))}})}clearPending(t,e){e.timer&&clearTimeout(e.timer),this.pending.delete(t)}};function Ps(t){let e="";for(let n=0;n<t.length;n++)e+=String.fromCharCode(t[n]);return btoa(e).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}var Ti={memory:"direct",lan:"direct","webrtc-direct":"direct","turn-relayed":"turn-relayed","crosslink-relayed":"crosslink-relayed"},Mi=class{constructor(t){this.options=t,this.log=(t.logger??Ve).child({component:"client-link",appId:t.appId,device:t.identity.deviceId})}options;session;rpcClient;state="offline";attempts=0;reconnectTimer;stopped=!1;queue=[];desiredSubscriptions=new Map;activeSubscriptions=new Map;log;get currentState(){return this.state}get connected(){return this.session?.isOpen??!1}get rpc(){if(!this.rpcClient||!this.connected)throw new U(_.NOT_CONNECTED,"not connected");return this.rpcClient}async connect(){if(this.stopped&&(this.state==="revoked"||this.state==="unauthorized"||this.state==="protocol-incompatible"))throw new U(this.state==="revoked"?_.DEVICE_REVOKED:this.state==="unauthorized"?_.UNAUTHORIZED:_.VERSION_UNSUPPORTED,`cannot connect: ${this.state}`);this.stopped=!1,clearTimeout(this.reconnectTimer),this.setState("connecting");let t=[];for(let e of this.options.candidates){let n;this.log.debug("link.candidate-dial",{candidate:e.kind});try{n=await e.connect()}catch(i){this.log.debug("link.candidate-failed",{candidate:e.kind,error:i}),t.push(i);continue}if(await this.handshakeOver(n)){this.attempts=0,this.log.info("link.connected",{candidate:e.kind,queued:this.queue.length}),this.setState(Ti[e.kind],{transport:e.kind}),this.flushQueue();return}if(this.stopped)break}if(this.stopped){let e=this.state==="revoked"?_.DEVICE_REVOKED:this.state==="unauthorized"?_.UNAUTHORIZED:this.state==="protocol-incompatible"?_.VERSION_UNSUPPORTED:_.HOST_OFFLINE;throw new U(e,`cannot connect: ${this.state}`)}throw this.log.warn("link.all-candidates-failed",{candidates:this.options.candidates.map(e=>e.kind),failures:t.length}),new U(_.HOST_OFFLINE,"no transport candidate succeeded")}close(){this.log.info("link.close-requested",{state:this.state}),this.stopped=!0,clearTimeout(this.reconnectTimer),this.rpcClient?.failAll(_.NOT_CONNECTED,"client closed"),this.session?.close("client-close"),this.session=void 0,this.rpcClient=void 0,this.setState("offline")}async upgrade(t){if(!this.connected)return this.log.debug("link.upgrade-skipped",{reason:"not-connected"}),!1;let e=this.session?.meta.transportKind;this.log.info("link.upgrade-attempt",{from:e,to:t.kind});let n;try{n=await t.connect()}catch(s){return this.log.warn("link.upgrade-dial-failed",{to:t.kind,error:s}),!1}let r=this.session,i=this.rpcClient;if(!await this.handshakeOver(n))return this.log.warn("link.upgrade-handshake-failed",{to:t.kind}),!1;i?.failAll(_.NOT_CONNECTED,"connection upgraded; retry this request");try{r?.close("upgraded")}catch{}return this.attempts=0,this.log.info("link.upgraded",{from:e,to:t.kind}),this.setState(Ti[t.kind],{transport:t.kind,upgraded:!0}),!0}get transportKind(){return this.session?.meta.transportKind}markRevoked(){this.log.warn("link.revoked"),this.stopped=!0,clearTimeout(this.reconnectTimer),this.rpcClient?.failAll(_.DEVICE_REVOKED,"device revoked"),this.session?.close("revoked"),this.session=void 0,this.rpcClient=void 0,this.setState("revoked")}async call(t,e,n={}){if(!this.rpcClient||!this.connected)throw new U(_.NOT_CONNECTED,"not connected");return this.rpcClient.call(t,e,n)}stream(t,e,n,r={}){return!this.rpcClient||!this.connected?Promise.reject(new U(_.NOT_CONNECTED,"not connected")):this.rpcClient.stream(t,e,n,r)}subscribe(t,e){let n=this.desiredSubscriptions.get(t);n||(n=new Set,this.desiredSubscriptions.set(t,n)),n.add(e);let r=this.rpcClient&&this.connected?this.rpcClient.subscribe(t,e):void 0;return this.activeSubscriptions.set(e,()=>r?.()),()=>{let i=this.desiredSubscriptions.get(t);i?.delete(e),i&&i.size===0&&this.desiredSubscriptions.delete(t),this.activeSubscriptions.get(e)?.(),this.activeSubscriptions.delete(e),r=void 0}}queueIdempotent(t,e){return new Promise((n,r)=>{this.queue.push({method:t,input:e,resolve:n,reject:r})})}get queuedCount(){return this.queue.length}async handshakeOver(t){let e=this.options.hostRecord(),{init:n,state:r}=ks(this.options.identity,{appId:this.options.appId,pubEdB64:e.pubEdB64,pubXB64:e.pubXB64}),i;try{i=await this.requestFrame(t,$e(n),this.options.handshakeTimeoutMs??1e4)}catch(o){this.log.warn("link.handshake-failed",{transport:t.kind,error:o});try{t.close("handshake-error")}catch{}return!1}if(i.kind==="sack"){let o=As(this.options.identity,r,n,i,{pubEd:W(e.pubEdB64),pubX:W(e.pubXB64)});return this.attachSession(t,o),!0}if(i.kind==="srej"){let o=String(i.code??"");return this.log.warn("link.handshake-rejected",{code:o,message:String(i.message??"").slice(0,200)}),t.close(o),o===_.DEVICE_REVOKED?(this.markRevoked(),!1):o===_.VERSION_UNSUPPORTED?(this.setState("protocol-incompatible",{version:n.v}),this.stopped=!0,!1):(o===_.UNAUTHORIZED&&(this.setState("unauthorized"),this.stopped=!0),!1)}return this.log.warn("link.unexpected-handshake-frame",{kind:String(i.kind).slice(0,32)}),t.close("unexpected-handshake-frame"),!1}attachSession(t,e){let n=new Ls(t,e,{role:"client",appId:this.options.appId,peerDeviceId:"host",transportKind:t.kind},{onMessage:r=>{this.rpcClient&&this.rpcClient.handleMessage(r),this.options.onMessage?.(r)},onClose:r=>{try{t.close("session-ended")}catch{}if(this.session!==n){this.log.debug("link.stale-session-closed",{reason:String(r??"")});return}if(r==="device-revoked"){this.markRevoked();return}this.handleDisconnect()}},{maxFrameBytes:this.options.maxFrameBytes??te.DEFAULT_MAX_FRAME_BYTES,logger:this.options.logger});this.session=n,this.rpcClient=new Rs(n,this.options.requestTimeoutMs);for(let[r,i]of this.desiredSubscriptions)for(let o of i){let s=this.rpcClient.subscribe(r,o);this.activeSubscriptions.set(o,s)}this.desiredSubscriptions.size>0&&this.log.debug("link.subscriptions-restored",{events:[...this.desiredSubscriptions.keys()]})}handleDisconnect(){if(this.log.info("link.disconnected",{state:this.state,stopped:this.stopped}),this.activeSubscriptions.clear(),this.rpcClient?.failAll(),this.session=void 0,this.rpcClient=void 0,this.stopped){this.state!=="revoked"&&this.state!=="unauthorized"&&this.state!=="protocol-incompatible"&&this.setState("offline");return}this.scheduleReconnect()}scheduleReconnect(){if(this.stopped)return;let t=++this.attempts,n=Math.min(3e4,500*2**Math.min(t,6))*(.7+Math.random()*.6);this.log.info("link.reconnect-scheduled",{attempt:t,delayMs:Math.round(n)}),this.setState("reconnecting",{attempt:t,delayMs:Math.round(n)}),this.reconnectTimer=setTimeout(()=>{this.stopped||this.connect().catch(()=>{this.stopped||this.scheduleReconnect()})},n)}async flushQueue(){for(;this.queue.length>0&&this.connected;){let t=this.queue.shift();try{let e=await this.rpcClient.call(t.method,t.input);t.resolve(e)}catch(e){this.log.warn("link.queued-call-failed",{method:t.method,error:e}),t.reject(U.from(e))}}}setState(t,e){(this.state!==t||e)&&(this.log.debug("link.state",{from:this.state,to:t,...e??{}}),this.state=t,this.options.onStateChange?.(t,e))}isFatal(t){return t.some(e=>e instanceof U&&[_.DEVICE_REVOKED,_.UNAUTHORIZED,_.VERSION_UNSUPPORTED].includes(e.code))}requestFrame(t,e,n){return new Promise((r,i)=>{let o=!1,s=setTimeout(()=>c(i,new Error("handshake timed out")),n);function c(a,d){o||(o=!0,clearTimeout(s),a===r&&d!==void 0?r(d):i(d instanceof Error?d:new Error(String(d??"handshake failed"))))}t.onData(a=>{try{let d=JSON.parse(new TextDecoder().decode(a));c(r,d)}catch(d){c(i,d instanceof Error?d:new Error("bad handshake frame"))}}),t.onClose(()=>c(i,new Error("transport closed during handshake"))),Promise.resolve().then(()=>t.send(e)).catch(a=>c(i,a instanceof Error?a:new Error(String(a))))})}};var Ds={claim:"crosslink-pair-claim-v1",challenge:"crosslink-pair-challenge-v1",complete:"crosslink-pair-complete-v1"};function Wn(t,e){return ce(ht([Ds[t],...e]))}var Ms=t=>new TextEncoder().encode(t);function Us(t){return qs(jt(Hs(Ms("fingerprint"),t)))}function Hs(t,e){let n=new Uint8Array(t.length+e.length);return n.set(t),n.set(e,t.length),n}function qs(t){let e="";for(let n=0;n<t.length;n++)e+=(t[n]>>4).toString(16)+(t[n]&15).toString(16);return e}var Fs=t=>new TextEncoder().encode(t);function Ui(t,e,n,r){let i=j(je(32));return{claim:{kind:"pair_claim",ps:"",dev:t.deviceId,name:n.slice(0,64),pub_ed:j(t.edPublicKey),pub_x:j(t.xPublicKey),nonce:i,...r&&r.length>0?{caps_req:r}:{}},state:{claimNonce:i}}}function Hi(t,e,n){let r=Wn("claim",[n,String(e.dev),String(e.name),String(e.pub_ed),String(e.pub_x),String(e.nonce),Array.isArray(e.caps_req)?e.caps_req:null]);e.ps=n,e.sig=j(t.sign(r))}async function qi(t,e,n,r,i){if(r.kind!=="pair_challenge")throw new U(_.INVALID_MESSAGE,"expected pair_challenge frame");let o=String(r.host_pub_ed??""),s=String(r.host_pub_x??""),c=String(r.nonce??""),a=Array.isArray(r.granted_caps)?r.granted_caps.map(String):[];if(!Us(W(o)).startsWith(e.fp16))throw new U(_.UNAUTHORIZED,"host identity does not match the scanned QR fingerprint");let l=Wn("challenge",[String(r.ps??""),n.claimNonce,o,s,c,a]);if(!Kn(W(String(r.sig??"")),l,W(o)))throw new U(_.UNAUTHORIZED,"host challenge signature invalid");if(String(r.claim_nonce??"")!==n.claimNonce)throw new U(_.PAIRING_INVALID,"challenge does not match our claim");let f=ws(e.appId,t.edPublicKey,W(o));if(!await i({sas:f,hostName:e.appName,hostFp16:e.fp16,grantedCaps:a}))throw new U(_.PAIRING_INVALID,"pairing cancelled by client user");let h=j(t.sign(Wn("complete",[String(r.ps),n.claimNonce,c]))),m={appId:e.appId,appName:e.appName,fingerprint:$s(o),pubEdB64:o,pubXB64:s,grantedCaps:a,pairedAt:Date.now()};return{complete:{kind:"pair_complete",ps:String(r.ps),claim_nonce:n.claimNonce,challenge_nonce:c,sig:h},record:m}}function $s(t){return js(Vt(Fs("fingerprint"),W(t)))}function js(t){let e="";for(let n=0;n<t.length;n++)e+=(t[n]>>4).toString(16)+(t[n]&15).toString(16);return e}var Ii="crosslink://pair";function Gt(t){let e=t.trim(),n;if(e.startsWith(Ii))n=new URLSearchParams(e.slice(Ii.length));else if(/^https?:\/\//i.test(e)){let l=new URL(e);n=l.searchParams.get("c")!==null||l.searchParams.get("s")!==null||l.searchParams.get("a")!==null?l.searchParams:new URLSearchParams(l.hash.replace(/^#/,""))}else throw new Error("not a crosslink pairing URI");let r=n.get("v"),i=n.get("s"),o=n.get("c"),s=o?Vs(o):"",c=n.get("a"),a=n.get("n")??c??"",d=(n.get("f")??"").toLowerCase();if(r!=="1")throw new Error(`unsupported pairing uri version: ${String(r)}`);if(!i||!/^https?:\/\//i.test(i))throw new Error("pairing uri missing valid signaling url");if(!c||c.length>256||!/^[\w.@:/-]+$/.test(c))throw new Error("pairing uri missing valid app id");if(!/^[0-9a-f]{16}$/.test(d))throw new Error("pairing uri missing fingerprint");return{signalingUrl:i,code:s,appId:c,appName:a,fp16:d}}function Vs(t){let e=t.replace(/\D/g,"");return e.length===9?e:t.trim()}var _i="pair";function Fi(t){let e=t.trim();if(!/^https?:\/\//i.test(e))return e;try{let n=new URL(e),r=new URLSearchParams(n.hash.replace(/^#/,"")),i=r.get(_i);if(i||(r=n.searchParams,i=r.get(_i)),i)return Ws(i)}catch{}return e}function Ws(t){try{return decodeURIComponent(t)}catch{return t}}var $i="crosslink.notification";var Gs="crosslink.webrtc.offer",Ks=65536,zs=15e3,Zs="crosslink";function Xs(t,e){let n=e.timeoutMs??zs;return{kind:"webrtc-direct",connect:async()=>{let r=e.createPeer();try{let i=r.createDataChannel(e.label??Zs,{ordered:!0}),o=Js(i,n);await r.setLocalDescription(await r.createOffer()),await Qs(r,n);let s=r.localDescription?.sdp;if(!s)throw new Error("no local description after createOffer");let c=await t.call(e.method??Gs,{type:"offer",sdp:s},{timeoutMs:n});return await r.setRemoteDescription(Ys(c,"answer")),await o,ea(i)}catch(i){throw r.close(),i}}}}async function ji(t,e){if(t.transportKind==="webrtc-direct")return!0;try{return await t.upgrade(Xs(t,e))}catch{return!1}}function Ys(t,e){let n=t;if(!n||typeof n.sdp!="string"||n.type!==e)throw Object.assign(new Error(`expected an SDP ${e}`),{code:"validation_failed"});if(n.sdp.length>Ks)throw Object.assign(new Error("SDP too large"),{code:"payload_too_large"});return{type:e,sdp:n.sdp}}function Js(t,e){return t.readyState==="open"?Promise.resolve():new Promise((n,r)=>{let i=setTimeout(()=>r(new Error("datachannel open timeout")),e);t.onopen=()=>{clearTimeout(i),n()},t.onerror=()=>{clearTimeout(i),r(new Error("datachannel error"))}})}function Qs(t,e){return t.iceGatheringState==="complete"?Promise.resolve():new Promise(n=>{let r=()=>{t.onicegatheringstatechange=null,n()};t.onicegatheringstatechange=()=>{t.iceGatheringState==="complete"&&r()},setTimeout(r,Math.min(2e3,e))})}function ea(t,e="webrtc-direct"){let n,r,i=!1;t.binaryType="arraybuffer",t.onmessage=async s=>{if(i)return;let c=s.data,a=c instanceof ArrayBuffer?new Uint8Array(c):new Uint8Array(c.buffer,c.byteOffset,c.byteLength);n?.(a)};let o=()=>{i||(i=!0,r?.("dc-closed"))};return t.onclose=o,t.onerror=o,{kind:e,onData(s){n=s},onClose(s){r=s},async send(s){if(i||t.readyState!=="open")throw new Error("datachannel closed");t.send(s)},close(s){if(!i){try{t.close()}catch{}i=!0,r?.(typeof s=="string"?s:"closed")}}}}gt();Zt();function ra(t){if(t instanceof ArrayBuffer)return new Uint8Array(t);if(ArrayBuffer.isView(t)){let e=t;return new Uint8Array(e.buffer,e.byteOffset,e.byteLength)}if(typeof t=="string")throw new Error("unexpected text frame");if(typeof Blob<"u"&&t instanceof Blob)return t.arrayBuffer().then(e=>new Uint8Array(e));throw new Error("unsupported websocket message type")}function Xt(t,e){return new Promise((n,r)=>{let i=!1,o=setTimeout(()=>{if(!i){i=!0;try{t.close()}catch{}r(new Error(`connection timed out after ${e}ms`))}},e),s=()=>{i||(i=!0,clearTimeout(o),t.removeEventListener?.("error",c),n())},c=()=>{i||(i=!0,clearTimeout(o),r(new Error("connection failed")))};t.addEventListener("open",s),t.addEventListener("error",c)})}function bt(t,e){try{t.binaryType="arraybuffer"}catch{}let n,r,i=!1;t.addEventListener("message",s=>{if(i)return;let c;try{c=ra(s.data)}catch{return}if(c instanceof Uint8Array){n?.(c);return}c.then(a=>{i||n?.(a)})});let o=()=>{i||(i=!0,r?.("ws-closed"))};return t.addEventListener("close",o),t.addEventListener("error",()=>{try{t.close()}catch{}o()}),{kind:e,onData(s){n=s},onClose(s){r=s},async send(s){if(i||t.readyState!==1)throw new Error("transport closed");t.send(s)},close(s){if(!i)try{t.close(1e3,typeof s=="string"?s.slice(0,100):void 0)}catch{}}}}var nt=class t{constructor(e){this.ws=e;e.addEventListener("message",n=>{let r;try{r=JSON.parse(String(n.data))}catch{return}if(r.op==="pair_deliver"&&typeof r.blob=="string"){let i={from:String(r.from),blob:r.blob},o=this.resolvers.shift();o?o(i):this.queue.push(i);return}r.op==="error"&&this.fail(new Error(`signaling error: ${JSON.stringify(r.error??{})}`)),r.op==="pair_not_found"&&this.fail(new Error("PAIRING_EXPIRED: code not found or expired"))}),e.addEventListener("close",()=>this.fail(new Error("signaling connection closed"))),e.addEventListener("error",()=>this.fail(new Error("signaling connection failed")))}queue=[];resolvers=[];failure;failureWaiters=[];static async open(e,n=1e4){let r=e(),i=new t(r);try{await Xt(r,n)}catch{throw new Error("cannot reach signaling")}return i}async resolve(e){return this.send({op:"pair_resolve",code:e}),new Promise((n,r)=>{let i=o=>{let s;try{s=JSON.parse(String(o.data))}catch{return}s.op==="pair_found"?(this.ws.removeEventListener?.("message",i),n({psid:String(s.psid),hostConn:String(s.host_conn),app:s.app})):s.op==="pair_not_found"?(this.ws.removeEventListener?.("message",i),r(new Error("PAIRING_EXPIRED"))):s.op==="error"&&(this.ws.removeEventListener?.("message",i),r(new Error(String(s.error?.code??"error"))))};this.ws.addEventListener("message",i)})}sendTo(e,n){this.send({op:"pair_payload",to:e,blob:n})}nextBlob(e,n=15e3){let r=this.queue.findIndex(i=>i.from===e);return r>=0?Promise.resolve(this.queue.splice(r,1)[0].blob):new Promise((i,o)=>{let s=setTimeout(()=>{this.failureWaiters=this.failureWaiters.filter(a=>a!==c),o(new Error("timeout awaiting pairing reply"))},n),c=a=>{clearTimeout(s),o(a||new Error("peer closed"))};this.resolvers.push(a=>{clearTimeout(s),this.failureWaiters=this.failureWaiters.filter(d=>d!==c),a.from===e?i(a.blob):(this.queue.push(a),this.resolvers.push(d=>i(d.blob)),o(new Error("blob from unexpected sender")))}),this.failureWaiters.push(c),this.failure&&c(this.failure)})}close(){try{this.ws.close(1e3,"done")}catch{}}send(e){this.ws.send(JSON.stringify(e))}fail(e){this.failure=e;let n=this.failureWaiters.splice(0);for(let r of n)r(e)}};var Yn=class{file;constructor(e){this.file=new Oe(e,"crosslink.apps")}all(){return this.file.load({apps:{}}).apps}list(){return Object.values(this.all())}get(e){return this.all()[e]}upsert(e){let n=this.file.load({apps:{}});n.apps[e.appId]=e,this.file.save(n)}remove(e){let n=this.file.load({apps:{}});delete n.apps[e],this.file.save(n)}},le=class t{constructor(e={}){this.options=e;let n=e.storage??new We;this.storage=n,this.appStore=new Yn(n),this.hints=new Oe(n,"crosslink.hints"),this.log=(e.logger??Ve).child({component:"crosslink-client"});let r="crosslink.identity.seed",i=n.get(r);i?this.identity=zn.fromSeed(oa(i)):(this.identity=zn.create(),n.set(r,j(this.identity.seed)),this.log.info("client.identity-created",{deviceId:this.identity.deviceId}))}log;identity;appStore;hints;link;storage;deviceCryptoStorage;static async create(e={}){if(e.storage)return new t(e);let n=e.logger??Ve,{storage:r,kind:i,encrypted:o}=await tt({...e.allowPlaintextFallback!==void 0?{allowPlaintextFallback:e.allowPlaintextFallback}:{},onWriteError:(s,c)=>n.error("client.storage-write-failed",{key:c,error:s})});return o?n.info("client.storage",{kind:i}):n.warn("client.storage-not-encrypted",{kind:i,detail:"identity seed is stored in the clear; WebCrypto/IndexedDB unavailable"}),new t({...e,storage:r})}get deviceId(){return this.identity.deviceId}listApps(){return this.appStore.list()}forget(e){this.appStore.remove(e),this.link?.close(),this.link=void 0}async pairFromQr(e,n,r){if(!this.deviceCryptoStorage)try{let d=await Promise.resolve().then(()=>(Ki(),Gi));this.deviceCryptoStorage=await d.SecureDeviceCryptoStorage.open()}catch(d){this.log.warn("client.device-crypto-init-failed",{error:String(d)})}let i=Fi(e),o=Gt(i),s=(r??o.code).replace(/\D/g,"");if(s.length!==9)throw new Error("A valid 9-digit pairing code is required");if(!o.signalingUrl)throw new Error("pairing URI has no signaling URL (LAN-only pairing not supported by browser client)");let c=`${o.signalingUrl.replace(/^http/,"ws").replace(/\/$/,"")}/ws`,a=await nt.open(()=>this.ws(c),this.options.dialTimeoutMs??1e4);try{let d=await a.resolve(s);if(!d.app.fingerprint.startsWith(o.fp16))throw this.log.error("client.fingerprint-mismatch",{expected:o.fp16,got:d.app.fingerprint.slice(0,16)}),new Error("SECURITY: host fingerprint does not match the scanned code");let{claim:l,state:p}=Ui(this.identity,o,this.options.deviceName??"browser",n);Hi(this.identity,l,d.psid),a.sendTo(d.hostConn,JSON.stringify(l));let f=await a.nextBlob(d.hostConn),g=JSON.parse(f);if(g.kind==="pair_error")throw new Error(`PAIRING_FAILED: ${JSON.stringify(g.error??{})}`);let h=L=>typeof window<"u"&&typeof window.confirm=="function"?window.confirm(`Confirm pairing with "${L.hostName}"?

SAS: ${L.sas}
Capabilities: ${L.grantedCaps.join(", ")||"(none)"}`):!0,m=this.options.onConfirmPairing??h,{complete:y,record:u}=await qi(this.identity,o,p,g,m);a.sendTo(d.hostConn,JSON.stringify(y));let x=await a.nextBlob(d.hostConn),b=JSON.parse(x);if(b.kind==="pair_error")throw new Error(`PAIRING_FAILED: ${JSON.stringify(b.error??{})}`);u.lastConnected=Date.now(),this.appStore.upsert(u),this.log.info("client.paired",{appId:u.appId,appName:u.appName,grantedCaps:u.grantedCaps,requestedCaps:n??null});let T=this.hints.load({});if(T[u.appId]={relay:d.app.relay,lan:d.app.lan,signalingUrl:o.signalingUrl},this.hints.save(T),b&&typeof b.sessionToken=="string")try{await this.deviceCryptoStorage?.save({sessionToken:b.sessionToken},u.appId)}catch(L){this.log.debug("client.session-token-store-failed",{error:String(L)})}return u}finally{a.close()}}async connect(e){let n=e?this.appStore.get(e):this.appStore.list()[0];if(!n)throw new Error("no paired app"+(e?` for ${e}`:""));if(this.link&&this.link.currentState!=="offline"&&this.link.currentState!=="connecting"&&this.link.currentState!=="reconnecting")return this.rpc();let r=this.hints.load({}),i=r[n.appId]??{},o=null;if(i.signalingUrl){let l=this.options.fetch??globalThis.fetch;try{let p=await l(`${i.signalingUrl.replace(/\/$/,"")}/apps/${encodeURIComponent(n.appId)}`);p.ok&&(o=await p.json(),r[n.appId]={...i,...o},this.hints.save(r))}catch(p){this.log.debug("client.presence-lookup-failed",{appId:n.appId,error:p})}}let s=o?.relay??i.relay,c=o?.lan??i.lan,a=[];if(c&&c.host&&a.push({kind:"lan",connect:async()=>{let{ws:l,ready:p}=zi(`ws://${c.host}:${c.port}`,f=>this.ws(f),this.options.dialTimeoutMs??1e4);return await p,bt(l,"lan")}}),s&&this.options.networkMode!=="local-only"&&a.push({kind:"crosslink-relayed",connect:async()=>{let p=`${`${s.url.replace(/^http/,"ws").replace(/\/$/,"")}/ws`}?channel=${encodeURIComponent(s.channel)}&role=c`+(this.options.relayToken?`&auth=${encodeURIComponent(this.options.relayToken)}`:""),{ws:f,ready:g}=zi(p,h=>this.ws(h),this.options.dialTimeoutMs??1e4);return await g,bt(f,"crosslink-relayed")}}),a.length===0)throw this.log.warn("client.no-candidates",{appId:n.appId}),new Error("no known transport for this app; re-pair or check host is online");this.log.debug("client.connecting",{appId:n.appId,candidates:a.map(l=>l.kind)}),this.link?.close();let d=new Mi({identity:this.identity,appId:n.appId,hostRecord:()=>{let l=this.appStore.get(n.appId);return l.lastConnected=Date.now(),l},candidates:a,autoReconnect:!0,requestTimeoutMs:this.options.requestTimeoutMs,onStateChange:this.options.onStateChange,logger:this.options.logger});return this.link=d,await d.connect(),this.options.webrtc&&this.tryWebrtcUpgrade(d),d.rpc}async tryWebrtcUpgrade(e){if(this.options.webrtc?.createPeer)try{await ji(e,{createPeer:this.options.webrtc.createPeer,timeoutMs:this.options.webrtc.timeoutMs})&&this.log.info("client.webrtc-upgraded")}catch(n){this.log.debug("client.webrtc-upgrade-failed",{error:n})}}rpc(){if(!this.link||!this.link.connected)throw new Error("not connected");return this.link.rpc}get connection(){return this.link}async pairFromBootstrap(e,n,r){return this.pairFromQr(e,n,r)}async pairWithCode(e,n,r){return this.pairFromQr(e,r,n)}get storageEncrypted(){return this.storage.encrypted===!0}ws(e){return(this.options.webSocket??ia)(e)}get state(){return this.link?.currentState??"offline"}close(){this.link?.close(),this.link=void 0}};function ia(t){let e=globalThis.WebSocket;if(typeof e!="function")throw new Error("WebSocket not available in this environment");return new e(t)}function zi(t,e,n){let r=e(t);return{ws:r,ready:Xt(r,n)}}function oa(t){let e=sa(t),n=new Uint8Array(e.length);for(let r=0;r<e.length;r++)n[r]=e.charCodeAt(r);return n}function sa(t){return typeof atob=="function"?atob(t):Buffer.from(t,"base64").toString("binary")}var Yt=class t{constructor(e,n={}){this.url=e;let r=()=>{if(this.readyState===0){if(n.failToOpen){this.readyState=3,this.emit("error",{type:"error"}),this.emit("close",{code:1006,reason:"failed to open"});return}this.readyState=1,this.emit("open",{type:"open"})}};n.openDelayMs&&n.openDelayMs>0?setTimeout(r,n.openDelayMs):queueMicrotask(r)}readyState=0;binaryType="arraybuffer";sent=[];listeners=new Map;peer;static pair(e="ws://a",n="ws://b"){let r=new t(e),i=new t(n);return r.attach(i),i.attach(r),[r,i]}attach(e){this.peer=e}addEventListener(e,n){let r=this.listeners.get(e);r||(r=new Set,this.listeners.set(e,r)),r.add(n)}removeEventListener(e,n){this.listeners.get(e)?.delete(n)}send(e){if(this.readyState!==1)throw new Error("mock socket is not open");this.sent.push(e),queueMicrotask(()=>this.peer?.deliver(e))}close(e=1e3,n=""){if(this.readyState===3||this.readyState===2)return;this.readyState=3,this.emit("close",{code:e,reason:n});let r=this.peer;queueMicrotask(()=>r?.remoteClosed(e,n))}fail(e="mock failure"){if(this.readyState===3)return;this.emit("error",{type:"error",reason:e}),this.readyState=3,this.emit("close",{code:1006,reason:e});let n=this.peer;queueMicrotask(()=>n?.remoteClosed(1006,e))}deliver(e){this.readyState===1&&this.emit("message",{data:e})}remoteClosed(e,n){this.readyState!==3&&(this.readyState=3,this.emit("close",{code:e,reason:n}))}emit(e,n){for(let r of[...this.listeners.get(e)??[]])try{r(n)}catch{}}};gt();Zt();var Jt=class{constructor(e={}){this.options=e}unsub;seen=new Set;start(e){return this.options.autoRequestPermission&&typeof Notification<"u"&&Notification.requestPermission(),this.unsub=e.subscribe($i,n=>{!n.id||this.seen.has(n.id)||(this.seen.add(n.id),this.deliver(n))}),()=>this.stop()}stop(){this.unsub?.(),this.unsub=void 0}deliver(e){if(this.options.onNotification){this.options.onNotification(e);return}if(typeof Notification>"u"||Notification.permission!=="granted")return;let n=new Notification(e.title,{body:e.body,tag:e.id,icon:e.url});n.onclick=()=>{this.options.onClick?.(e),e.url&&window.open(e.url,"_blank"),n.close()}}};var aa=`
<svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="currentColor" fill-rule="evenodd"/>
</svg>
`.trim(),ca=`
.cl-pair-card {
  --cl-bg: #000000;
  --cl-fg: #ffffff;
  --cl-muted: #9a9a9a;
  --cl-divider: #2a2a2a;
  --cl-pill: #e7e7ea;
  --cl-pill-text: #0a0a0a;
  --cl-radius: 28px;
  --cl-accent: #38bdf8;
  position: relative;
  background: var(--cl-bg);
  color: var(--cl-fg);
  border-radius: var(--cl-radius);
  padding: 28px 32px;
  margin: 20px 0;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1.1fr auto 1fr auto 1fr;
  align-items: center;
  gap: 28px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: left;
}
.cl-pair-card * {
  box-sizing: border-box;
}

/* \u2500\u2500 Cog Button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-cog-btn {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--cl-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
  z-index: 20;
}
.cl-cog-btn:hover {
  color: var(--cl-fg);
  background: rgba(255, 255, 255, 0.1);
}
.cl-cog-btn svg {
  width: 17px;
  height: 17px;
  display: block;
}

/* \u2500\u2500 Small Dropdown Menu \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-settings-dropdown {
  position: absolute;
  top: 44px;
  right: 14px;
  width: 300px;
  background: var(--cl-bg);
  border: 1px solid var(--cl-divider);
  border-radius: 12px;
  padding: 8px;
  z-index: 30;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08);
  animation: clDropdownFade 0.12s ease-out;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cl-settings-dropdown[hidden] {
  display: none;
}
@keyframes clDropdownFade {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.cl-dropdown-header {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cl-muted);
  padding: 6px 8px 4px 8px;
}
.cl-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--cl-fg);
  transition: background 0.12s;
  position: relative;
  user-select: none;
}
.cl-dropdown-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.cl-dropdown-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.cl-dropdown-label input[type="radio"] {
  accent-color: var(--cl-accent);
  cursor: pointer;
  margin: 0;
}
.cl-info-knob-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cl-info-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: var(--cl-muted);
  font-size: 11px;
  font-weight: 700;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.cl-info-knob:hover,
.cl-info-knob:focus {
  background: var(--cl-accent);
  color: #082f49;
}
/* Tooltip on hover / focus */
.cl-dropdown-tooltip {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 250px;
  background: #020617;
  border: 1px solid var(--cl-divider);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.45;
  color: #cbd5e1;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-2px);
  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
  z-index: 50;
}
.cl-info-knob-wrap:hover .cl-dropdown-tooltip,
.cl-info-knob-wrap:focus-within .cl-dropdown-tooltip {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
}
.cl-dropdown-tooltip a {
  color: var(--cl-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  display: inline-block;
  margin-top: 6px;
}

/* \u2500\u2500 Columns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-pair-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.cl-pair-logo {
  height: 24px;
  width: auto;
  max-width: 140px;
  display: block;
  margin-bottom: 14px;
  color: var(--cl-fg);
}
.cl-pair-blurb {
  font-size: 13px;
  line-height: 1.55;
  color: var(--cl-muted);
  max-width: 32ch;
  margin: 0;
}
.cl-pair-blurb strong {
  color: var(--cl-fg);
  font-weight: 600;
}
.cl-pair-refresh {
  appearance: none;
  background: none;
  border: none;
  color: var(--cl-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  padding: 0;
  margin-top: 14px;
  transition: color 0.15s;
}
.cl-pair-refresh:hover {
  color: var(--cl-fg);
}
.cl-pair-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.cl-pair-divider {
  width: 1px;
  align-self: stretch;
  background: var(--cl-divider);
}
.cl-pair-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: none;
  color: var(--cl-fg);
  margin: 0 0 14px 0;
  text-align: center;
}
.cl-pair-center,
.cl-pair-right {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.cl-qr-wrap {
  background: #ffffff;
  border-radius: 16px;
  padding: 12px;
  min-width: 176px;
  min-height: 176px;
  width: 176px;
  height: 176px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.cl-qr-wrap svg {
  width: 152px;
  height: 152px;
  display: block;
}
.cl-qr-wrap img {
  width: 152px;
  height: 152px;
  display: block;
  border-radius: 8px;
}
.cl-qr-placeholder {
  color: #6b6b6b;
  font-size: 12px;
  text-align: center;
  max-width: 140px;
  line-height: 1.4;
}
.cl-qr-placeholder.cl-error {
  color: #f87171;
}
.cl-pair-code-pills {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  max-width: 200px;
  justify-content: center;
  min-height: 44px;
  align-items: center;
}
.cl-pair-code-pills .cl-pill {
  background: var(--cl-pill);
  color: var(--cl-pill-text);
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  border-radius: 12px;
  padding: 14px 8px;
  min-width: 44px;
  text-align: center;
  display: block;
}
.cl-pair-hint {
  font-size: 11px;
  color: var(--cl-muted);
  margin: 12px 0 0 0;
  text-align: center;
}
@media (max-width: 860px) {
  .cl-pair-card {
    grid-template-columns: 1fr;
    text-align: center;
    padding: 20px 24px;
    gap: 20px;
  }
  .cl-pair-left {
    align-items: center;
  }
  .cl-pair-card .cl-pair-divider {
    width: 100%;
    height: 1px;
  }
  .cl-pair-logo {
    margin-left: auto;
    margin-right: auto;
  }
  .cl-pair-blurb {
    max-width: none;
  }
}

/* \u2500\u2500 Connected Devices Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-connected-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clDropdownFade 0.15s ease-out;
}
.cl-connected-modal {
  background: #0a0a0a;
  border: 1px solid var(--cl-divider);
  border-radius: 20px;
  width: 92vw;
  max-width: 640px;
  max-height: 85vh;
  padding: 24px 28px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.06);
  overflow-y: auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--cl-fg);
}
.cl-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
}
.cl-modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.cl-modal-header button {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--cl-divider);
  border-radius: 10px;
  color: var(--cl-fg);
  font-size: 20px;
  line-height: 1;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-modal-header button:hover {
  background: rgba(255, 255, 255, 0.15);
}
.cl-modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cl-modal-error {
  color: #f87171;
  font-size: 12px;
  padding: 8px 0;
}
.cl-device-card {
  background: #121212;
  border: 1px solid var(--cl-divider);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.cl-device-info {
  flex: 1;
  min-width: 0;
}
.cl-device-name {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 4px;
  letter-spacing: -0.01em;
}
.cl-device-meta {
  font-size: 11px;
  color: var(--cl-muted);
  margin-bottom: 8px;
  text-transform: capitalize;
}
.cl-device-detail {
  font-size: 11px;
  line-height: 1.5;
  color: #c4c4c4;
}
.cl-device-detail strong {
  color: var(--cl-muted);
  font-weight: 600;
}
.cl-device-actions {
  flex-shrink: 0;
}
.cl-revoke-btn {
  background: #1a1a2e;
  border: 1px solid #2a2a3a;
  color: #e7e7ea;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.cl-revoke-btn:hover {
  background: #7f1d1d;
  border-color: #f87171;
  color: #f87171;
}
`.trim(),Zi=!1;function Jn(){if(Zi||typeof document>"u")return;let t=document.createElement("style");t.id="crosslink-pairing-card-styles",t.textContent=ca,document.head.appendChild(t),Zi=!0}var wt=class{element;options;logoEl;blurbEl;refreshBtn;qrWrapEl;codePillsEl;hintEl;settingsPopover;currentMode;expiryTimer=null;constructor(e={}){this.options=e,this.currentMode=e.networkMode||"local",e.injectStyles!==!1&&Jn(),this.element=document.createElement("div"),this.element.className="cl-pair-card",this.applyTheme(e.theme);let n=document.createElement("button");n.className="cl-cog-btn",n.title="Connection Settings",n.setAttribute("aria-label","Connection Settings"),n.innerHTML=`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    `,n.addEventListener("click",()=>this.toggleSettings()),this.settingsPopover=this.createSettingsPopover();let r=document.createElement("div");r.className="cl-pair-left",this.logoEl=document.createElement("div"),this.logoEl.className="cl-pair-logo-wrap",this.renderLogo(e.logo),this.blurbEl=document.createElement("p"),this.blurbEl.className="cl-pair-blurb",this.blurbEl.innerHTML=e.blurb??"<strong>Connect your phone</strong> to sync securely with this app. The link is end-to-end encrypted &mdash; relays only ever see ciphertext.",this.refreshBtn=document.createElement("button"),this.refreshBtn.className="cl-pair-refresh",this.refreshBtn.textContent="Refresh code",this.refreshBtn.addEventListener("click",()=>this.handleRefresh()),r.appendChild(this.logoEl),r.appendChild(this.blurbEl),r.appendChild(this.refreshBtn);let i=document.createElement("div");i.className="cl-pair-divider";let o=document.createElement("div");o.className="cl-pair-center";let s=document.createElement("h3");s.className="cl-pair-label",s.textContent="Scan this on your device",this.qrWrapEl=document.createElement("div"),this.qrWrapEl.className="cl-qr-wrap",this.renderQr(e.qr),o.appendChild(s),o.appendChild(this.qrWrapEl);let c=document.createElement("div");c.className="cl-pair-divider";let a=document.createElement("div");a.className="cl-pair-right";let d=document.createElement("h3");d.className="cl-pair-label",d.textContent="Pairing Code",this.codePillsEl=document.createElement("div"),this.codePillsEl.className="cl-pair-code-pills",this.renderCode(e.code),this.hintEl=document.createElement("p"),this.hintEl.className="cl-pair-hint",this.renderExpiry(e.expiresAt),a.appendChild(d),a.appendChild(this.codePillsEl),a.appendChild(this.hintEl),this.element.appendChild(n),this.element.appendChild(this.settingsPopover),this.element.appendChild(r),this.element.appendChild(i),this.element.appendChild(o),this.element.appendChild(c),this.element.appendChild(a),e.target&&this.mount(e.target),typeof document<"u"&&typeof document.addEventListener=="function"&&document.addEventListener("click",l=>{this.element.contains(l.target)||this.toggleSettings(!1)})}normalizeMode(e){return e==="local"||e==="local-only"?"local":e==="ngrok"?"ngrok":e==="open-lan"||e==="open-lan-remote"||e==="remote"?"open-lan":e==="cloudflare"||e==="open-lan-cloudflared"||e==="cloudflared"?"cloudflare":"local"}createSettingsPopover(){let e=document.createElement("div");e.className="cl-settings-dropdown",e.hidden=!0;let n=this.options.cloudflareGuideUrl||"https://crosslink.dev/docs/connection-modes#cloudflared",r=this.options.securityGuideUrl||"https://crosslink.dev/docs/connection-modes#remote",i=this.options.lanGuideUrl||"https://crosslink.dev/docs/connection-modes#local",o=this.options.ngrokGuideUrl||"https://crosslink.dev/docs/connection-modes#ngrok",s=this.normalizeMode(this.currentMode);e.innerHTML=`
      <div class="cl-dropdown-header">Connection Mode</div>
      
      <!-- Option 1: Local (Default) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="local" ${s==="local"?"checked":""}>
          <span>Local</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">\u2139</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Direct peer connection on your local Wi-Fi or LAN subnet. Zero internet dependency.<br>
            <strong>Security:</strong> Direct local link with XChaCha20-Poly1305 E2E encryption.
            <a href="${i}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 2: ngrok -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="ngrok" ${s==="ngrok"?"checked":""}>
          <span>ngrok</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">\u2139</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Routes traffic through your personal ngrok tunnel with custom auth tokens and domains.<br>
            <strong>Security:</strong> TLS tunnel edge with Crosslink E2E ciphertext encryption.
            <a href="${o}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 3: Open Lan (Remote) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="open-lan" ${s==="open-lan"?"checked":""}>
          <span>Open Lan (Remote)</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">\u2139</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Uses your public WAN IP with automatic router port mapping (UPnP / NAT-PMP / PCP). If no mapping exists, falls back to LAN. Only displays a public QR after verifying reachability.<br>
            <strong>Security:</strong> End-to-end encrypted (XChaCha20-Poly1305). Only ciphertext travels over public internet.
            <a href="${r}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 4: Open Lan (Cloudflared) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="cloudflare" ${s==="cloudflare"?"checked":""}>
          <span>Open Lan (Cloudflared)</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">\u2139</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> 0-cost Cloudflare Quick Tunnel. Skips "Add to Home Screen" \u2014 scan and chat immediately in mobile browser.<br>
            <strong>Security:</strong> Cloudflare TLS edge termination with Crosslink E2E ciphertext security.
            <a href="${n}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>
    `,e.querySelectorAll('input[name="cl-net-mode"]').forEach(l=>{l.addEventListener("change",p=>{let f=p.target.value;this.setNetworkMode(f)})});let a=document.createElement("div");a.className="cl-dropdown-header",a.style.marginTop="4px",a.textContent="Devices",e.appendChild(a);let d=document.createElement("label");return d.className="cl-dropdown-item",d.innerHTML=`
      <div class="cl-dropdown-label">
        <span>Connected Devices</span>
      </div>
    `,d.addEventListener("click",()=>this.openConnectedDevicesModal()),e.appendChild(d),e}toggleSettings(e){let n=this.settingsPopover.hidden,r=e!==void 0?e:n;this.settingsPopover.hidden=!r}setNetworkMode(e){this.currentMode=e;let n=this.normalizeMode(e);try{typeof localStorage<"u"&&localStorage.setItem("crosslink.networkMode",e)}catch{}let r=this.settingsPopover.querySelector(`input[value="${n}"]`);r&&(r.checked=!0),this.options.onNetworkModeChange&&this.options.onNetworkModeChange(e)}getNetworkMode(){return this.currentMode}mount(e){let n=typeof e=="string"?document.querySelector(e):e;if(!n)throw new Error(`PairingCard target element not found: ${String(e)}`);return n.appendChild(this.element),this}update(e){return e.loading?(this.qrWrapEl.innerHTML='<span class="cl-qr-placeholder">Generating&hellip;</span>',this.refreshBtn.disabled=!0):this.refreshBtn.disabled=!1,e.networkMode&&this.setNetworkMode(e.networkMode),e.error?(this.qrWrapEl.innerHTML=`<span class="cl-qr-placeholder cl-error">${e.error}</span>`,this.codePillsEl.replaceChildren(),this.hintEl.textContent="",this):(e.qr!==void 0&&this.renderQr(e.qr),e.code!==void 0&&this.renderCode(e.code),e.expiresAt!==void 0&&this.renderExpiry(e.expiresAt),this)}applyTheme(e){if(!e)return this;let n=this.element.style;return e.bg&&n.setProperty("--cl-bg",e.bg),e.fg&&n.setProperty("--cl-fg",e.fg),e.muted&&n.setProperty("--cl-muted",e.muted),e.divider&&n.setProperty("--cl-divider",e.divider),e.pill&&n.setProperty("--cl-pill",e.pill),e.pillText&&n.setProperty("--cl-pill-text",e.pillText),e.radius&&n.setProperty("--cl-radius",e.radius),this}setBlurb(e){return this.blurbEl.innerHTML=e,this}renderLogo(e){if(this.logoEl.replaceChildren(),e)if(e.trim().startsWith("<svg")){this.logoEl.innerHTML=e;let n=this.logoEl.querySelector("svg");n&&n.classList.add("cl-pair-logo")}else{let n=document.createElement("img");n.src=e,n.alt="Crosslink",n.className="cl-pair-logo",this.logoEl.appendChild(n)}else{this.logoEl.innerHTML=aa;let n=this.logoEl.querySelector("svg");n&&n.classList.add("cl-pair-logo")}}renderQr(e){if(this.qrWrapEl.replaceChildren(),!e){let n=document.createElement("span");n.className="cl-qr-placeholder",n.textContent="Generating\u2026",this.qrWrapEl.appendChild(n);return}if(e.trim().startsWith("<svg"))this.qrWrapEl.innerHTML=e;else{let n=document.createElement("img");n.src=e,n.alt="Scan to pair",this.qrWrapEl.appendChild(n)}}renderCode(e){if(this.codePillsEl.replaceChildren(),!e)return;let n=String(e).replace(/\D/g,"");for(let r of n){let i=document.createElement("span");i.className="cl-pill",i.textContent=r,this.codePillsEl.appendChild(i)}}renderExpiry(e){if(clearInterval(this.expiryTimer),!e){this.hintEl.textContent="";return}if(typeof e=="string"){this.hintEl.textContent=e;return}let n=()=>{let r=Math.max(0,Math.round((e-Date.now())/1e3));if(r<=0)this.hintEl.textContent="code expired \u2014 click refresh",clearInterval(this.expiryTimer);else{let i=Math.floor(r/60),o=r%60;this.hintEl.textContent=i>0?`expires in ${i}m ${o}s`:`expires in ${o}s`}};n(),this.expiryTimer=setInterval(n,1e3)}async handleRefresh(){if(this.options.onRefresh){this.refreshBtn.disabled=!0;try{await this.options.onRefresh()}finally{this.refreshBtn.disabled=!1}}}async openConnectedDevicesModal(){let e=this.options.devicesEndpoint||"/api/devices";try{let n=await fetch(e);if(!n.ok)throw new Error(`Failed to fetch devices: ${n.status}`);let r=await n.json(),i=r.devices||r||[];this.renderConnectedDevicesModal(i)}catch(n){this.renderConnectedDevicesModal([],String(n?.message||n))}}renderConnectedDevicesModal(e,n){let r=document.querySelector(".cl-connected-modal-backdrop");r&&r.remove();let i=document.createElement("div");i.className="cl-connected-modal-backdrop",i.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:100;display:flex;align-items:center;justify-content:center;animation:clDropdownFade 0.15s ease-out;";let o=document.createElement("div");o.className="cl-connected-modal";let s=document.createElement("div");s.className="cl-modal-header";let c=document.createElement("h3");c.textContent="Connected Devices";let a=document.createElement("button");a.type="button",a.setAttribute("aria-label","Close"),a.innerHTML="&times;",a.addEventListener("click",()=>i.remove()),s.appendChild(c),s.appendChild(a);let d=document.createElement("div");if(d.className="cl-modal-body",n){let l=document.createElement("div");l.className="cl-modal-error",l.textContent=n,d.appendChild(l)}if(e.length===0&&!n){let l=document.createElement("p");l.style.cssText="color:var(--cl-muted);text-align:center;padding:20px 0;",l.textContent="No paired devices found.",d.appendChild(l)}else for(let l of e){let p=document.createElement("div");p.className="cl-device-card";let f=l.status||(l.revokedAt?"Revoked":l.lastConnected?Date.now()-l.lastConnected<3e5?"Online":"Offline":"Unknown"),g=f==="Online"?"#4ade80":f==="Revoked"?"#f87171":"#9a9a9a",h=l.revokedAt?"Not trusted":"Trusted",m=l.firstPaired?new Date(l.firstPaired).toLocaleString():"Unknown",y=l.lastConnected?new Date(l.lastConnected).toLocaleString():"Never",u=document.createElement("div");u.className="cl-device-info";let x=document.createElement("div");x.className="cl-device-name",x.textContent=l.name||"Unnamed Device";let b=document.createElement("div");b.className="cl-device-meta";let T="";l.deviceType&&(T+=`<span style="text-transform:capitalize;">${l.deviceType}</span>`),l.location&&(T+=`${T?" &bull; ":""}${l.location}`),b.innerHTML=T;let L=document.createElement("div");L.className="cl-device-detail",L.innerHTML=`
          <span><strong>Device ID:</strong> ${l.deviceId}</span><br>
          <span><strong>IP:</strong> ${l.ipAddress||"Not available"}</span><br>
          <span><strong>First paired:</strong> ${m}</span><br>
          <span><strong>Last connected:</strong> ${y}</span><br>
          <span><strong>Status:</strong> <span style="color:${g};font-weight:600;">${f}</span></span><br>
          <span><strong>Trusted:</strong> ${h}</span>
        `,u.appendChild(x),u.appendChild(b),u.appendChild(L);let R=document.createElement("div");if(R.className="cl-device-actions",l.revokedAt){let I=document.createElement("span");I.style.cssText="color:#9a9a9a;font-size:12px;",I.textContent="Access Revoked",R.appendChild(I)}else{let I=document.createElement("button");I.className="cl-revoke-btn",I.textContent="Revoke Access",I.addEventListener("click",async()=>{I.disabled=!0,I.textContent="Revoking...";try{let N=this.options.revokeEndpoint||"/api/devices/revoke";if(!(await fetch(N,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({deviceId:l.deviceId})})).ok)throw new Error("Revoke failed");I.textContent="Access Revoked",I.style.background="#166534",I.disabled=!0,setTimeout(()=>{this.openConnectedDevicesModal()},800)}catch{I.textContent="Failed",I.style.background="#7f1d1d"}}),R.appendChild(I)}p.appendChild(u),p.appendChild(R),d.appendChild(p)}o.appendChild(s),o.appendChild(d),i.appendChild(o),document.body.appendChild(i),i.addEventListener("click",l=>{l.target===i&&i.remove()})}destroy(){clearInterval(this.expiryTimer),this.element.remove()}};function Xi(t={}){return new wt(t)}var Ke={title:"Host is unavailable",message:`This app can't reach your computer right now.

Open the desktop app to reconnect automatically.`,icon:"",appName:"Crosslink",themeColor:"#0f172a",bgColor:"#0f172a"},xt=class{client;options;currentState="connecting";reachabilityTimer=null;reconnectTimer=null;visibilityHandler=null;onlineHandler=null;isPageVisible=!0;attemptCount=0;isAttempting=!1;offlineElement=null;constructor(e){if(this.options={clientOptions:e.clientOptions,offline:{...Ke,...e.offline},onConnected:e.onConnected,onAuthRequired:e.onAuthRequired,onStateChange:e.onStateChange??(()=>{}),minRetryDelay:e.minRetryDelay??1e3,maxRetryDelay:e.maxRetryDelay??3e4,reachabilityCheckInterval:e.reachabilityCheckInterval??1e4,serviceWorkerUrl:e.serviceWorkerUrl??"/sw.js",autoRegisterServiceWorker:e.autoRegisterServiceWorker??!0,autoMountOfflineUI:e.autoMountOfflineUI??!0,container:e.container},e.client)this.client=e.client;else{let n=e.clientOptions?.onStateChange,r={...e.clientOptions,onStateChange:(i,o)=>{n?.(i,o),this.handleClientStateChange(i,o)}};this.client=new le(r)}this.setupVisibilityHandlers(),this.setupOnlineHandler()}async start(){if(this.options.autoRegisterServiceWorker&&typeof navigator<"u"&&"serviceWorker"in navigator)try{await navigator.serviceWorker.register(this.options.serviceWorkerUrl)}catch(n){console.warn("[OfflineShell] Service worker registration notice:",n)}let e=this.client.listApps();if(e.length===0){this.setState("authentication-required"),await this.options.onAuthRequired();return}await this.attemptSilentAuth(e[0])}async attemptSilentAuth(e){if(!this.isAttempting){this.isAttempting=!0,this.currentState!=="reconnecting"&&this.setState("connecting");try{let n=await this.client.connect(e.appId);this.isAttempting=!1,this.cancelTimers(),this.unmountOfflineUI(),this.setState("connected"),await this.options.onConnected(n,this.client)}catch(n){this.isAttempting=!1,await this.handleConnectionError(n,e)}}}handleClientStateChange(e,n){e==="revoked"||e==="unauthorized"?(this.unmountOfflineUI(),this.cancelTimers(),this.setState("authentication-required",n),this.options.onAuthRequired()):e==="offline"&&this.currentState==="connected"&&this.showHostOffline()}async handleConnectionError(e,n){let r=String(e?.message??e??"").toLowerCase(),i=this.client.state;if(r.includes("revoked")||r.includes("device_revoked")||r.includes("device-revoked")||r.includes("unauthorized")||r.includes("not paired")||r.includes("fingerprint")||r.includes("signature invalid")||r.includes("challenge nonce")||i==="revoked"||i==="unauthorized"){this.unmountOfflineUI(),this.cancelTimers(),this.setState("authentication-failed"),await this.options.onAuthRequired();return}this.showHostOffline()}showHostOffline(){this.setState("host-offline"),this.options.autoMountOfflineUI&&this.mountOfflineUI(),this.scheduleReconnect(),this.startReachabilityChecks()}scheduleReconnect(){if(this.reconnectTimer)return;let n=Math.min(this.options.maxRetryDelay,this.options.minRetryDelay*Math.pow(1.5,Math.min(this.attemptCount,8)))*(.8+Math.random()*.4),r=Math.max(1,Math.round(n/1e3));this.updateOfflineStatus(`Reconnecting in ${r}s\u2026`),this.reconnectTimer=setTimeout(async()=>{this.reconnectTimer=null,this.attemptCount++,await this.reconnectNow()},n)}async reconnectNow(){if(this.currentState==="connected"||this.isAttempting)return;let e=this.client.listApps();if(e.length===0){this.setState("authentication-required"),await this.options.onAuthRequired();return}this.reconnectTimer&&(clearTimeout(this.reconnectTimer),this.reconnectTimer=null),this.setState("reconnecting",{attempt:this.attemptCount}),this.updateOfflineStatus("Trying to reconnect\u2026"),await this.attemptSilentAuth(e[0])}startReachabilityChecks(){if(this.reachabilityTimer)return;let e=async()=>{if(this.currentState!=="host-offline"&&this.currentState!=="reconnecting"){this.cancelReachabilityChecks();return}let n=this.client.listApps();if(n.length===0)return;(await this.checkHostReachability(n[0].appId)).reachable&&(this.cancelReachabilityChecks(),await this.reconnectNow())};this.reachabilityTimer=setInterval(e,this.options.reachabilityCheckInterval)}cancelReachabilityChecks(){this.reachabilityTimer&&(clearInterval(this.reachabilityTimer),this.reachabilityTimer=null)}async checkHostReachability(e){let n=this.getHints(e);if(!n)return{reachable:!1};if(n.signalingUrl)try{let r=new AbortController,i=setTimeout(()=>r.abort(),4e3),s=await(this.options.clientOptions?.fetch??globalThis.fetch)(`${n.signalingUrl.replace(/\/$/,"")}/apps/${encodeURIComponent(e)}`,{signal:r.signal,cache:"no-store"});if(clearTimeout(i),s.ok){let c=await s.json().catch(()=>({}));return{reachable:!0,hostInfo:{relay:c.relay,lan:c.lan,fingerprint:c.fingerprint}}}}catch{}return{reachable:!1}}cancelTimers(){this.cancelReachabilityChecks(),this.reconnectTimer&&(clearTimeout(this.reconnectTimer),this.reconnectTimer=null),this.attemptCount=0}setState(e,n){this.currentState!==e&&(this.currentState=e,this.options.onStateChange(e,n))}getHints(e){try{return this.client.hints?.load?.({})?.[e]??null}catch{return null}}setupVisibilityHandlers(){typeof document>"u"||(this.visibilityHandler=()=>{this.isPageVisible=!document.hidden,this.isPageVisible&&(this.currentState==="host-offline"||this.currentState==="reconnecting")&&this.reconnectNow().catch(()=>{})},document.addEventListener("visibilitychange",this.visibilityHandler))}setupOnlineHandler(){typeof window>"u"||(this.onlineHandler=()=>{(this.currentState==="host-offline"||this.currentState==="reconnecting")&&this.reconnectNow().catch(()=>{})},window.addEventListener("online",this.onlineHandler))}mountOfflineUI(){if(typeof document>"u")return;if(!this.offlineElement){let n={...Ke,...this.options.offline};this.offlineElement=rt(n,()=>this.forceReconnect())}let e=this.options.container??document.body;e&&!e.contains(this.offlineElement)&&e.appendChild(this.offlineElement)}unmountOfflineUI(){this.offlineElement&&this.offlineElement.parentElement&&this.offlineElement.remove(),this.offlineElement=null}updateOfflineStatus(e){if(typeof document>"u")return;let n=document.getElementById("crosslink-offline-status");n&&(n.textContent=e)}getState(){return this.currentState}async forceReconnect(){this.attemptCount=0,await this.reconnectNow()}destroy(){this.cancelTimers(),this.unmountOfflineUI(),typeof document<"u"&&this.visibilityHandler&&(document.removeEventListener("visibilitychange",this.visibilityHandler),this.visibilityHandler=null),typeof window<"u"&&this.onlineHandler&&(window.removeEventListener("online",this.onlineHandler),this.onlineHandler=null)}getClient(){return this.client}};function rt(t,e){let n=document.createElement("div");if(n.id="crosslink-offline-shell",n.style.cssText=`
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: ${t.bgColor||"#0f172a"};
    color: #f8fafc;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    text-align: center;
    box-sizing: border-box;
    overflow: hidden;
  `,t.icon){let a=document.createElement("img");a.src=t.icon,a.alt=t.appName||"App Icon",a.style.cssText=`
      width: 72px;
      height: 72px;
      border-radius: 18px;
      margin-bottom: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
      object-fit: cover;
    `,n.appendChild(a)}else{let a=document.createElement("div");a.style.cssText=`
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    `,a.innerHTML=`
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.8;">
        <path d="M1 1l22 22"></path>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
        <line x1="12" y1="20" x2="12.01" y2="20"></line>
      </svg>
    `,n.appendChild(a)}let r=document.createElement("h1");r.textContent=t.title||`${t.appName} is unavailable`,r.style.cssText=`
    font-size: 21px;
    font-weight: 700;
    margin: 0 0 10px 0;
    color: #f8fafc;
    letter-spacing: -0.02em;
  `,n.appendChild(r);let i=document.createElement("p");i.style.cssText=`
    color: #94a3b8;
    font-size: 14px;
    line-height: 1.55;
    max-width: 300px;
    margin: 0 0 28px 0;
    white-space: pre-line;
  `,i.textContent=t.message||`Open ${t.appName} on your computer to reconnect.`,n.appendChild(i);let o=document.createElement("div");o.style.cssText=`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 24px;
    padding: 6px 14px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  `;let s=document.createElement("div");s.style.cssText=`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #38bdf8;
    box-shadow: 0 0 8px #38bdf8;
    animation: clPulse 1.5s ease-in-out infinite;
  `;let c=document.createElement("span");if(c.id="crosslink-offline-status",c.style.cssText=`
    color: #38bdf8;
    font-size: 13px;
    font-weight: 500;
  `,c.textContent="Trying to reconnect\u2026",o.appendChild(s),o.appendChild(c),n.appendChild(o),e){let a=document.createElement("button");a.textContent="Retry Now",a.style.cssText=`
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      padding: 8px 20px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    `,a.onmouseenter=()=>{a.style.background="rgba(255, 255, 255, 0.18)"},a.onmouseleave=()=>{a.style.background="rgba(255, 255, 255, 0.1)"},a.onclick=()=>{e()},n.appendChild(a)}if(typeof document<"u"&&!document.getElementById("crosslink-offline-styles")){let a=document.createElement("style");a.id="crosslink-offline-styles",a.textContent=`
      @keyframes clPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.85); }
      }
    `,document.head.appendChild(a)}return n}function Qn(t){if(typeof document>"u")return;let e=document.getElementById("crosslink-offline-status");e&&(e.textContent=t)}function er(){if(typeof document>"u")return;document.getElementById("crosslink-offline-shell")?.remove()}function Qt(){return typeof window>"u"?!1:window.matchMedia?.("(display-mode: standalone)")?.matches===!0||window.navigator?.standalone===!0}async function vt(){if(!(typeof window>"u"))try{if(localStorage.clear(),sessionStorage.clear(),window.indexedDB?.databases){let t=await window.indexedDB.databases();for(let e of t)e.name&&window.indexedDB.deleteDatabase(e.name)}else window.indexedDB?.deleteDatabase("crosslink-secure-storage");if("caches"in window){let t=await caches.keys();for(let e of t)await caches.delete(e)}}catch(t){console.warn("[Crosslink] Storage reset warning:",t)}}var la=`
/* \u2500\u2500 Crosslink Mobile Framework Styles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-screen-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: #0f172a;
  color: #f8fafc;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center;
  overflow-y: auto;
  -webkit-tap-highlight-color: transparent;
}
.cl-screen-overlay * {
  box-sizing: border-box;
}

/* \u2500\u2500 Screen A: Pairing Screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-pair-screen {
  gap: 20px;
}
.cl-pair-logo {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  object-fit: cover;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
}
.cl-pair-icon-fallback {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #38bdf8;
}
.cl-pair-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: #f8fafc;
}
.cl-pair-desc {
  font-size: 14px;
  color: #94a3b8;
  max-width: 290px;
  line-height: 1.5;
  margin: 0;
}
.cl-pair-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  max-width: 260px;
  margin: 8px 0;
}
.cl-pair-digit {
  width: 72px;
  height: 64px;
  font-size: 26px;
  text-align: center;
  border-radius: 14px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #f8fafc;
  font-weight: 700;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cl-pair-digit:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
}
.cl-pair-err {
  font-size: 13px;
  color: #f87171;
  min-height: 20px;
  margin: 0;
  line-height: 1.4;
  max-width: 280px;
}
.cl-pair-reset {
  margin-top: 12px;
  background: transparent;
  border: none;
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  text-decoration: underline;
  transition: color 0.15s;
}
.cl-pair-reset:hover {
  color: #94a3b8;
}

/* \u2500\u2500 Screen B: Add to Home Screen (Screen B) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-bootstrap-screen {
  background: #000000;
  justify-content: center;
  position: fixed;
  inset: 0;
  z-index: 100000;
  height: 100dvh;
}
.cl-bootstrap-mark {
  width: min(65vw, 170px);
  height: auto;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.08);
  padding: 10px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
}
.cl-bootstrap-appname {
  font-size: 21px;
  font-weight: 600;
  color: #ffffff;
  margin-top: 18px;
  letter-spacing: -0.01em;
}
.cl-continue-btn {
  margin-top: 20px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #ffffff;
  padding: 11px 24px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-continue-btn:hover {
  background: rgba(255, 255, 255, 0.25);
}
.cl-bootstrap-nudge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(18px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
}
.cl-bootstrap-nudge span {
  font-family: "Caveat", "Segoe Script", "Bradley Hand", cursive, sans-serif;
  font-size: 21px;
  color: #ffffff;
  opacity: 0.92;
  text-align: center;
  max-width: 280px;
  line-height: 1.2;
}
.cl-bootstrap-nudge svg {
  width: 46px;
  height: 46px;
  color: #ffffff;
  opacity: 0.92;
}

/* \u2500\u2500 SAS Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-sas-modal {
  position: fixed;
  inset: 0;
  z-index: 100001;
  background: rgba(0, 0, 0, 0.88);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  gap: 14px;
  text-align: center;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, sans-serif;
}
.cl-sas-modal h2 { font-size: 18px; color: #fff; margin: 0; }
.cl-sas-modal p { color: #94a3b8; font-size: 13px; margin: 0; }
.cl-sas-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 100%;
  max-width: 240px;
  margin: 10px 0;
}
.cl-sas-grid span {
  display: grid;
  place-items: center;
  aspect-ratio: 1.5;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  font-size: 24px;
  font-weight: 700;
  color: #f8fafc;
  font-variant-numeric: tabular-nums;
}
.cl-sas-caps { color: #94a3b8; font-size: 12px; }
.cl-sas-actions { display: flex; gap: 12px; margin-top: 10px; }
.cl-sas-actions button {
  padding: 10px 22px;
  border-radius: 999px;
  border: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.cl-sas-ok { background: #38bdf8; color: #082f49; }
.cl-sas-no { background: #1e293b; color: #f8fafc; border: 1px solid #334155 !important; }
`.trim(),Yi=!1;function en(){if(Yi||typeof document>"u")return;let t=document.createElement("style");t.id="crosslink-bootstrap-styles",t.textContent=la,document.head.appendChild(t),Yi=!0}var Et=class{client;options;state="initializing";currentScreenElement=null;reconnectTimer=null;reachabilityTimer=null;visibilityHandler=null;onlineHandler=null;isAttempting=!1;attemptCount=0;activeRpc=null;targetPairingUri=null;constructor(e){if(this.options=e,en(),e.client)this.client=e.client;else{let n={...e.clientOptions,deviceName:e.clientOptions?.deviceName??"mobile",onConfirmPairing:r=>this.showSasConfirmation(r),onStateChange:(r,i)=>this.handleClientStateChange(r,i)};this.client=new le(n)}this.setupListeners()}async start(){if(this.options.autoRegisterServiceWorker!==!1&&typeof navigator<"u"&&"serviceWorker"in navigator)try{await navigator.serviceWorker.register(this.options.serviceWorkerUrl??"/sw.js")}catch{}if(this.extractPairingUriFromLocation(),typeof location<"u"&&(new URLSearchParams(location.search).has("reset")||location.hash.includes("reset"))){if(await vt(),this.targetPairingUri)try{localStorage.setItem("crosslink.pendingPair",this.targetPairingUri)}catch{}location.href=location.pathname;return}let e=this.client.listApps();if(e.length===0){this.transitionTo("pairing-required");return}await this.attemptSilentAuth(e[0])}extractPairingUriFromLocation(){if(this.options.pairingUri){this.targetPairingUri=this.options.pairingUri;return}if(typeof location>"u")return;let n=new URLSearchParams(location.search).get("pair")||"";if(n){this.targetPairingUri=n;try{localStorage.setItem("crosslink.pendingPair",n)}catch{}}else try{this.targetPairingUri=localStorage.getItem("crosslink.pendingPair")}catch{}}getEffectiveAppId(){if(this.options.appId)return this.options.appId;let e=this.client.listApps();if(e.length>0)return e[0].appId;if(this.targetPairingUri)try{let n=Gt(this.targetPairingUri);if(n.appId)return n.appId}catch{}return"default"}completedOnboardingApps=new Set;isOnboardingCompleted(e){return Qt()||this.completedOnboardingApps.has(e)?!0:typeof localStorage<"u"?localStorage.getItem(`crosslink.onboarding.${e}`)==="true":!1}markOnboardingCompleted(e){this.completedOnboardingApps.add(e),typeof localStorage<"u"&&localStorage.setItem(`crosslink.onboarding.${e}`,"true")}clearOnboarding(e){this.completedOnboardingApps.delete(e),typeof localStorage<"u"&&localStorage.removeItem(`crosslink.onboarding.${e}`)}async attemptSilentAuth(e){if(!this.isAttempting){this.isAttempting=!0;try{let n=await this.client.connect(e.appId);this.activeRpc=n,this.isAttempting=!1,this.cancelTimers(),this.isOnboardingCompleted(e.appId)?this.transitionTo("authorized"):this.transitionTo("add-to-home-screen")}catch(n){this.isAttempting=!1,await this.handleAuthError(n,e)}}}async handleAuthError(e,n){let r=String(e?.message??e??"").toLowerCase(),i=this.client.state;if(r.includes("revoked")||r.includes("device_revoked")||r.includes("device-revoked")||r.includes("unauthorized")||r.includes("not paired")||r.includes("signature invalid")||r.includes("challenge nonce")||i==="revoked"||i==="unauthorized"){this.client.forget(n.appId),this.clearOnboarding(n.appId),this.transitionTo("pairing-required",{reason:"revoked"});return}this.transitionTo("offline"),this.scheduleReconnect()}handleClientStateChange(e,n){if(e==="revoked"||e==="unauthorized"){let r=this.getEffectiveAppId();this.client.forget(r),this.clearOnboarding(r),this.transitionTo("pairing-required",{reason:"revoked",...n})}else e==="offline"&&this.state==="authorized"&&(this.transitionTo("offline"),this.scheduleReconnect())}transitionTo(e,n){if(this.state=e,this.options.onStateChange?.(e,n),this.unmountCurrentScreen(),e==="authorized"){let i=this.activeRpc;if(!i)try{i=this.client.rpc()}catch{}i&&this.options.onAuthorized(i,this.client);return}this.options.onUnauthorized?.();let r=this.options.container??(typeof document<"u"?document.body:null);if(r)switch(e){case"pairing-required":case"pairing":{let i=this.createPairingScreen(o=>this.handlePairingSubmit(o));this.currentScreenElement=i,r.appendChild(i);break}case"add-to-home-screen":{let i=this.getEffectiveAppId(),o=this.createAddToHomeScreen(()=>{this.markOnboardingCompleted(i),this.transitionTo("authorized")});this.currentScreenElement=o,r.appendChild(o);break}case"offline":{let i={...Ke,...this.options.offline,appName:this.options.appName||this.options.offline?.appName||"Crosslink"},o=rt(i,()=>this.forceReconnect());this.currentScreenElement=o,r.appendChild(o);break}}}unmountCurrentScreen(){this.currentScreenElement&&this.currentScreenElement.parentElement&&this.currentScreenElement.remove(),this.currentScreenElement=null}async handlePairingSubmit(e){let n=document.getElementById("cl-pair-err");n&&(n.textContent="Verifying pairing code\u2026",n.style.color="#38bdf8");try{if(this.options.verifyPairEndpoint||typeof fetch<"u"){let s=this.options.verifyPairEndpoint??"/api/verify-pair";try{let c=await fetch(s,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:e})});if(c.ok){let a=await c.json().catch(()=>({}));if(a&&a.ok===!1){n&&(n.textContent="Incorrect pairing code. Please try again.",n.style.color="#f87171");return}}}catch{}}let i=this.targetPairingUri||(typeof localStorage<"u"?localStorage.getItem("crosslink.pendingPair"):null);if(!i&&typeof location<"u"&&(i=`crosslink://pair?v=1&s=${encodeURIComponent(location.origin)}&a=${encodeURIComponent(this.options.appId||"com.crosslink.app")}&n=${encodeURIComponent(this.options.appName||"Crosslink")}&f=0000000000000000`),i){let s=this.options.capabilities??[];await this.client.pairWithCode(i,e,s),typeof localStorage<"u"&&localStorage.removeItem("crosslink.pendingPair")}let o=this.client.listApps();o.length>0&&await this.attemptSilentAuth(o[0])}catch(r){n&&(n.textContent=`Pairing failed: ${r.message||String(r)}`,n.style.color="#f87171")}}createPairingScreen(e){let n=document.createElement("div");n.id="crosslink-pairing-screen",n.className="cl-screen-overlay cl-pair-screen";let r=this.options.onboarding?.icon||this.options.offline?.icon;if(r){let l=document.createElement("img");l.className="cl-pair-logo",l.src=r,l.alt=this.options.appName||"App",n.appendChild(l)}else{let l=document.createElement("div");l.className="cl-pair-icon-fallback",l.innerHTML=`
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
          <line x1="12" y1="18" x2="12.01" y2="18"/>
        </svg>
      `,n.appendChild(l)}let i=document.createElement("h2");i.className="cl-pair-title",i.textContent="Pairing Required",n.appendChild(i);let o=document.createElement("p");o.className="cl-pair-desc",o.textContent="Type the 9-digit pairing code shown on your computer to connect.",n.appendChild(o);let s=document.createElement("div");s.className="cl-pair-grid";let c=[];for(let l=0;l<9;l++){let p=document.createElement("input");p.type="text",p.inputMode="numeric",p.maxLength=1,p.className="cl-pair-digit",p.setAttribute("aria-label",`Digit ${l+1}`),p.addEventListener("input",f=>{let g=p.value.replace(/\D/g,"");p.value=g?g[0]:"",g&&l<8&&c[l+1].focus();let h=c.map(m=>m.value.replace(/\D/g,"")).join("");h.length===9&&e(h)}),p.addEventListener("keydown",f=>{f.key==="Backspace"&&!p.value&&l>0&&c[l-1].focus()}),p.addEventListener("paste",f=>{f.preventDefault();let h=(f.clipboardData?.getData("text")||"").replace(/\D/g,"").slice(0,9);for(let m=0;m<h.length;m++)c[m]&&(c[m].value=h[m]);h.length===9?e(h):h.length>0&&c[h.length]&&c[h.length].focus()}),s.appendChild(p),c.push(p)}n.appendChild(s);let a=document.createElement("p");a.id="cl-pair-err",a.className="cl-pair-err",n.appendChild(a);let d=document.createElement("button");return d.className="cl-pair-reset",d.textContent="Reset connection data",d.onclick=async()=>{await vt(),location.reload()},n.appendChild(d),setTimeout(()=>c[0]?.focus(),100),n}createAddToHomeScreen(e){let n=document.createElement("div");n.id="crosslink-bootstrap-screen",n.className="cl-screen-overlay cl-bootstrap-screen";let r=this.options.onboarding?.icon||this.options.offline?.icon||"./icon-192.png",i=document.createElement("img");i.className="cl-bootstrap-mark",i.src=r,i.alt=this.options.appName||"App",n.appendChild(i);let o=document.createElement("h2");o.className="cl-bootstrap-appname",o.textContent=this.options.onboarding?.appName||this.options.appName||"Crosslink",n.appendChild(o);let s=document.createElement("button");s.className="cl-continue-btn",s.innerHTML="Continue in browser &rarr;",s.onclick=()=>e(),n.appendChild(s);let c=document.createElement("div");return c.className="cl-bootstrap-nudge",c.innerHTML=`
      <span>Add to home screen</span>
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 36 C 20 28, 34 12, 40 8" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M36 4 L 42 8 L 34 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
    `,n.appendChild(c),n}showSasConfirmation(e){return new Promise(n=>{let r=document.createElement("div");r.id="crosslink-sas-modal",r.className="cl-sas-modal";let i=document.createElement("h2");i.textContent="Verify Security Code",r.appendChild(i);let o=document.createElement("p");o.textContent="Confirm the numbers match on your computer:",r.appendChild(o);let s=document.createElement("div");s.className="cl-sas-grid";for(let p of e.sas.replace(/\s/g,"")){let f=document.createElement("span");f.textContent=p,s.appendChild(f)}r.appendChild(s);let c=document.createElement("p");c.className="cl-sas-caps",c.textContent="Capabilities: "+(e.grantedCaps.join(", ")||"(none)"),r.appendChild(c);let a=document.createElement("div");a.className="cl-sas-actions";let d=document.createElement("button");d.className="cl-sas-ok",d.textContent="They match",d.onclick=()=>{r.remove(),n(!0)};let l=document.createElement("button");l.className="cl-sas-no",l.textContent="Cancel",l.onclick=()=>{r.remove(),n(!1)},a.append(d,l),r.appendChild(a),document.body.appendChild(r)})}scheduleReconnect(){if(this.reconnectTimer)return;let n=Math.min(3e4,1e3*Math.pow(1.5,Math.min(this.attemptCount,8)))*(.8+Math.random()*.4);this.reconnectTimer=setTimeout(async()=>{this.reconnectTimer=null,this.attemptCount++,await this.forceReconnect()},n)}async forceReconnect(){let e=this.client.listApps();if(e.length===0){this.transitionTo("pairing-required");return}this.client.close(),await this.attemptSilentAuth(e[0])}cancelTimers(){this.reconnectTimer&&(clearTimeout(this.reconnectTimer),this.reconnectTimer=null),this.reachabilityTimer&&(clearInterval(this.reachabilityTimer),this.reachabilityTimer=null),this.attemptCount=0}setupListeners(){typeof document>"u"||typeof window>"u"||(this.visibilityHandler=()=>{!document.hidden&&this.state==="offline"&&this.forceReconnect().catch(()=>{})},document.addEventListener("visibilitychange",this.visibilityHandler),this.onlineHandler=()=>{this.state==="offline"&&this.forceReconnect().catch(()=>{})},window.addEventListener("online",this.onlineHandler))}getState(){return this.state}getClient(){return this.client}destroy(){this.cancelTimers(),this.unmountCurrentScreen(),typeof document<"u"&&this.visibilityHandler&&document.removeEventListener("visibilitychange",this.visibilityHandler),typeof window<"u"&&this.onlineHandler&&window.removeEventListener("online",this.onlineHandler)}};var Ct={version:"1.0.0",precacheAssets:["./mobile.html","./bundle.js","./manifest.webmanifest","./crosslink-mark.svg","./icon-192.png","./icon-512.png"]};function tn(t={}){let e=t.version||Ct.version,n=t.precacheAssets||Ct.precacheAssets,r=`crosslink-shell-v${e}`,i=JSON.stringify(n,null,2);return`/* Crosslink PWA Service Worker \u2014 Generated by Crosslink Framework */
const CACHE_NAME = "${r}";
const PRECACHE_ASSETS = ${i};

// Endpoints and patterns that must NEVER be cached (security, credentials, active RPC/presence)
const NEVER_CACHE_PATTERNS = [
  "/api/",
  "/rpc/",
  "/ws",
  "/pair",
  "/verify-pair",
  "/challenge",
  "/session",
  "/revoke",
  "/events"
];

function isSecuritySensitive(url) {
  const path = url.pathname;
  return NEVER_CACHE_PATTERNS.some((pattern) => path.includes(pattern));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Robust asset caching: fetch individually so one missing asset doesn't abort entire install
      for (const asset of PRECACHE_ASSETS) {
        try {
          const res = await fetch(asset, { cache: "no-cache" });
          if (res.ok) {
            await cache.put(asset, res);
          }
        } catch (err) {
          console.warn("[Crosslink SW] Precache missed:", asset);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("crosslink-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Ignore cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Never cache auth or API calls
  if (isSecuritySensitive(url)) {
    return;
  }

  // 1. Navigation requests: network-first with offline fallback to cached shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          // Host is offline: return cached shell
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ||
            (await caches.match("./mobile.html", { ignoreSearch: true })) ||
            (await caches.match("/mobile.html", { ignoreSearch: true })) ||
            (await caches.match("/", { ignoreSearch: true }));
          if (cached) return cached;
          return new Response("Application is offline", {
            status: 503,
            statusText: "Offline",
            headers: { "Content-Type": "text/plain" }
          });
        })
    );
    return;
  }

  // 2. Static shell assets: cache-first with network fallback
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});
`}var tr=tn();function nr(t){let e=[t.startUrl||"./mobile.html","./bundle.js",t.manifestPath||"./manifest.webmanifest","./crosslink-mark.svg"];if(t.icons)for(let n of t.icons)n.src&&!e.includes(n.src)&&e.push(n.src);return{version:t.version||"1.0.0",precacheAssets:e}}gt();function da(t={}){let e=t.storage??(typeof localStorage<"u"?new Ge(localStorage):void 0);return new le({...t,storage:e})}function fa(t={}){return le.create(t)}return io(pa);})();
/*! Bundled license information:

@noble/ciphers/esm/utils.js:
  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/utils.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/modular.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/curve.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/edwards.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/montgomery.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
