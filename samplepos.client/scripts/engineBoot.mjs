/**
 * Chooses which site script a page engine can run.
 * The decision is the probe result, never a device model.
 *
 * Modern = optional chaining and nullish coalescing (Chrome 80+),
 * which also covers import() and import.meta.
 * Anything that throws while compiling the probe gets the Chrome 62 script.
 */

export const PAGE_ENGINE_PROBE_SOURCE = 'return (0)?.a ?? 1';

export function selectPageEngine(probe) {
  try {
    return probe() === 1 ? 'modern' : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** `?engine=legacy` or `?engine=modern` overrides the probe. Used to test before publish. */
export function decideEngine(search, probe) {
  const q = String(search || '');
  if (q.indexOf('engine=legacy') !== -1) return 'legacy';
  if (q.indexOf('engine=modern') !== -1) return 'modern';
  return selectPageEngine(probe);
}

/** ES5 shims for APIs Chrome 62 does not have. Each installs only when missing. */
export const ENGINE_BOOT_PRELUDE = `(function(){if(typeof globalThis==="undefined"){window.globalThis=window;}if(typeof queueMicrotask!=="function"){window.queueMicrotask=function(fn){Promise.resolve().then(fn);};}if(typeof Promise!=="undefined"&&typeof Promise.prototype.finally!=="function"){Promise.prototype.finally=function(fn){var P=this.constructor;return this.then(function(v){return P.resolve(fn()).then(function(){return v;});},function(e){return P.resolve(fn()).then(function(){throw e;});});};}if(typeof Promise!=="undefined"&&typeof Promise.allSettled!=="function"){Promise.allSettled=function(list){return Promise.all([].map.call(list,function(p){return Promise.resolve(p).then(function(v){return{status:"fulfilled",value:v};},function(e){return{status:"rejected",reason:e};});}));};}if(typeof Object.fromEntries!=="function"){Object.fromEntries=function(entries){var o={};if(!entries)return o;if(typeof entries.forEach==="function"&&typeof entries.next!=="function"){entries.forEach(function(kv){o[kv[0]]=kv[1];});return o;}var iter=entries;if(typeof entries[Symbol.iterator]==="function"){iter=entries[Symbol.iterator]();}var step=typeof iter.next==="function"?iter.next():{done:true};while(step&&!step.done){o[step.value[0]]=step.value[1];step=iter.next();}return o;};}if(!Array.prototype.flat){Array.prototype.flat=function(d){var depth=d===undefined?1:d;var out=[];function walk(a,n){for(var i=0;i<a.length;i++){if(n>0&&Array.isArray(a[i]))walk(a[i],n-1);else out.push(a[i]);}}walk(this,depth);return out;};}if(!Array.prototype.flatMap){Array.prototype.flatMap=function(fn,thisArg){return this.map(fn,thisArg).flat();};}if(!String.prototype.replaceAll){String.prototype.replaceAll=function(search,repl){if(search instanceof RegExp){if(!search.global)throw new TypeError("replaceAll must be global");return this.replace(search,repl);}return this.split(search).join(repl);};}if(typeof Object.hasOwn!=="function"){Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k);};}})();`;

export function engineBootScript({ modernJs, legacyJs, modernCss, legacyCss }) {
  const probe = JSON.stringify(PAGE_ENGINE_PROBE_SOURCE);
  return `${ENGINE_BOOT_PRELUDE}(function(){var engine="legacy";var q=location.search||"";if(q.indexOf("engine=legacy")!==-1){engine="legacy";}else if(q.indexOf("engine=modern")!==-1){engine="modern";}else{try{engine=(new Function(${probe}))()===1?"modern":"legacy";}catch(e){engine="legacy";}}console.info("SMART_ERP_ENGINE "+engine);var css=document.createElement("link");css.rel="stylesheet";css.href=engine==="modern"?${JSON.stringify(modernCss)}:${JSON.stringify(legacyCss)};document.head.appendChild(css);var script=document.createElement("script");script.type="module";script.crossOrigin="anonymous";script.src=engine==="modern"?${JSON.stringify(modernJs)}:${JSON.stringify(legacyJs)};script.onload=function(){console.info("SMART_ERP_MODULE_LOADED "+engine);};script.onerror=function(){console.info("SMART_ERP_MODULE_ERROR "+engine);};document.head.appendChild(script);})();`;
}
