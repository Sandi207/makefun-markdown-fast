// A two-phase Markdown renderer. Block parsing collects references before inline
// parsing, and each call owns all of its state.
const escapable = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const punctuation = /[\p{P}\p{S}]/u;
const whitespace = /\s/u;
const escapeAll = /[&<>"']/g;
const escapeText = /&(?!(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]*);)|[<>"']/g;
const escapeCharacter = c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
const inlineSpecial = new Uint8Array(128);
for(const c of '\\`*_[\]!<>&~\n ')inlineSpecial[c.charCodeAt(0)]=1;
const emailLocal = new Uint8Array(128);
for(const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-")emailLocal[c.charCodeAt(0)]=1;
function word(c) {return c>=48&&c<=57||c>=65&&c<=90||c>=97&&c<=122||c===95;}
function urlStart(s,i) {
  const c=s.charCodeAt(i)|32;
  if(c===104) {if((s.charCodeAt(i+1)|32)!==116||(s.charCodeAt(i+2)|32)!==116||(s.charCodeAt(i+3)|32)!==112)return false;let j=i+4;if((s.charCodeAt(j)|32)===115)j++;return s[j]===':'&&s[j+1]==='/'&&s[j+2]==='/';}
  if(c===102)return (s.charCodeAt(i+1)|32)===116&&(s.charCodeAt(i+2)|32)===112&&s[i+3]===':'&&s[i+4]==='/'&&s[i+5]==='/';
  if(c===119)return s.startsWith('www.',i);
  return false;
}
const blockTags = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const inlineTag = /^(?:<!--(?:>|->|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[A-Za-z][\w-]*\s*>|<[A-Za-z][\w-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>)/;

function escape(s, all = false) {
  return s.replace(all ? escapeAll : escapeText, escapeCharacter);
}
function numeric(s) {
  return s.replace(/&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (_,d,h) => {
    const n = parseInt(d || h, d ? 10 : 16);
    return n === 0 || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff ? '\ufffd' : String.fromCodePoint(n);
  });
}
function unescape(s) { return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,'$1'); }
function label(s) { return s.trim().replace(/\s+/g,' ').replace(/ẞ/g,'ß').toUpperCase().toLowerCase(); }
function url(s) {
  try { return encodeURI(s).replace(/%25/g,'%'); } catch { return null; }
}
function indent(s) {
  let i=0,n=0;while(i<s.length) {if(s[i]===' ')n++;else if(s[i]==='\t')n+=4-n%4;else break;i++;}return [n,i];
}
function deindent(s,n) {
  let i=0,k=0;while(i<s.length&&k<n) {if(s[i]===' ')k++;else if(s[i]==='\t')k+=4-k%4;else break;i++;}
  return (k>n?' '.repeat(k-n):'')+s.slice(i);
}
function marker(s) {
  let first=0;while(first<4&&s[first]===' ')first++;const c=s.charCodeAt(first);
  if(first>3||c!==42&&c!==43&&c!==45&&(c<48||c>57))return null;
  const m=/^( {0,3})([*+-]|\d{1,9}[.)])([ \t]+|$)(.*)$/.exec(s);
  if(!m)return null;
  let col=m[1].length+m[2].length,pad=0;
  for(const c of m[3]) {const step=c==='\t'?4-(col+pad)%4:1;pad+=step;}
  let text=m[4];
  if(pad>4) {text=' '.repeat(pad-1)+text;pad=1;}
  if(!pad||!text.trim())pad=1;
  return {type:m[2].length>1?'ol':'ul',symbol:m[2].length>1?m[2].slice(-1):m[2],start:m[2].length>1?parseInt(m[2]):1,indent:col+pad,text,raw:m[2],prefix:m[1].length};
}
function hr(s) {let i=0;while(i<4&&s[i]===' ')i++;const c=s[i];return i<4&&(c==='*'||c==='-'||c==='_')&&/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s);}
function fence(s) {
  let i=0;while(i<4&&s[i]===' ')i++;if(i===4||s[i]!=='`'&&s[i]!=='~')return null;
  const m=/^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(s);
  return m && !(m[2][0]==='`'&&m[3].includes('`')) ? {char:m[2][0],len:m[2].length,indent:m[1].length,info:m[3].trim()} : null;
}
function htmlStart(s, paragraph=false) {
  let i=0;while(i<4&&s[i]===' ')i++;if(i===4||s[i]!=='<')return null;
  const t=s.replace(/^ {0,3}/,'');
  let m;
  if((m=/^<(script|pre|style|textarea)(?:\s|>|$)/i.exec(t)))return {end:new RegExp('</'+m[1]+'\\s*>','i'),type:1};
  if(t.startsWith('<!--'))return {end:/-->/,type:2};
  if(t.startsWith('<?'))return {end:/\?>/,type:3};
  if(/^<![A-Z]/.test(t))return {end:/>/,type:4};
  if(t.startsWith('<![CDATA['))return {end:/\]\]>/,type:5};
  if((m=/^<\/?([A-Za-z][\w-]*)(?:\s|\/?\s*>|$)/.exec(t))&&blockTags.has(m[1].toLowerCase()))return {type:6};
  if(!paragraph) {m=inlineTag.exec(t);if(m&&m[0].length===t.trimEnd().length&&/^<\/?[a-z]/i.test(t))return {type:7};}
  return null;
}
function interruption(s,paragraph=true) {
  let i=0;while(i<4&&s[i]===' ')i++;const c=s.charCodeAt(i);
  if(i===4||c!==62&&c!==35&&c!==42&&c!==45&&c!==95&&c!==96&&c!==126&&c!==60&&c!==43&&(c<48||c>57))return !s.trim();
  if(!s.trim())return true;
  if(/^ {0,3}>/.test(s)||/^ {0,3}#{1,6}(?:[ \t]|$)/.test(s)||hr(s)||fence(s)||htmlStart(s,paragraph))return true;
  const m=marker(s);return !!m&&(!paragraph||m.text.trim()&&(m.type==='ul'||m.start===1));
}
function lazyLine(s) {
  while(/^ {0,3}>/.test(s)||marker(s)) {if(/^ {0,3}>/.test(s))s=s.replace(/^ {0,3}> ?/,'');else s=marker(s).text;}
  return !!s.trim()&&indent(s)[0]<4&&!interruption(s,false);
}
function cells(s) {
  s=s.trim();if(s[0]==='|')s=s.slice(1);if(s.endsWith('|')&&!s.endsWith('\\|'))s=s.slice(0,-1);
  const out=[];let start=0;
  for(let i=0;i<s.length;i++)if(s[i]==='|') {let k=i-1;while(k>=0&&s[k]==='\\')k--;if((i-1-k)%2){continue;}out.push(s.slice(start,i).trim().replace(/\\\|/g,'|'));start=i+1;}
  out.push(s.slice(start).trim().replace(/\\\|/g,'|'));return out;
}
function table(s,d) {
  if(!s.includes('|')||d.includes('\t'))return null;
  const heads=cells(s), divs=cells(d);
  if(heads.length!==divs.length||!divs.every(x=>/^:?-+:?$/.test(x)))return null;
  return {heads,align:divs.map(x=>x[0]===':'?(x.endsWith(':')?'center':'left'):x.endsWith(':')?'right':null)};
}
function definition(lines,i,refs) {
  if(!/^ {0,3}\[/.test(lines[i]))return 0;
  const s=lines.slice(i,i+8).join('\n');
  const m=/^ {0,3}\[((?:\\.|[^\[\]\\])+)\]:[ \t]*(?:\n[ \t]*)?(?:<((?:\\.|[^<>\n\\])*)>|((?:\\.|[^\s\\])+))/.exec(s);
  if(!m)return 0;
  let dest=m[2]??m[3],at=m[0].length,title=null;
  if(m[3]) {let level=0;for(let k=0;k<dest.length;k++){if(dest[k]==='\\'){k++;continue;}if(dest[k]==='(')level++;if(dest[k]===')')level--;if(level<0)return 0;}if(level)return 0;}
  const tail=s.slice(at),t=/^[ \t]+(?:\n[ \t]*)?(["'(])|^\n[ \t]*(["'(])/.exec(tail);
  if(t) {const delimiter=t[1]||t[2],close=delimiter==='('?')':delimiter;let j=at+t[0].length,beg=j;
    for(;j<s.length;j++){if(s[j]==='\\'){j++;continue;}if(s[j]===close)break;if(close===')'&&s[j]==='(')break;}
    if(j<s.length&&s[j]===close&&/^[ \t]*(?:\n|$)/.test(s.slice(j+1))){title=s.slice(beg,j);if(delimiter==="'"&&/\n[ \t]*\n/.test(title))return 0;at=j+1;}
  }
  const rest=s.slice(at);if(!/^[ \t]*(?:\n|$)/.test(rest))return 0;
  at+=/^[ \t]*/.exec(rest)[0].length;
  const count=s.slice(0,at).split('\n').length;
  const key=label(m[1]);if(!key)return 0;if(!refs.has(key))refs.set(key,{href:unescape(dest),title:title===null?null:unescape(title)});
  return count;
}

function blocks(lines,refs,top=true,inList=false) {
  const tokens=[];let i=0,gap=false;
  const emit=b=>{b.gap=gap;tokens.push(b);gap=false;};
  while(i<lines.length) {
    let s=lines[i];if(s===undefined||!s.trim()){i++;gap=true;continue;}
    const n=definition(lines,i,refs);if(n){if(gap)emit({t:'space'});i+=n;continue;}
    const f=fence(s);
    if(f) {let j=i+1,content=[];const close=new RegExp('^ {0,3}'+(f.char==='`'?'`':'~')+'{'+f.len+',}[ \\t]*$');
      while(j<lines.length&&!close.test(lines[j])){let line=lines[j];if(f.char==='`'){let k=0;while(k<f.indent&&(line[k]===' '||line[k]==='\t'))k++;line=line.slice(k);}content.push(line);j++;}
      if(j===lines.length&&content.at(-1)==='')content.pop();
      emit({t:'code',text:content.join('\n'),lang:unescape(f.info.split(/\s/)[0])});i=j<lines.length?j+1:j;continue;
    }
    const h=/^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(s);
    if(h){let text=(h[2]||'').trim().replace(/(?:^|[ \t]+)#+[ \t]*$/,'').trim();emit({t:'heading',level:h[1].length,text});i++;continue;}
    if(hr(s)){emit({t:'hr'});i++;continue;}
    const html=htmlStart(s);
    if(html) {let j=i,raw=[];
      if(html.end) {while(j<lines.length){raw.push(lines[j]);if(html.end.test(lines[j++]))break;}}
      else {while(j<lines.length&&lines[j].trim()){raw.push(lines[j++]);}}
      const trailing=j<lines.length&&((html.end?lines[j]!=='':!!lines[j].trim())||j===lines.length-1)?'\n':'';
      emit({t:'html',text:raw.join('\n')+trailing});i=j;continue;
    }
    if(/^ {0,3}>/.test(s)) {
      let j=i,body=[],blank=false,lazy=false,quotedFences=[],lazyGroup=false,groupCode=false;body.literal=new Set();body.breaks=new Set();
      while(j<lines.length) {
        const q=/^( {0,3})>(.*)$/.exec(lines[j]);
        if(q) {let x=q[2],col=q[1].length+1;const lead=/^[ \t]*/.exec(x)[0];let width=0;for(const c of lead)width+=c==='\t'?4-(col+width)%4:1;x=' '.repeat(Math.max(0,width-1))+x.slice(lead.length);if(lazyGroup)body.breaks.add(body.length);body.push(x);blank=!x.trim();
          let depth=0,leaf=x;while(/^ {0,3}>/.test(leaf)){leaf=leaf.replace(/^ {0,3}> ?/,'');depth++;}quotedFences.length=depth+1;
          const active=quotedFences[depth];if(active){if(new RegExp('^ {0,3}'+active.char+'{'+active.len+',}[ \\t]*$').test(leaf))quotedFences[depth]=null;lazy=false;}
          else {quotedFences[depth]=fence(leaf);lazy=!quotedFences.some(Boolean)&&(lazyLine(x)||lazy&&indent(x)[0]>=4);}lazyGroup=false;j++;continue;}
        if(!blank&&lazy&&lines[j].trim()&&!interruption(lines[j],false)){
          if(!lazyGroup){lazyGroup=true;groupCode=indent(lines[j])[0]>=4;}
          if(groupCode&&indent(lines[j])[0]>=4){body.literal.add(body.length);body.push(deindent(lines[j],4));j++;if(j<lines.length&&lines[j].trim()&&indent(lines[j])[0]<4)body[body.length-1]+='\n';}
          else {body.push(/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[j])?'    '+lines[j]:lines[j]);j++;}continue;}break;
      }
      emit({t:'quote',kids:blocks(body,refs,true)});i=j;continue;
    }
    const lm=marker(s);
    if(lm) {
      const items=[];let j=i,loose=false,lastEnded=false;
      while(j<lines.length) {
        const m=marker(lines[j]);if(!m||m.type!==lm.type||m.symbol!==lm.symbol||hr(lines[j]))break;
        let body=[m.text],k=j+1,hadBlank=false,endedBlank=false,itemLazy=lazyLine(m.text);
        while(k<lines.length) {
          const ln=lines[k];
          if(lines.breaks?.has(k))break;
          if(!ln.trim()){if(body.length===1&&!body[0].trim()){k++;endedBlank=true;break;}body.push('');hadBlank=true;endedBlank=true;k++;continue;}
          const [ind]=indent(ln);
          if(ind>=m.indent){const lead=/^[ \t]*/.exec(ln)[0],child=' '.repeat(ind-m.indent)+ln.slice(lead.length);itemLazy=lazyLine(child)||(!endedBlank&&itemLazy&&indent(child)[0]>=4);body.push(child);endedBlank=false;k++;continue;}
          if(marker(ln)||hr(ln))break;
          if(/^ {0,3}`{3,}/.test(ln))break;
          if(!endedBlank&&!interruption(ln)&&itemLazy){body.push(ln);k++;continue;}
          break;
        }
        let trailingBlanks=0;if(endedBlank) {while(body.at(-1)===''){body.pop();trailingBlanks++;}}
        if(body.length)body[body.length-1]=body.at(-1).trimEnd();
        const next=marker(lines[k]||'');
        if(endedBlank&&next&&next.type===lm.type&&next.symbol===lm.symbol)loose=true;
        const lastLine=body.at(-1);
        const siblingBlank=next&&next.type===lm.type&&next.symbol===lm.symbol&&endedBlank&&trailingBlanks===1;
        if(siblingBlank)body.push('');
        let task=null;const taskMatch=/^\[([ xX])\][ \t]+/.exec(body[0]);if(taskMatch)task=taskMatch[1]!==' ';
        const kids=blocks(body,refs,false,true);if(kids.slice(1).some(b=>b.gap))loose=true;
        if(taskMatch&&kids[0]?.t==='paragraph')kids[0].text=kids[0].text.slice(taskMatch[0].length);
        if(siblingBlank&&indent(lastLine||'')[0]>=4&&kids.at(-1)?.folded)kids.at(-1).text+='\n';
        items.push({kids,task});j=k;lastEnded=endedBlank;
      }
      emit({t:'list',ordered:lm.type==='ol',start:lm.start,items,loose});gap=lastEnded;i=j;continue;
    }
    if(indent(s)[0]>=4) {
      let j=i,content=[];
      while(j<lines.length) {if(!lines[j].trim()){content.push(deindent(lines[j],4));j++;continue;}if(indent(lines[j])[0]<4)break;content.push(deindent(lines[j],4));j++;}
      const trailingBlank=!content.at(-1)?.trim();
      while(content.at(-1)==='')content.pop();
      if(!gap&&tokens.at(-1)?.t==='paragraph') {
        const p=tokens.at(-1);p.folded=true;p.text+='\n'+content.join('\n')+(!trailingBlank&&j<lines.length&&lines[j].trim()?'\n':'');
      } else emit({t:'code',text:content.join('\n'),lang:''});
      gap=trailingBlank;
      i=j;continue;
    }
    const tb=i+1<lines.length?table(s,lines[i+1]):null;
    if(tb){let j=i+2,rows=[];while(j<lines.length&&(lines[j].trim()||lines[j].includes('\t'))&&(!lines[j].trim()||indent(lines[j])[0]<4)&&(!lines[j].trim()||!interruption(lines[j]))){rows.push(cells(lines[j]));j++;}emit({t:'table',...tb,rows});i=j;continue;}
    // Setext headings may contain several lines, but stop at other block starts.
    let j=i+1,para=[s],setext=0;
    while(j<lines.length&&lines[j].trim()) {
      if(!lines.literal?.has(j)&&/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[j])){setext=lines[j].trim()[0]==='='?1:2;j++;break;}
      if(!lines.literal?.has(j)&&interruption(lines[j],!inList))break;
      if(j+1<lines.length&&table(lines[j],lines[j+1]))break;
      if(!top&&indent(lines[j])[0]>=4&&!/^ {4}(?:=+|-+)[ \t]*$/.test(lines[j]))break;
      para.push(lines[j]);j++;
    }
    if(j===lines.length-1&&lines[j]&&!lines[j].trim()){para.push(lines[j]);j++;}
    const text=setext?para.join('\n').trim():para.join('\n');
    if(!setext&&!gap&&tokens.at(-1)?.t==='paragraph')tokens.at(-1).text+='\n'+text;
    else emit({t:setext?'heading':'paragraph',level:setext,text});i=j;
  }
  return tokens;
}

// Links and code are opaque to delimiters in their surrounding inline context.
function linkAt(s,start,refs,inLink) {
  const image=s[start]==='!',open=start+(image?1:0);if(s[open]!=='[')return null;
  let level=1,i=open+1,codePairs=0,brokenPair=false;
  for(;i<s.length;i++) {
    if(s[i]==='\\'){i++;continue;}
    if(s[i]==='`'){let j=i+1;while(s[j]==='`')j++;if(codePairs&&s[j]===']'){i=j-1;continue;}let end=s.indexOf('`',j);if(end<0||brokenPair&&s.indexOf(']',j)>=0&&s.indexOf(']',j)<end)return null;let close=end+1;while(s[close]==='`')close++;brokenPair=j-i!==close-end;i=close-1;codePairs++;continue;}
    if(s[i]==='<') {const tag=inlineTag.exec(s.slice(i))||/^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*>/.exec(s.slice(i));if(tag){i+=tag[0].length-1;continue;}}
    if(s[i]==='['){let d=1,j=i+1;for(;j<s.length;j++){if(s[j]==='\\'){j++;continue;}if(s[j]==='[')d++;if(s[j]===']'&&!--d)break;}if(d)return null;i=j;continue;}else if(s[i]===']'&&!--level)break;
  }
  if(level)return null;
  const text=s.slice(open+1,i),endLabel=i+1;
  if(!image&&inLink)return null;
  if(s[endLabel]==='(') {
    let k=endLabel+1;while(/[ \t\n]/.test(s[k]||'\0'))k++;
    let href='',title=null;
    if(s[k]==='<') {let beg=++k;for(;k<s.length&&s[k]!=='>';k++){if(s[k]==='\\'){k++;continue;}if(s[k]==='\n'||s[k]==='<')return null;}if(k>=s.length)return null;href=s.slice(beg,k++);}
    else {const beg=k;let depth=0;for(;k<s.length;k++){const c=s[k];if(c==='\\'){k++;continue;}if(c==='(')depth++;else if(c===')'){if(depth===0)break;depth--;}if(/[ \t\n]/.test(c)&&depth===0)break;}if(depth)return null;href=s.slice(beg,k);}
    const before=k;while(/[ \t\n]/.test(s[k]||'\0'))k++;
    if(k>before&&/['"(]/.test(s[k]||'\0')) {const close=s[k]==='('?')':s[k];const beg=++k;for(;k<s.length&&s[k]!==close;k++)if(s[k]==='\\')k++;if(k>=s.length)return null;title=s.slice(beg,k++);while(/[ \t\n]/.test(s[k]||'\0'))k++;}
    if(s[k]!==')'){const fallback=refs.get(label(text));return fallback?{image,text,...fallback,end:endLabel}:null;}
    return {image,text,href:unescape(href),title:title===null?null:unescape(title),end:k+1};
  }
  let key=text,end=endLabel;
  if(s[end]==='[') {const m=/^\[((?:\\.|[^\[\]\\])*)\]/.exec(s.slice(end));if(m){key=m[1]||text;end+=m[0].length;}}
  const def=refs.get(label(key));return def?{image,text,...def,end,reference:true}:null;
}
function extended(s,i,defer=false) {
  const tail=s.slice(i);let m;
  if((m=/^(?:(?:https?|ftp):\/\/|www\.)[^\s<>]+/i.exec(tail))&&(!/^www\./i.test(m[0])||m[0].startsWith('www.'))) {
    let text=m[0],opens=[];
    for(let k=0;k<text.length;k++){if(text[k]==='(')opens.push(k);else if(text[k]===')'&&opens.length)opens.pop();}
    if(opens.length)text=text.slice(0,opens[0]);
    let changed=true;
    while(changed){const before=text;text=text.replace(/[?!.,:;*_~]+$/,'');
      if(text.endsWith(')')) {let balance=0,lastPair=-1;for(let k=0;k<text.length;k++){if(text[k]==='(')balance++;else if(text[k]===')'){if(balance>0){balance--;lastPair=k;}}}if(lastPair!==text.length-1)text=text.slice(0,-1);}
      changed=before!==text;
    }
    const entity=/&(?:[A-Za-z0-9]+|#[0-9]+|#[xX][0-9a-fA-F]+);$/.exec(m[0]);
    if(entity)text=m[0].slice(0,entity.index);
    const host=/^(?:https?:\/\/|ftp:\/\/|www\.)([^/?:#]+)/i.exec(text)?.[1];
    if(!host||!/[A-Za-z0-9]/.test(host))return null;
    return {text,href:/^www\./i.test(text)?'http://'+text:text,end:i+text.length};
  }
  if((m=/^(?:(mailto:|xmpp:))?[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]+(?:\/[A-Za-z0-9@._-]+)?/.exec(tail))) {
    let value=m[0];if(m[1]!=='xmpp:')value=value.split('/')[0];
    if(/[-_]/.test(s[i+value.length]||'\0')) {
      if(defer&&s[i+value.length]==='_')return {text:value,href:m[1]?value:'mailto:'+value,end:i+value.length,blocked:true};
      const at=value.lastIndexOf('.');if(at>value.indexOf('@')&&value.slice(value.indexOf('@')+1,at).includes('.'))value=value.slice(0,at);else return null;
    }
    return {text:value,href:m[1]?value:'mailto:'+value,end:i+value.length};
  }
  return null;
}
function isP(c) {return !!c&&punctuation.test(c);}
function isW(c) {return !c||whitespace.test(c);}
function nestedLink(s,refs) {
  for(let i=0;i<s.length;i++) {
    if(s[i]==='\\'){i++;continue;}
    if(s[i]==='`'){let j=i+1;while(s[j]==='`')j++;const run=s.slice(i,j);let end=s.indexOf(run,j);while(end>=0&&(s[end-1]==='`'||s[end+run.length]==='`'))end=s.indexOf(run,end+run.length);if(end>=0)i=end+run.length-1;else i=j-1;continue;}
    if(s[i]==='!'&&s[i+1]==='['){const l=linkAt(s,i,refs,false);if(l){i=l.end-1;continue;}}
    if(s[i]==='['){const l=linkAt(s,i,refs,false);if(l&&url(l.href)!==null)return true;}
  }
  return false;
}
function inlineMasks(s,refs) {
  const spans=[],referenceSpans=[];
  if(refs.size)for(let i=0;i<s.length;i++)if(s[i]==='[') {
    const l=linkAt(s,i,refs,false);
    if(l?.reference&&!l.text.includes('[')){referenceSpans.push([i,l.end]);i=l.end-1;}
  }
  const hidden=at=>{for(const span of referenceSpans){if(span[0]>at)break;if(span[1]>at)return true;}return false;};
  for(let i=0;i<s.length;i++) {
    if(hidden(i))continue;
    if(s[i]==='\\'){i++;continue;}
    if(s[i]==='`'){let j=i+1;while(s[j]==='`')j++;const run=s.slice(i,j);let end=s.indexOf(run,j);while(end>=0&&(hidden(end)||s[end-1]==='`'||s[end+run.length]==='`'))end=s.indexOf(run,end+run.length);if(end>=0){spans.push([i,end+run.length]);i=end+run.length-1;}else i=j-1;continue;}
  }
  const codeSpans=spans.slice();
  for(let i=0;i<s.length;i++) {
    if(s[i]==='\\'){i++;continue;}
    if(s[i]==='['&&!hidden(i)&&!codeSpans.some(span=>span[0]<=i&&span[1]>i)) {
      let depth=1,j=i+1;for(;j<s.length;j++){if(s[j]==='\\'){j++;continue;}if(s[j]==='[')depth++;if(s[j]===']'&&!--depth)break;}
      if(s[j+1]==='('&&!s.slice(i+1,j).includes('[')){let k=j+2,n=1;for(;k<s.length;k++){if(s[k]==='\\'){k++;continue;}if(s[k]==='(')n++;if(s[k]===')'&&!--n)break;}if(!n){spans.push([i,k+1]);i=k;}}
    }
  }
  spans.push(...referenceSpans);
  spans.sort((a,b)=>a[0]-b[0]);return spans;
}

function inline(s,refs,inLink=false,plain=false) {
  if(!/[\\`*_[\]!<>&~\n]|https?:|ftp:|www\.|@| {2,}$/i.test(s))return escape(s);
  const nodes=[],delims=[];let masks=s.includes('``')?inlineMasks(s,refs):[],i=0,rawMode=false,maskIndex=0;
  const hasEmail=s.includes('@'),hasURL=/(?:https?|ftp):|www\./i.test(s);
  const text=(value)=>{if(value){const last=nodes[nodes.length-1];if(last?.simple)last.v+=value;else nodes.push({v:value,before:'',after:'',simple:true,deferred:null});}};
  while(i<s.length) {
    const c=s[i];
    if(c==='\\'&&i+1<s.length) {if(s[i+1]==='\n'){text(plain?'\n':'<br>');i+=2;while(s[i]===' '||s[i]==='\t')i++;continue;}if(escapable.test(s[i+1])){text(escape(s[i+1],true));i+=2;continue;}}
    if(c==='`') {let j=i+1;while(s[j]==='`')j++;const run=s.slice(i,j);let end=s.indexOf(run,j);
      while(end>=0&&(s[end-1]==='`'||s[end+run.length]==='`'))end=s.indexOf(run,end+run.length);
      if(end>=0) {let value=s.slice(j,end).replace(/\n/g,' ');if(value[0]===' '&&value.endsWith(' ')&&value.trim())value=value.slice(1,-1);text(plain?escape(value,true):'<code>'+escape(value,true)+'</code>');i=end+run.length;continue;}
      text(run);i=j;continue;
    }
    if(c==='['||c==='!'&&s[i+1]==='[') {
      const l=linkAt(s,i,refs,inLink);if(!l&&!masks.length){const end=s.indexOf(']',i+1);if(end>=0&&s[end+1]==='('&&!s.slice(i+1,end).includes('['))masks=inlineMasks(s,refs);}if(l) {
        l.text=l.text.replace(/\\([\[\]])/g,'$1');
        if(!l.image&&l.text.includes('[')&&nestedLink(l.text,refs)){text(escape(c));i++;continue;}
        const dest=url(l.href);if(dest!==null) {
          const title=l.title===null?'':' title="'+escape(l.title)+'"';
          if(l.image)text(plain?inline(l.text,refs,inLink,true):'<img src="'+escape(dest)+'" alt="'+inline(l.text,refs,inLink,true)+'"'+title+'>');
          else {const rawLink=refs.inLink;text(plain?inline(l.text,refs,true,true):'<a href="'+escape(dest)+'"'+title+'>'+inline(l.text,refs,true,false)+'</a>');refs.inLink=rawLink;}
          i=l.end;continue;
        }
      }
    }
    if(c==='<') {
      const a=/^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/.exec(s.slice(i));
      const e=!a?/^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)>/.exec(s.slice(i)):null;
      if(a||e) {const value=(a||e)[1];text(plain?escape(value):'<a href="'+escape(url((e?'mailto:':'')+value))+'">'+escape(value)+'</a>');i+=(a||e)[0].length;continue;}
      const h=inlineTag.exec(s.slice(i));if(h) {text(plain?escape(h[0]):h[0]);if(/^<a\s/i.test(h[0]))refs.inLink=true;if(/^<\/a\s*>/i.test(h[0]))refs.inLink=false;if(/^<(?:pre|code|kbd|script)(?:\s|>)/i.test(h[0]))rawMode=true;if(/^<\/(?:pre|code|kbd|script)\s*>/i.test(h[0]))rawMode=false;i+=h[0].length;continue;}
    }
    if(c==='*'||c==='_'||c==='~') {
      let j=i+1;while(s[j]===c)j++;const len=j-i;
      while(maskIndex<masks.length&&masks[maskIndex][1]<=i)maskIndex++;
      if(maskIndex<masks.length&&masks[maskIndex][0]<=i){text(s.slice(i,j));i=j;continue;}
      if(c==='~'&&len>2){text(s.slice(i,j));i=j;continue;}
      const prev=i?s[i-1]:'',next=s[j]||'';
      const left=!isW(next)&&(!isP(next)||isW(prev)||isP(prev));
      const right=!isW(prev)&&(!isP(prev)||isW(next)||isP(next));
      const open=c==='_'?left&&(!right||isP(prev)):left;
      const close=c==='_'?right&&(!left||isP(next)):right;
      const node={v:s.slice(i,j),before:'',after:'',simple:false,deferred:null};nodes.push(node);
      delims.push({c,len,original:len,open,close,oddBoth:open||c==='*'&&next==='~',node,idx:nodes.length-1,active:true});i=j;continue;
    }
    if((hasEmail||hasURL)&&!inLink&&!refs.inLink&&!rawMode) {
      let candidate=hasURL&&urlStart(s,i);
      if(!candidate&&hasEmail&&(i===0||!word(s.charCodeAt(i-1)))&&emailLocal[s.charCodeAt(i)]){let k=i+1;while(k<s.length&&emailLocal[s.charCodeAt(k)])k++;candidate=s[k]==='@'||s.startsWith('mailto:',i)||s.startsWith('xmpp:',i);}
      if(candidate){const a=extended(s,i,true);if(a){if(a.blocked)nodes.push({v:escape(a.text),before:'',after:'',simple:false,deferred:a});else text(plain?escape(a.text):'<a href="'+escape(url(a.href))+'">'+escape(a.text)+'</a>');i=a.end;continue;}}
    }
    if(c==='&') {const m=/^&#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6});/.exec(s.slice(i));if(m){text(escape(numeric(m[0]),true));i+=m[0].length;continue;}const entity=/^&[a-zA-Z][a-zA-Z0-9]*;/.exec(s.slice(i));if(entity){text(entity[0]);i+=entity[0].length;continue;}}
    if(c==='\n') {text('\n');i++;continue;}
    if(c===' ') {let j=i+1;while(s[j]===' ')j++;if(s[j]==='\n'&&j-i>=2){text(!plain?'<br>':'\n');i=j+1;while(s[i]===' '||s[i]==='\t')i++;continue;}text(s.slice(i,j));i=j;continue;}
    let j=i+1;
    // Keep possible URL/email starts visible while taking ordinary words in one scan.
    while(j<s.length&&!inlineSpecial[s.charCodeAt(j)]) {if(!inLink&&!rawMode&&(hasEmail&&!word(s.charCodeAt(j-1))&&word(s.charCodeAt(j))||hasURL&&urlStart(s,j)))break;j++;}
    const piece=s.slice(i,j);
    text(rawMode&&!plain?piece:escape(piece));i=j;
  }
  function findClose(oi,hi,skip=true) {
    const o=delims[oi];let total=o.len,mid=0,lastClose=-1;
    for(let ci=oi+1;ci<=hi;ci++) {
      const d=delims[ci];if(!d.len)continue;
      if(d.c!==o.c){if(skip&&d.open&&d.c!=='~'&&d.len>=2){const nested=findClose(ci,hi,false);if(nested.ci>=0)ci=nested.ci;}continue;}
      if(o.c==='~'&&d.len!==o.len)continue;
      if(d.open&&!d.close){total+=d.len;continue;}
      if(!d.close)continue;
      if(o.c!=='~'&&d.oddBoth&&o.len%3&&(o.len+d.len)%3===0){mid+=d.len;continue;}
      total-=d.len;if(!d.oddBoth)lastClose=ci;
      if(total<=0)return {ci,total,mid,lastClose};
    }
    return {ci:-1,total,mid,lastClose};
  }
  function pairRange(lo,hi) {
    for(let oi=lo;oi<=hi;oi++) {
      const opener=delims[oi];if(!opener.open||!opener.len)continue;
      const {ci,total,mid,lastClose}=findClose(oi,hi);
      if(ci<0) {
        // A terminal closing run can consume the tail of an otherwise unmatched
        // opening run. An intraword run cannot perform this fallback.
        if(opener.c!=='~'&&!mid&&lastClose>=0&&total>0&&total<opener.len) {
          const literal=total;opener.node.v=opener.c.repeat(literal);opener.len-=literal;
          const saved=opener.node.v;opener.node.v+=opener.c.repeat(opener.len);
          pairRange(oi,hi);opener.node.v=saved+opener.node.v;return;
        }
        continue;
      }
      const closer=delims[ci];
      const available=opener.c==='~'?closer.len:Math.min(closer.len,closer.len+total+mid);
      const use=opener.c==='~'?opener.len:Math.min(opener.len,available)%2?1:2;
      if(use<=0)continue;
      const tag=opener.c==='~'?'del':use===2?'strong':'em';
      opener.len-=use;closer.len-=use;
      opener.node.v=opener.c.repeat(opener.len);closer.node.v=closer.c.repeat(closer.len);
      if(!plain){opener.node.after+='<'+tag+'>';closer.node.before='</'+tag+'>'+closer.node.before;}
      const outside=closer.len-(available-use);closer.len=available-use;
      pairRange(oi,ci);
      if(closer.len)closer.node.before=closer.c.repeat(closer.len)+closer.node.before;
      closer.len=outside;closer.node.v=closer.c.repeat(outside);
      oi=ci;
    }
  }
  pairRange(0,delims.length-1);
  const out=[];for(let j=0;j<nodes.length;j++){const n=nodes[j];if(n.deferred&&nodes[j+1]?.before&&nodes[j+1].v===''){const a=n.deferred;n.v=plain?escape(a.text):'<a href="'+escape(url(a.href))+'">'+escape(a.text)+'</a>';}out.push((n.before||'')+n.v+(n.after||''));}return out.join('');
}
function render(tokens,refs,tight=false) {
  const out=[];
  for(const b of tokens) {
    const type=b.t;
    if(type==='paragraph')out.push(tight?inline(b.text,refs):'<p>'+inline(b.text,refs)+'</p>\n');
    else if(type==='heading')out.push('<h'+b.level+'>'+inline(b.text,refs)+'</h'+b.level+'>\n');
    else if(type==='hr')out.push('<hr>\n');
    else if(type==='html')out.push(b.text);
    else if(type==='code')out.push('<pre><code'+(b.lang?' class="language-'+escape(b.lang)+'"':'')+'>'+escape(b.text,true)+(b.text&&!b.text.endsWith('\n')?'\n':'')+'</code></pre>\n');
    else if(type==='quote')out.push('<blockquote>\n'+render(b.kids,refs)+'</blockquote>\n');
    else if(type==='list') {
      const tag=b.ordered?'ol':'ul';out.push('<'+tag+(b.ordered&&b.start!==1?' start="'+b.start+'"':'')+'>\n');
      for(const item of b.items) {
        let body=render(item.kids,refs,!b.loose);
        if(item.task!==null) {const check='<input '+(item.task?'checked="" ':'')+'disabled="" type="checkbox"> ';
          body=b.loose&&body.startsWith('<p>')?'<p>'+check+body.slice(3):check+body;
        }
        out.push('<li>'+body+'</li>\n');
      }
      out.push('</'+tag+'>\n');
    } else if(type==='table') {
      out.push('<table>\n<thead>\n<tr>\n');
      for(let j=0;j<b.heads.length;j++)out.push('<th'+(b.align[j]?' align="'+b.align[j]+'"':'')+'>'+inline(b.heads[j],refs)+'</th>\n');
      out.push('</tr>\n</thead>\n');
      if(b.rows.length) {out.push('<tbody>');for(const row of b.rows){out.push('<tr>\n');for(let j=0;j<b.heads.length;j++)out.push('<td'+(b.align[j]?' align="'+b.align[j]+'"':'')+'>'+inline(row[j]||'',refs)+'</td>\n');out.push('</tr>\n');}out.push('</tbody>');}
      out.push('</table>\n');
    }
  }
  return out.join('');
}
export function parse(markdown) {
  const refs=new Map();
  refs.inLink=false;
  const source=markdown.replace(/\r\n?/g,'\n');
  return render(blocks(source.split('\n'),refs),refs);
}
