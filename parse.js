// A document-local Markdown reader. Block structure is collected before references
// are resolved; inline source is scanned by offset and emitted into string buffers.
const RX = {
  blank: /^[ \t]*$/,
  rule: /^ {0,3}(?:\*(?:[ \t]*\*){2,}|-(?:[ \t]*-){2,}|_(?:[ \t]*_){2,})[ \t]*$/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/,
  fence: /^ {0,3}(`{3,}|~{3,})(.*)$/,
  list: /^( {0,3})([*+-]|[0-9]{1,9}[.)])(?:([ \t]+)(.*)|$)/,
  quote: /^ {0,3}>/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  punctuation: /[\p{P}\p{S}]/u,
  escape: /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/,
  escaped: /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,
  escapeHTML: /&(?![a-zA-Z0-9_]+;|#\d{1,7};|#[xX][a-fA-F0-9]{1,6};)|[<>"']/g,
  escapeAll: /[&<>"']/g,
  auto: /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)>/y,
  numeric: /&#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6});/y,
  entity: /&[a-zA-Z0-9_]+;/y,
  web: /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>]+/iy,
  mail: /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9_-]*\.)+[a-zA-Z0-9_-]+/y,
  mailScheme: /(mailto:|xmpp:)([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9_-]*\.)+[a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9@.]+))?/iy,
};
const attribute = '[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?';
const element = '</[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+' + attribute + ')*\\s*/?>';
RX.tag = new RegExp('(?:<!--(?:>|->|[\\s\\S]*?-->)|<\\?[\\s\\S]*?\\?>|<![A-Z][\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|' + element + ')', 'y');
RX.wholeTag = new RegExp('^(?:' + element + ')[ \\t]*$');
const blockTags = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
const entities = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};
const html = (s, all = false) => /[&<>"']/.test(s) ? s.replace(all ? RX.escapeAll : RX.escapeHTML, c => entities[c]) : s;
const unquote = s => s.replace(RX.escaped, '$1');
const refName = s => s.toUpperCase().toLowerCase().replace(/ß/g,'ss').replace(/\s+/g,' ').trim();
function address(s) { try { return html(encodeURI(s).replace(/%25/g,'%')); } catch { return null; } }
function at(rx, s, pos) { rx.lastIndex = pos; return rx.exec(s); }
function blank(s) { return !s || RX.blank.test(s); }
function columns(s, initial = 0) {
  let i = 0, col = initial;
  while (i < s.length) { if (s.charCodeAt(i) === 32) col++; else if (s.charCodeAt(i) === 9) col += 4 - col % 4; else break; i++; }
  return [i, col];
}
function indentation(s,initial=0) {
  let col=initial;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===32)col++;else if(c===9)col+=4-col%4;else break;}
  return col;
}
function dedent(s, n) {
  let i = 0, col = 0;
  while (i < s.length && col < n) { const c = s.charCodeAt(i); if (c === 32) col++; else if (c === 9) col += 4 - col % 4; else break; i++; }
  return (col > n ? ' '.repeat(col-n) : '') + s.slice(i);
}
function listDedent(s,n) {
  let i=0,col=0,tab=false;
  while(i<s.length){const c=s.charCodeAt(i);if(c===32)col++;else if(c===9){col+=4-col%4;tab=true;}else break;i++;}
  return tab?' '.repeat(Math.max(0,col-n))+s.slice(i):s.slice(n);
}
function listMarker(s) {
  const c=s.charCodeAt(0);if(c!==32&&c!==42&&c!==43&&c!==45&&(c<48||c>57))return null;
  const m = RX.list.exec(s); if (!m) return null;
  const ordered = m[2].length > 1, prefix = m[1].length + m[2].length;
  const width = indentation(m[3] || '', prefix) - prefix;
  const text = (width > 4 ? ' '.repeat(width-1) : '') + (m[4] || '');
  const empty = blank(text);
  return {ordered, symbol: ordered ? m[2].at(-1) : m[2], number: ordered ? parseInt(m[2],10) : 1,
    base:m[1].length, indent:prefix + (empty || width > 4 || !width ? 1 : width), text, empty};
}
function htmlBlock(s, interrupt) {
  let i=0; while(i<3 && s[i]===' ') i++;
  if(s[i]!=='<') return null;
  const t=s.slice(i), raw=/^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(t);
  if(raw) return new RegExp('</'+raw[1]+'\\s*>','i');
  if(t.startsWith('<!--')) return /-->/;
  if(t.startsWith('<?')) return /\?>/;
  if(t.startsWith('<![CDATA[')) return /\]\]>/;
  if(/^<![A-Z]/.test(t)) return />/;
  const m=/^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[\s/>]|$)/.exec(t);
  return m && blockTags.has(m[1].toLowerCase()) || !interrupt && RX.wholeTag.test(t) ? true : null;
}
function validFence(s) { const c=s.charCodeAt(0);if(c!==32&&c!==96&&c!==126)return null;const m=RX.fence.exec(s); return m && !(m[1][0]==='`' && m[2].includes('`')) ? m : null; }
function breaksBlock(s, paragraph=true) {
  if(blank(s)) return true;
  let i=0;while(s[i]===' '&&i<4)i++;
  const c=s[i];
  if(c==='>'&&i<4 || c==='#'&&RX.heading.test(s) || (c==='*'||c==='-'||c==='_')&&RX.rule.test(s))return true;
  if((c==='`'||c==='~')&&validFence(s))return true;
  if(c==='*'||c==='+'||c==='-'||c>='0'&&c<='9') { const m=listMarker(s); if(m&&(!paragraph||!m.empty&&(!m.ordered||m.number===1)))return true; }
  return c==='<'&&!!htmlBlock(s,true);
}
function peel(s) {
  let depth=0;
  for(let n=0;n<30;n++) {
    const m=RX.quote.exec(s); if(m){s=s.slice(m[0].length);if(s[0]===' ')s=s.slice(1);depth++;continue;}
    const l=listMarker(s);if(l){s=l.text;continue;}break;
  }
  return {text:s, depth};
}
function lazy(s) {
  for(let n=0;n<30;n++) {
    if(blank(s)||indentation(s)>=4)return false;
    const q=RX.quote.exec(s);if(q){s=s.slice(q[0].length);if(s[0]===' ')s=s.slice(1);continue;}
    const m=listMarker(s);if(m){s=m.text;continue;}return !breaksBlock(s,false);
  }return false;
}
function splitCells(s) {
  s=s.trim();let start=s[0]==='|'?1:0, end=s.length;
  if(s[end-1]==='|'&&s[end-2]!=='\\')end--;
  const out=[];let pieces=[],from=start;
  for(let i=start;i<end;i++) {
    if(s[i]==='\\'&&s[i+1]==='|'){pieces.push(s.slice(from,i),'|');i++;from=i+1;}
    else if(s[i]==='|'){pieces.push(s.slice(from,i));out.push(pieces.join('').trim());pieces=[];from=i+1;}
  }
  pieces.push(s.slice(from,end));out.push(pieces.join('').trim());return out;
}
function tableHeader(a,b) {
  if(!a||!b||!a.includes('|'))return null;
  const alignment=splitCells(b);if(!alignment.every(x=>/^:?-+:?$/.test(x)))return null;
  const header=splitCells(a);if(header.length!==alignment.length)return null;
  return {header, alignment:alignment.map(x=>x[0]===':' ? x.at(-1)===':'?'center':'left' : x.at(-1)===':'?'right':'')};
}
function readDefinition(lines, i) {
  if(!/^ {0,3}\[/.test(lines[i]))return null;
  const first=lines[i];let close=-1;
  for(let p=first.indexOf('[')+1;p<first.length;p++){if(first[p]==='\\'){p++;continue;}if(first[p]===']'){close=p;break;}}
  if(close>=0&&first[close+1]!==':')return null;
  const s=lines.slice(i,i+30).join('\n');
  const m=/^ {0,3}\[((?:\\.|[^\[\]\\])+?)\]:[ \t]*(?:\n[ \t]*)?/.exec(s);
  if(!m||!refName(m[1]))return null;
  let p=m[0].length, href;
  if(s[p]==='<') {const start=++p;while(p<s.length&&s[p]!=='>'&&s[p]!=='\n'){if(s[p]==='\\')p++;p++;}if(s[p]!=='>')return null;href=s.slice(start,p++);}
  else {const start=p;while(p<s.length&&!/\s/.test(s[p]))p++;if(p===start)return null;href=s.slice(start,p);}
  let lineEnd=s.indexOf('\n',p);if(lineEnd<0)lineEnd=s.length;
  let q=p;while(s[q]===' '||s[q]==='\t')q++;
  let finish=q,title=null;
  if(s[q]==='\n'){q++;while(s[q]===' '||s[q]==='\t')q++;}
  const opener=s[q],closer=opener==='('?')':opener;
  if(q>p&&(opener==='"'||opener==="'"||opener==='(')){
    let j=q+1;while(j<s.length&&s[j]!==closer){if(s[j]==='\\')j++;j++;}
    if(j<s.length&&!/\n[ \t]*\n/.test(s.slice(q,j))){let tail=j+1;while(s[tail]===' '||s[tail]==='\t')tail++;if(tail===s.length||s[tail]==='\n'){title=unquote(s.slice(q+1,j));finish=tail;}else if(q<=lineEnd)return null;}
    else if(q<=lineEnd)return null;
  }else if(q<lineEnd)return null;
  if(title===null){if(!RX.blank.test(s.slice(p,lineEnd)))return null;finish=lineEnd;}
  let count=1;for(let j=0;j<finish;j++)if(s[j]==='\n')count++;
  return {count, name:refName(m[1]), href:unquote(href), title};
}

class Document {
  constructor() {this.refs=new Map();this.htmlLink=false;}
  collect(source, top=true, quoted=false, forced=null) {
    if(!source)return [];
    const terminated=source.at(-1)==='\n', lines=source.split('\n');if(terminated)lines.pop();
    const out=[];let i=0,paragraphMode=top;
    while(i<lines.length) {
      const s=lines[i];
      if(blank(s)){let j=i+1;while(j<lines.length&&blank(lines[j]))j++;out.push({kind:'gap'});i=j;continue;}
      const f=validFence(s);
      if(f){
        let j=i+1;const closing=new RegExp('^ {0,3}'+f[1][0]+'{'+f[1].length+',}[ \\t]*$');
        while(j<lines.length&&!closing.test(lines[j]))j++;
        const indent=f[1][0]==='~'?0:columns(s)[0], parts=[];
        for(let k=i+1;k<j;k++){let v=lines[k];if(indent){let p=0;while(p<indent&&(v[p]===' '||v[p]==='\t'))p++;v=v.slice(p);}parts.push(v);}
        const body=parts.join('\n');out.push({kind:'code',text:body.replace(/\n$/,''),newline:body.length>0,language:unquote(f[2].trim().split(/\s+/)[0]||'')});i=j<lines.length?j+1:j;continue;
      }
      const h=RX.heading.exec(s);
      if(h){out.push({kind:'heading',level:h[1].length,text:(h[2]||'').trim().replace(/(?:^#+$|[ \t]+#+[ \t]*$)/,'').trim()});i++;continue;}
      if(RX.rule.test(s)){out.push({kind:'rule'});i++;continue;}
      if(RX.quote.test(s)){
        const body=[],forcedLines=new Set();forcedLines.resumes=new Set();let j=i, allow=false, fenceState=null,htmlState=null,lazyDedented=false;
        while(j<lines.length){
          const q=RX.quote.exec(lines[j]);
          if(q){
            const tail=lines[j].slice(q[0].length), padding=columns(tail,q[0].length);
            const t=' '.repeat(Math.max(0,padding[1]-q[0].length-1))+tail.slice(padding[0]);
            if(lazyDedented&&!blank(t)){forcedLines.add(body.length);body.push('');}
            if(forcedLines.has(body.length-1))forcedLines.resumes.add(body.length);lazyDedented=false;body.push(t);
            const leaf=peel(t), ff=validFence(leaf.text);
            if(fenceState&&leaf.depth<fenceState.depth)fenceState=null;
            if(fenceState){if(fenceState.closing.test(leaf.text))fenceState=null;allow=false;}
            else if(ff){fenceState={depth:leaf.depth,closing:new RegExp('^ {0,3}'+ff[1][0]+'{'+ff[1].length+',}[ \\t]*$')};allow=false;}
            else {
              if(htmlState===true&&blank(leaf.text))htmlState=null;
              if(!htmlState)htmlState=htmlBlock(leaf.text,false);
              if(htmlState){allow=false;if(htmlState!==true&&htmlState.test(leaf.text))htmlState=null;}
              else allow=lazy(t);
            }
            j++;
          }else if(!blank(lines[j])&&allow&&!breaksBlock(lines[j],false)){
            const dedented=indentation(lines[j])>=4&&(lazyDedented||!forcedLines.has(body.length-1));
            if(lazyDedented&&!dedented){forcedLines.add(body.length);body.push('');}
            forcedLines.add(body.length);body.push(RX.setext.test(lines[j])?'    '+lines[j].trim():dedented?dedent(lines[j],4):lines[j]);lazyDedented=dedented;j++;
          }else break;
        }
        const suffix=j<lines.length&&blank(lines[j])?'\n\n':j<lines.length||terminated?'\n':'';
        out.push({kind:'quote',children:this.collect(body.join('\n')+suffix,true,true,forcedLines)});i=j;continue;
      }
      const m=listMarker(s);
      if(m){const result=this.collectList(lines,i,m,forced?.resumes);out.push(result.token);paragraphMode=true;i=result.end;continue;}
      if(indentation(s)>=4){
        let j=i+1;while(j<lines.length&&(blank(lines[j])||indentation(lines[j])>=4))j++;
        const body=lines.slice(i,j).map(x=>dedent(x,4)).join('\n').replace(/\n+$/,'');
        const prev=out.at(-1);
        if(prev?.kind==='text'){prev.text+='\n'+body;prev.folded=true;prev.foldedNewline=j<lines.length&&!blank(lines[j-1]);while(j>i&&blank(lines[j-1]))j--;}
        else out.push({kind:'code',text:body,language:''});
        i=j;continue;
      }
      const hb=htmlBlock(s,false);
      if(hb){let j=i;if(hb===true)while(j<lines.length&&!blank(lines[j]))j++;else do{j++;}while(j<lines.length&&!hb.test(lines[j-1]));
        let text=lines.slice(i,j).join('\n')+(j<lines.length||terminated?'\n':'');
        if(j<lines.length&&(hb===true||lines[j]==='')||quoted&&j===lines.length)text=text.replace(/\n+$/,'');out.push({kind:'html',text});i=j;continue;
      }
      const d=readDefinition(lines,i);if(d){if(!this.refs.has(d.name))this.refs.set(d.name,d);i+=d.count;continue;}
      const table=tableHeader(s,lines[i+1]);
      if(table){let j=i+2;const rows=[];while(j<lines.length&&!/^ *$/.test(lines[j])&&(blank(lines[j])||!breaksBlock(lines[j])&&indentation(lines[j])<4))rows.push(splitCells(lines[j++]));out.push({kind:'table',...table,rows});i=j;continue;}
      let j=i+1,level=0;
      while(j<lines.length&&(!blank(lines[j])||(quoted||paragraphMode&&!top)&&lines[j]!==''||forced?.has(j))){
        if(!paragraphMode&&indentation(lines[j])>=4)break;
        if(!forced?.has(j)){
          if(RX.setext.test(lines[j])){level=lines[j].trim()[0]==='='?1:2;break;}
          if(!blank(lines[j])&&breaksBlock(lines[j],paragraphMode)||tableHeader(lines[j],lines[j+1]))break;
        }j++;
      }
      const text=lines.slice(i,j).join('\n');
      if(level){out.push({kind:'heading',level,text:text.trim()});i=j+1;}
      else {const prev=out.at(-1);if(!top&&prev?.kind==='text'&&prev.folded){prev.text+='\n\n'+text;prev.folded=false;}else out.push({kind:paragraphMode?'paragraph':'text',text});i=j;}
    }
    return out;
  }
  collectList(lines, start, first, resumes) {
    const items=[];let j=start,loose=false;
    const sibling=m=>m&&m.ordered===first.ordered&&m.symbol===first.symbol;
    while(j<lines.length){
      const m=listMarker(lines[j]);if(!sibling(m)||RX.rule.test(lines[j]))break;
      const body=[m.text],forced=new Set();let k=j+1,emptyLine=false,blankTail='';

      while(k<lines.length){
        if(resumes?.has(k))break;
        const line=lines[k], next=listMarker(line);if(next&&next.base<m.indent)break;
        if(blank(line)){
          if(m.empty&&body.every(blank)){let q=k;while(q<lines.length&&blank(lines[q]))q++;if(sibling(listMarker(lines[q]||''))){loose=true;k=q;}break;}
          const lead=columns(line);blankTail=lead[1]>m.indent?' '.repeat(lead[1]-m.indent):'';body.push('');emptyLine=true;k++;continue;
        }
        if(indentation(line)>=m.indent){const text=listDedent(line,m.indent);body.push(text);emptyLine=false;blankTail='';k++;continue;}
        if(emptyLine||breaksBlock(line)||RX.fence.test(line)||RX.fence.test(body.at(-1)||''))break;
        const last=body.length-1,tail=forced.has(last)&&indentation(body[last])>=4?dedent(body[last],4):body[last];
        if(m.empty||!RX.quote.test(tail)&&!lazy(tail))break;
        forced.add(body.length);body.push(line);k++;
      }
      const next=listMarker(lines[k]||'');if(emptyLine&&sibling(next)&&!RX.rule.test(lines[k]||''))loose=true;
      let trailing=0;while(body.length&&blank(body.at(-1))){if(body.length>1)trailing++;body.pop();}if(trailing&&!sibling(next))k-=trailing;
      const task=/^\[([ xX])\][ \t]+/.exec(body[0]||''),children=this.collect(body.join('\n'),false,false,forced);
      if(trailing&&sibling(next)&&!RX.rule.test(lines[k]||'')){const last=children.at(-1);if(last?.kind==='html')last.text+='\n';else if(blankTail&&(last?.kind==='text'||last?.kind==='paragraph')&&children.some(x=>x.kind==='list'))last.text+='\n'+blankTail;}
      if(task&&children[0]?.kind==='text')children[0].text=children[0].text.slice(task[0].length);
      if(children.some((x,n)=>x.kind==='gap'&&n>0))loose=true;
      items.push({children,task:task?task[1]!==' ':null});j=k;if(!sibling(next)||RX.rule.test(lines[j]||''))break;
    }
    return {end:j,token:{kind:'list',ordered:first.ordered,start:first.number,items,loose}};
  }
  emit(tokens,tight=false) {
    const out=[];
    for(let i=0;i<tokens.length;i++){
      const t=tokens[i];switch(t.kind){
        case 'gap':break;
        case 'html':out.push(t.text);break;
        case 'rule':out.push('<hr>\n');break;
        case 'heading':out.push('<h',t.level,'>',this.inline(t.text),'</h',t.level,'>\n');break;
        case 'code':out.push('<pre><code',t.language?' class="language-'+html(t.language)+'"':'','>',html(t.text,true),t.text||t.newline?'\n':'','</code></pre>\n');break;
        case 'quote':out.push('<blockquote>\n',this.emit(t.children),'</blockquote>\n');break;
        case 'list':{
          const tag=t.ordered?'ol':'ul';out.push('<',tag,t.ordered&&t.start!==1?' start="'+t.start+'"':'','>\n');
          for(const item of t.items){let body=this.emit(item.children,!t.loose);if(item.task!==null){const check='<input '+(item.task?'checked="" ':'')+'disabled="" type="checkbox"> ';body=t.loose&&body.startsWith('<p>')?'<p>'+check+body.slice(3):check+body;}out.push('<li>',body,'</li>\n');}out.push('</',tag,'>\n');break;
        }
        case 'table':{
          out.push('<table>\n<thead>\n<tr>\n');
          for(let j=0;j<t.header.length;j++)out.push('<th',t.alignment[j]?' align="'+t.alignment[j]+'"':'','>',this.inline(t.header[j]),'</th>\n');
          out.push('</tr>\n</thead>\n');if(t.rows.length){out.push('<tbody>');for(const row of t.rows){out.push('<tr>\n');for(let j=0;j<t.header.length;j++)out.push('<td',t.alignment[j]?' align="'+t.alignment[j]+'"':'','>',this.inline(row[j]||''),'</td>\n');out.push('</tr>\n');}out.push('</tbody>');}out.push('</table>\n');break;
        }
        case 'paragraph':case 'text':{let text=t.text;if(t.kind==='text')while(tokens[i+1]?.kind==='text')text+='\n'+tokens[++i].text;if(t.folded&&t.foldedNewline)text+='\n';const rendered=this.inline(text);if(tight)out.push(rendered);else out.push('<p>',rendered,'</p>\n');break;}
      }
    }return out.join('');
  }
  inline(s,inLink=false,plain=false) {return scanInline(this,s,inLink,plain);}
}

function backticks(s,p) {
  let n=1;while(s[p+n]==='`')n++;
  let q=p+n;
  while((q=s.indexOf('`',q))>=0){let end=q+1;while(s[end]==='`')end++;if(end-q===n)return {start:q,end,width:n};q=end;}
  return {end:-1,width:n};
}
function closeBracket(s,p,mask=false) {
  let depth=1;
  for(let i=p+1;i<s.length;i++){
    const c=s[i];
    if(c==='\\'){i++;continue;}
    if(c==='`'){
      let n=1;while(s[i+n]==='`')n++;
      // Reference masking pairs successive backtick runs, regardless of width.
      // Rendered code spans still require matching run widths.
      if(mask){let q=s.indexOf('`',i+n);if(q>=0){while(s[q+1]==='`')q++;i=q;}else i+=n-1;continue;}
      let q=i+n;
      while(q<s.length){q=s.indexOf('`',q);if(q<0||n>1&&s.slice(i+n,q).includes(']'))break;let end=q+1;while(s[end]==='`')end++;if(end-q===n){i=end-1;break;}q=end;}
      if(q<0)i+=n-1;
    }else if(c==='<'){const m=at(RX.auto,s,i)||at(RX.tag,s,i);if(m)i+=m[0].length-1;}
    else if(c==='[')depth++;
    else if(c===']'&&!--depth)return i;
  }return -1;
}
function labelIsComplex(s) {
  for(let i=0;i<s.length;i++){
    if(s[i]==='\\'){i++;continue;}
    // Nested bracket text has its own label syntax; validate this level only.
    if(s[i]==='['){const end=closeBracket(s,i);if(end>=0){i=end;continue;}}
    if(s[i]!=='`')continue;
    let n=1;while(s[i+n]==='`')n++;
    let q=s.indexOf('`',i+n);
    if(q<0)return n<2||i+n<s.length;
    while(s[q+1]==='`')q++;i=q;
  }return false;
}
const spaceCode = c => c===32||c===9||c===10;
function linkDestination(s,p) {
  while(spaceCode(s.charCodeAt(p)))p++;
  let href,title=null;
  if(s[p]==='<') {const begin=++p;while(p<s.length&&s[p]!=='>'&&s[p]!=='\n'){if(s[p]==='\\')p++;p++;}if(s[p]!=='>')return null;href=s.slice(begin,p++);}
  else {const begin=p;let depth=0;
    while(p<s.length){const c=s[p];if(c==='\\'&&p+1<s.length){p+=2;continue;}if(c==='('){depth++;p++;continue;}if(c===')'){if(!depth)break;depth--;p++;continue;}if(spaceCode(s.charCodeAt(p)))break;p++;}
    if(depth)return null;href=s.slice(begin,p);
  }
  const before=p;while(spaceCode(s.charCodeAt(p)))p++;
  if(p>before&&(s[p]==='"'||s[p]==="'"||s[p]==='(')){
    const closer=s[p]==='('?')':s[p],begin=++p;
    while(p<s.length&&s[p]!==closer){if(s[p]==='\\')p++;p++;}if(s[p]!==closer)return null;
    title=unquote(s.slice(begin,p++));while(spaceCode(s.charCodeAt(p)))p++;
  }
  return s[p]===')'?{href:unquote(href),title,end:p+1}:null;
}
function readLink(doc,s,p,inLink=false,cache) {
  if(cache){if(s[p]!=='!'&&inLink)return null;if(cache.has(p))return cache.get(p);const link=readLink(doc,s,p,inLink);cache.set(p,link);return link;}
  const image=s[p]==='!',open=p+(image?1:0);if(s[open]!=='['||!image&&inLink)return null;
  const close=closeBracket(s,open);if(close<0)return null;
  const label=s.slice(open+1,close);if(label.includes('`')&&labelIsComplex(label))return null;
  let end=close+1,dest=null,reference=true;
  if(s[end]==='('){dest=linkDestination(s,end+1);if(dest){end=dest.end;reference=false;}}
  if(!dest){let name=label;if(s[end]==='['){const q=s.indexOf(']',end+1);if(q>=0&&!/(?:^|[^\\])(?:\\\\)*\[/.test(s.slice(end+1,q))){name=s.slice(end+1,q)||label;end=q+1;}}
    dest=doc.refs.get(refName(name));if(!dest)return null;
  }
  return {image,label,dest,end,reference,close};
}
function nestedLink(doc,s) {
  if(!s.includes('['))return false;
  for(let i=0;i<s.length;i++){
    if(s[i]==='\\'){i++;continue;}
    if(s[i]==='!'&&s[i+1]==='['){const link=readLink(doc,s,i);if(link){i=link.end-1;continue;}}
    if(s[i]==='['){const link=readLink(doc,s,i);if(link&&(link.reference||!link.label.includes('\\]')))return true;}
  }return false;
}
function maskableReference(doc,s,link) {
  if(s[link.close+1]!=='['||s[link.close+2]===']')return false;
  const label=link.label;
  for(let i=0;i<label.length;i++){
    if(label[i]==='\\'){i++;continue;}if(label[i]!=='[')continue;
    const nested=readLink(doc,label,i);if(!nested)continue;
    if(!label.startsWith('[]',nested.close+1))return false;i=nested.end-1;
  }return true;
}
const asciiPunctuation=new Uint8Array(128), asciiSpace=new Uint8Array(128), specials=new Uint8Array(128),emailLocal=new Uint8Array(128);
for(const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-")emailLocal[c.charCodeAt(0)]=1;
for(const c of 'hHfFwmMxX')specials[c.charCodeAt(0)]|=4;
for(const c of ' \t')specials[c.charCodeAt(0)]|=2;
for(let c=0;c<128;c++){asciiPunctuation[c]=RX.punctuation.test(String.fromCharCode(c))?1:0;asciiSpace[c]=/\s/.test(String.fromCharCode(c))?1:0;}
for(const c of '\\`<[!*_~&\n')specials[c.charCodeAt(0)]|=1;
function isPunct(c,delimiter) {return c!==126||delimiter!=='*' ? c<128?asciiPunctuation[c]===1:RX.punctuation.test(String.fromCharCode(c)) : false;}
function isSpace(c) {return !Number.isFinite(c)||c<128? !Number.isFinite(c)||asciiSpace[c]===1 : /\s/.test(String.fromCharCode(c));}
function flank(s,p,n,c,opener=false) {
  const a=p?s.charCodeAt(p-1):32,b=s.charCodeAt(p+n),wa=isSpace(a),wb=isSpace(b),pa=isPunct(a,opener?'~':c),pb=isPunct(b,opener?'~':c);
  const left=!wb&&(!pb||wa||pa),right=!wa&&(!pa||wb||pb);
  return (c==='_'?left&&(!right||pa):left ? 1 : 0) | ((c==='_'?right&&(!left||pb):right)?2:0);
}
function inlineDelimiters(doc,s,links) {
  // References are protected before backticks, so an unmatched backtick in a
  // reference label cannot hide a delimiter outside that label.
  let masked=s;
  if(doc.refs.size&&s.includes('[')){
    const chunks=[];let from=0;
    for(let p=s.indexOf('[');p>=0;p=s.indexOf('[',p+1)){
      let escapes=0;for(let j=p-1;s[j]==='\\';j--)escapes++;
      if(escapes%2)continue;
      let i=p;if(s[i-1]==='!'&&s[i-2]!=='\\')i--;
      let link=readLink(doc,s,i,false,links);
      const close=closeBracket(s,p,true);
      if(close>=0&&s[close+1]==='['&&s[close+2]!==']'){
        const end=s.indexOf(']',close+2),name=s.slice(close+2,end);
        if(end>=0&&!name.includes('[')&&doc.refs.has(refName(name)))link={image:i!==p,label:s.slice(p+1,close),reference:true,close,end:end+1};
      }
      if(!link?.reference||s.startsWith('[]',link.close+1))continue;
      if(!link.image&&nestedLink(doc,link.label)&&!maskableReference(doc,s,link))continue;
      chunks.push(s.slice(from,i),'[','a'.repeat(link.end-i-2),']');from=link.end;p=from-1;
    }if(from){chunks.push(s.slice(from));masked=chunks.join('');}
  }
  const codeRanges=[];
  for(let i=masked.indexOf('`');i>=0;i=masked.indexOf('`',i+1)){
    let escapes=0;for(let j=i-1;masked[j]==='\\';j--)escapes++;
    if(escapes%2)continue;
    const span=backticks(masked,i);if(span.end>=0){codeRanges.push([i,span.end]);i=span.end-1;}else i+=span.width-1;
  }
  const runs=[];let range=0;
  for(let i=0;i<masked.length;i++){
    while(range<codeRanges.length&&codeRanges[range][1]<=i)range++;
    if(range<codeRanges.length&&codeRanges[range][0]<=i){i=codeRanges[range][1]-1;continue;}
    const c=masked[i];
    if(c==='\\'&&RX.escape.test(masked[i+1]||'')){i++;continue;}
    if(c==='`'){const span=backticks(masked,i);i=span.end>=0?span.end-1:i+span.width-1;continue;}
    if(c==='<'){const m=at(RX.auto,masked,i)||at(RX.tag,masked,i);if(m){i+=m[0].length-1;continue;}}
    if(c==='['||c==='!'&&masked[i+1]==='['){
      const link=readLink(doc,s,i,false,links);if(link&&(link.image||!nestedLink(doc,link.label))){i=link.end-1;continue;}
      const open=i+(c==='!'?1:0),end=closeBracket(s,open);
      if(end>=0&&s[end+1]==='('&&!nestedLink(doc,s.slice(open+1,end))){const d=linkDestination(s,end+2);if(d){i=d.end-1;continue;}}
    }
    if(c==='*'||c==='_'||c==='~'){let n=1;while(masked[i+n]===c)n++;runs.push({pos:i,n,c,flags:flank(masked,i,n,c)});i+=n-1;}
  }
  return {runs,masked};
}
// Balance complete runs with the odd-match rule. Tildes are punctuation for
// underscore closers, but remain ordinary neighbors for asterisk closers.
function emphasis(s,p,delimiters) {
  const c=s[p];let n=1;while(s[p+n]===c)n++;
  if(delimiters.masked[p]!==c)return {literal:true};
  const flags=flank(s,p,n,c,true);
  if(!(flags&1)||c==='~'&&n>2)return null;
  let remaining=n,odd=0,skip=-1;
  for(const r of delimiters.runs){
    if(r.pos<=p||r.pos<skip)continue;
    if(r.c!==c){
      if((r.flags&1)&&r.c!=='~'){const other=emphasis(s,r.pos,delimiters),next=delimiters.runs.find(x=>x.pos>r.pos&&x.c===c&&(x.flags&2));if(other&&next&&other.end<=next.pos)skip=other.end;}
      continue;
    }
    if(c==='~'&&r.n!==n)continue;
    if(r.flags===1){remaining+=r.n;continue;}
    if(!(r.flags&2))continue;
    if(c!=='~'&&(r.flags===3||flags&2)&&(n+r.n)%3===0&&(n%3!==0||r.n%3!==0)){odd+=r.n;continue;}
    remaining-=r.n;
    if(remaining<=0){const width=Math.min(r.n,r.n+remaining+odd),size=c==='~'?n:Math.min(n,width)%2?1:2;return {size,end:r.pos+width};}
  }return odd?{literal:true}:null;
}
function trimWeb(s) {
  let prev;
  do{prev=s;s=s.replace(/&[a-zA-Z0-9]+;$/,'').replace(/[?!.,:;*_~]+$/,'');const open=s.lastIndexOf('('),close=s.lastIndexOf(')');if(open>close)s=s.slice(0,open);else if(s.endsWith(')')&&(open<0||s.indexOf(')',open)!==s.length-1))s=s.slice(0,-1);s=s.replace(/&[a-zA-Z0-9]+;$/,'');}while(prev!==s);
  return s;
}
function webPrefix(s,i) {
  const c=s.charCodeAt(i)|32;
  if(c===104)return (s.charCodeAt(i+1)|32)===116&&(s.charCodeAt(i+2)|32)===116&&(s.charCodeAt(i+3)|32)===112&&(s.startsWith('://',i+4)||(s.charCodeAt(i+4)|32)===115&&s.startsWith('://',i+5));
  return c===102&&(s.charCodeAt(i+1)|32)===116&&(s.charCodeAt(i+2)|32)===112&&s.startsWith('://',i+3);
}
function scanInline(doc,s,inLink,plain) {
  if(!s)return '';
  const first=s[0];
  if(first==='*'||first==='_'){
    let n=1;while(s[n]===first)n++;
    if(s.length>n*2&&s.endsWith(first.repeat(n))&&s[s.length-n-1]!==first){
      const text=s.slice(n,-n);
      if(!/[\\`<[!*_~&@\n]/.test(text)&&!/^\s|\s$/.test(text)&&!/(?:https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:)/i.test(text)){
        if(plain)return text;
        let result=html(text);for(let pairs=n>>1;pairs>0;pairs--)result='<strong>'+result+'</strong>';
        return n%2?'<em>'+result+'</em>':result;
      }
    }
  }
  if(s[0]==='`'){
    const span=backticks(s,0);
    if(span.end===s.length){let text=s.slice(span.width,span.start).replace(/\n/g,' ');if(text[0]===' '&&text.at(-1)===' '&&/[^ ]/.test(text))text=text.slice(1,-1);return plain?text:'<code>'+html(text,true)+'</code>';}
  }
  const hasEmail=s.includes('@');
  if(!/[\\`<[!*_~&"'\n]/.test(s)&&!hasEmail&&!/(?:https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:)/i.test(s))return html(s);
  const links=s.includes('[')?new Map():null;
  const out=[],delimiters=/[*_~]/.test(s)?inlineDelimiters(doc,s,links):null;
  let i=0,raw=false,htmlLink=inLink||doc.htmlLink;
  let nextMail=null,mailFrom=-1;
  const findMail=pos=>{
    mailFrom=pos;
    for(let a=s.indexOf('@',pos);a>=0;a=s.indexOf('@',a+1)){
      let start=a;while(start>pos){const c=s.charCodeAt(start-1);if(c>=128||!emailLocal[c])break;start--;}
      if(start<a){const m=at(RX.mail,s,start);if(m&&!/[_-]$/.test(m[0]))return m;}
    }
    return null;
  };
  if(hasEmail&&!htmlLink)nextMail=findMail(0);
  while(i<s.length){
    const c=s[i];
    if(c==='\\'&&i+1<s.length){
      if(s[i+1]==='\n'){out.push(plain?'\n':'<br>');i+=2;while(s[i]===' '||s[i]==='\t')i++;continue;}
      if(RX.escape.test(s[i+1])){out.push(plain?s[i+1]:html(s[i+1]));i+=2;continue;}
    }
    if(c==='`'){
      const span=backticks(s,i);
      if(span.end>=0){let text=s.slice(i+span.width,span.start).replace(/\n/g,' ');if(text[0]===' '&&text.at(-1)===' '&&/[^ ]/.test(text))text=text.slice(1,-1);out.push(plain?text:'<code>'+html(text,true)+'</code>');i=span.end;continue;}
      out.push(s.slice(i,i+span.width));i+=span.width;continue;
    }
    if(c==='<'){
      const a=at(RX.auto,s,i);
      if(a){const text=a[1],href=text.includes(':')?text:'mailto:'+text;out.push(plain?text:'<a href="'+address(href)+'">'+html(text)+'</a>');i+=a[0].length;continue;}
      const tag=at(RX.tag,s,i);
      if(tag){const t=tag[0];if(!plain)out.push(t);i+=t.length;
        if(/^<a\s/i.test(t)){htmlLink=true;if(!plain)doc.htmlLink=true;}else if(/^<\/a\s*>/i.test(t)){htmlLink=inLink;if(!plain)doc.htmlLink=false;}
        if(/^<(?:pre|code|kbd|script)(?:\s|>)/i.test(t))raw=true;
        else if(/^<\/(?:pre|code|kbd|script)\s*>/i.test(t))raw=false;
        continue;
      }
    }
    if(c==='['||c==='!'&&s[i+1]==='['){
      const link=readLink(doc,s,i,inLink,links);
      if(link&&!(!link.image&&nestedLink(doc,link.label))){
        const text=doc.inline(link.label,link.image?false:true,plain||link.image),href=address(link.dest.href),title=link.dest.title!=null?' title="'+html(link.dest.title)+'"':'';
        if(plain)out.push(text);
        else if(link.image)out.push(href===null?html(text):'<img src="'+href+'" alt="'+html(text)+'"'+title+'>');
        else out.push(href===null?text:'<a href="'+href+'"'+title+'>'+text+'</a>');
        i=link.end;continue;
      }
    }
    if(c==='*'||c==='_'||c==='~'){
      const match=emphasis(s,i,delimiters);
      if(match&&!match.literal){const tag=c==='~'?'del':match.size===2?'strong':'em',inner=doc.inline(s.slice(i+match.size,match.end-match.size),inLink,plain);out.push(plain?inner:'<'+tag+'>'+inner+'</'+tag+'>');i=match.end;htmlLink=inLink||doc.htmlLink;continue;}
      let n=1;while(s[i+n]===c)n++;
      if(!match?.literal&&c!=='~'&&(flank(s,i,n,c,true)&1)){out.push(c);i++;}else{out.push(s.slice(i,i+n));i+=n;}continue;
    }
    if(!htmlLink){
      if(hasEmail&&(mailFrom<0||nextMail&&i>nextMail.index))nextMail=findMail(i);
      if((c==='m'||c==='M'||c==='x'||c==='X')&&hasEmail){const m=at(RX.mailScheme,s,i);if(m&&!/[_-]$/.test(m[2])){let text=m[1]+m[2];if(m[1].toLowerCase()==='xmpp:'&&m[3])text+='/'+m[3];text=text.replace(/\.+$/,'');out.push(plain?text:'<a href="'+address(text)+'">'+html(text)+'</a>');i+=text.length;continue;}}
      if(c==='h'||c==='H'||c==='f'||c==='F'||c==='w'){const m=at(RX.web,s,i);if(m){const text=trimWeb(m[0]);if(text){out.push(plain?text:'<a href="'+address(text.startsWith('www.')?'http://'+text:text)+'">'+html(text)+'</a>');i+=text.length;continue;}}}
      if(nextMail&&nextMail.index===i){const m=nextMail;if(m){const text=m[0].replace(/\.+$/,'');out.push(plain?text:'<a href="mailto:'+html(text)+'">'+html(text)+'</a>');i+=text.length;continue;}}
    }
    if(c===' '||c==='\t'){
      let j=i+1,onlySpaces=c===' ';while(s[j]===' '||s[j]==='\t'){if(s[j]==='\t')onlySpaces=false;j++;}
      if(s[j]==='\n'){const hard=onlySpaces&&j-i>=2;out.push(hard?plain?'\n':'<br>':s.slice(i,j)+'\n');i=j+1;if(hard)while(s[i]===' '||s[i]==='\t')i++;continue;}
    }
    if(c==='\n'){out.push('\n');i++;continue;}
    if(c==='&'&&!raw){
      const m=at(RX.numeric,s,i);if(m){const value=parseInt(m[0].slice(m[0][2]==='x'||m[0][2]==='X'?3:2,-1),m[0][2]==='x'||m[0][2]==='X'?16:10),text=value===0||value>0x10ffff||value>=0xd800&&value<=0xdfff?'\ufffd':String.fromCodePoint(value);out.push(plain?text:html(text));i+=m[0].length;continue;}
      const named=at(RX.entity,s,i);if(named){out.push(named[0]);i+=named[0].length;continue;}
    }
    let j=i+1;
    const limit=nextMail&&nextMail.index>i&&!htmlLink?nextMail.index:s.length;
    while(j<limit){
      const d=s.charCodeAt(j),flags=d<128?specials[d]:0;
      if(!flags){j++;continue;}
      if(flags&1)break;
      if(flags&2){let end=j+1;while(s[end]===' '||s[end]==='\t')end++;if(s[end]==='\n')break;j=end;continue;}
      if(!htmlLink&&(s.startsWith('www.',j)||s.startsWith('mailto:',j)||s.startsWith('xmpp:',j)||webPrefix(s,j)))break;
      j++;
    }
    const text=s.slice(i,j);out.push(raw||plain?text:html(text));i=j;
  }
  return out.join('');
}

export function parse(markdown) {
  const doc=new Document();
  return doc.emit(doc.collect(markdown.includes('\r')?markdown.replace(/\r\n?/g,'\n'):markdown));
}
