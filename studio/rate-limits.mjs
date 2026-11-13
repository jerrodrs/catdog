export function rateLimitWait(message,attempt=1,now=Date.now(),baseMs=30000){
  const text=String(message);
  if(!/(?:rate[_ -]?limit|too many requests|\b429\b|usage limit|quota (?:exceeded|exhausted)|limit.*(?:reset|try again)|model is at capacity|server (?:is )?(?:overloaded|at capacity)|temporar(?:y|ily) unavailable|\b503\b)/i.test(text))return null;
  const iso=text.match(/\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))\b/);
  if(iso){const until=Date.parse(iso[1]);if(until>now)return {delay:until-now+2000,reason:'reported reset time'};}
  const relative=text.match(/(?:retry[-_ ]?after["':=\s]*|try again (?:in|after)\s+)(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s\b|minutes?|m\b|hours?|h\b)/i);
  if(relative){const unit=relative[2].toLowerCase(),factor=unit.startsWith('ms')||unit.startsWith('millisecond')?1:unit.startsWith('h')?3600000:unit.startsWith('m')?60000:1000;return {delay:Math.max(baseMs,Number(relative[1])*factor+1000),reason:'reported retry delay'};}
  return {delay:Math.min(30*60000,baseMs*2**Math.min(attempt-1,12)),reason:'exponential backoff'};
}
