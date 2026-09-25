// Adapt local Markdown links into DSH's existing, bounded file-mention control.
// Source messages and copy/export data remain unchanged; no URL protocol bypass.
export function createMessagePresentation(React, files, NativeAssistant) {
  function prepareMany(texts) {
    const links = new Map();
    // Preserve fenced and inline code verbatim. Conservative links only: complex
    // Markdown remains with the native renderer instead of guessing its target.
    const parts=texts.map(text=>{
      const chunks=[];let fence=null;
      for(const line of text.match(/[^\n]*\n|[^\n]+$/g)??[]){
        const mark=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
        if(fence){chunks.push({text:line,code:true});if(mark&&mark[1][0]===fence[0]&&mark[1].length>=fence.length&&!mark[2].trim())fence=null;}
        else if(mark){fence=mark[1];chunks.push({text:line,code:true});}
        else line.split(/(`+[^`\n]*`+)/g).forEach((text,index)=>chunks.push({text,code:index%2===1}));
      }
      return chunks;
    });
    const pattern = /(?<!!)\[([^\]\n`]+)\]\((<[^>\n]+>|[^\s()]+)\)/g;
    const local = href => files.parseLocalFileLink(href.startsWith('<') ? href.slice(1,-1) : href);
    for(const part of parts.flat().filter(part=>!part.code)) {
      for(const match of part.text.matchAll(pattern)) {
        const parsed = local(match[2]);
        if(parsed) {
          const previous=links.get(match[1]);
          links.set(match[1],previous&&(previous.ambiguous||previous.path!==parsed.path||previous.line!==parsed.line)?{ambiguous:true}:parsed);
        }
      }
    }
    for(const part of parts.flat().filter(part=>!part.code)) {
      part.text=part.text.replace(pattern,(original,label,href)=>{
        const parsed=local(href);if(!parsed)return original;
        if(links.get(label)?.ambiguous) { const value=parsed.path+(parsed.line?`:${parsed.line}`:'');links.set(value,parsed);return label+' (`'+value+'`)'; }
        return '`'+label+'`';
      });
    }
    return {texts:parts.map(chunks=>chunks.map(part=>part.text).join('')),links};
  }
  function prepare(text){const result=prepareMany([text]);return {text:result.texts[0],links:result.links};}
  function AssistantMessage(props) {
    const rendered=prepareMany(props.node.data.blocks.filter(block=>block.kind==='text').map(block=>block.text));
    const references=rendered.links;let index=0;
    const blocks=props.node.data.blocks.map(block=>{
      if(block.kind!=='text')return block;
      return {...block,text:rendered.texts[index++]};
    });
    return React.createElement(NativeAssistant,{...props,node:{...props.node,data:{...props.node.data,blocks}},fileMentions:owner=>{
      const native=props.fileMentions?.(owner);
      return {resolve(value){
        const target=references.get(value);
        if(target&&!target.ambiguous)return {title:target.path,label:`打开文件 ${value}`,open:()=>files.open(props.sessionId,target.path,target.line)};
        return native?.resolve(value);
      }};
    }});
  }
  return {prepare,AssistantMessage};
}
