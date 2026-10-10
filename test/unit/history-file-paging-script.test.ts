import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  static active:Element|undefined;isConnected=true;tag='button';
  children:Element[]=[];textContent='';className='';id='';value='12';disabled=false;scrollTop=0;clientHeight=480;clientWidth=800;
  style:Record<string,string>={};dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,(event:Record<string,unknown>)=>void>();
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(){const disconnect=(node:Element)=>{node.isConnected=false;node.children.forEach(disconnect);};this.children.forEach(disconnect);this.children=[];}
  focus(){Element.active=this;}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  getAttribute(key:string){return this.attributes.get(key);}
  removeAttribute(key:string){this.attributes.delete(key);}
  addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.listeners.set(type,callback);}
}

test('History file pages retain usable keyboard focus and identify working comparisons by literal path',()=>{
  const elements=new Map(['viewport','rows','spacer','details','status','filters','compare','more','pagination','filter-disclosure','filter-summary','snapshot','zoom','workspace','cancel-read'].map(id=>[id,new Element()]));
  const sent:Record<string,unknown>[]=[],createdTags:string[]=[];let receive:((event:{data:unknown})=>void)|undefined,focused=true;
  const body=new Element();body.tag='body';body.dataset.session='s';Element.active=body;
  const allElements=()=>{const nodes:Element[]=[];const visit=(node:Element)=>{nodes.push(node);node.children.forEach(visit);};elements.forEach(visit);return nodes;};
  const document={body,get activeElement(){return Element.active;},hasFocus:()=>focused,getElementById:(id:string)=>elements.get(id),createElement:(tag:string)=>{createdTags.push(tag);const node=new Element();node.tag=tag;return node;},createElementNS:(_ns:string,tag:string)=>{const node=new Element();node.tag=tag;return node;},querySelectorAll:()=>allElements().filter(node=>['button','input','select','textarea'].includes(node.tag))};
  runInNewContext(readFileSync('media/history.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>sent.push(value)})});
  const files=Array.from({length:401},(_,index)=>({status:'M',path:index===400?'src/<img onerror=alert(1)>.ts':`file-${index}.txt`}));
  receive!({data:{type:'comparison',session:'s',result:{from:'a'.repeat(40),to:'b'.repeat(40),files,stats:[],leftCommits:[],leftCount:0,rightCommits:[],rightCount:0}}});
  const details=elements.get('details')!,navigation=details.children.at(-2)!,list=details.children.at(-1)!,previous=navigation.children[0]!,next=navigation.children[1]!;
  const click=(node:Element)=>node.listeners.get('click')!({});
  next.focus();click(next);assert.equal(Element.active,next,'Middle page retains Next');assert.equal(next.disabled,false);assert.equal(list.children.length,200);
  const before=sent.length;click(next);assert.equal(next.disabled,true);assert.equal(Element.active,previous,'Final page falls back to the available Previous button');assert.equal(previous.disabled,false);assert.equal(list.children.length,1);assert.equal(sent.length,before,'Local page movement does not read or mutate Git');
  const working=list.children[0]!.children[1]!;assert.equal(working.textContent,'Compare saved working file');assert.equal(working.getAttribute('aria-label'),'Compare saved working file: src/<img onerror=alert(1)>.ts');assert.equal(createdTags.includes('img'),false);
  click(working);assert.equal(sent.at(-1)?.type,'workingDiff');assert.equal(sent.at(-1)?.index,400);assert.equal(sent.at(-1)?.path,undefined,'Accessible text cannot become action authority');
  click(previous);assert.equal(Element.active,previous);click(previous);assert.equal(previous.disabled,true);assert.equal(Element.active,next,'First page falls back to available Next');
  next.focus();click(next);const moved=elements.get('zoom')!;moved.focus();click(previous);assert.equal(Element.active,moved,'Pagination cannot steal deliberately moved focus');
  click(next);focused=false;previous.focus();click(previous);assert.equal(Element.active,previous,'An inactive document cannot request another focus target');focused=true;
  receive!({data:{type:'busy',session:'s',busy:true}});const caption=navigation.children[2]!.textContent,count=sent.length;click(next);assert.equal(navigation.children[2]!.textContent,caption);assert.equal(sent.length,count);
});
