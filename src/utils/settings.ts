export function boundedInteger(value:unknown,fallback:number,min:number,max:number):number{
  return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;
}

/** The commit types the composer offers (`feat`, `fix`, …): lower-case words of at most 20 characters, without repeats, at most 30. Anything else in the setting is left out. */
export function conventionalTypes(value:unknown):string[]{
  if(!Array.isArray(value))return [];
  const types=new Set<string>();
  for(const item of value){if(typeof item==='string'&&/^[a-z][a-z0-9-]{0,19}$/.test(item))types.add(item);if(types.size>=30)break;}
  return [...types];
}
