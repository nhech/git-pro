export function boundedInteger(value:unknown,fallback:number,min:number,max:number):number{
  return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.round(value))):fallback;
}
