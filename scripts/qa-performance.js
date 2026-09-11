async (page) => {
  const ui = page.context().pages().find(p=>p.url().startsWith('chrome-extension://'));
  await ui.bringToFront();
  const outcome = await ui.evaluate(async () => {
    await chrome.runtime.sendMessage({type:'clear'});
    await chrome.runtime.sendMessage({type:'settings',settings:{paused:true,maxRecords:20000}});
    const base = Date.now() - 1000;
    const topics = ['多智能体协作工作流与 Claude Code 实践', 'IndexedDB 本地数据库性能优化', '设计系统与组件开发的日常笔记', 'Python 数据可视化与统计方法', '城市漫步与周末生活记录'];
    const posts = Array.from({length:20000},(_,i)=>({id:String(3000000000000+i),authorHandle:`author${i%100}`,authorName:`作者 ${i%100}`,text:`${topics[i%topics.length]}。这是第 ${i} 条本地压力测试数据。 ${'A practical guide to building reliable browser tools. '.repeat(3)}${i%997===0?'罕见关键词月光森林':''}`,quotedText:i%7===0?'引用内容：可靠的软件来自持续验证。':'',media:i%3===0?'image':i%3===1?'video':'text',images:[],postedAt:base-i*60000,firstViewedAt:base-i*60000,lastViewedAt:base-i*60000,viewCount:1,dwellMs:1000}));
    const start = performance.now();
    const imported = await chrome.runtime.sendMessage({type:'import',backup:{format:'seen-backup',version:1,posts}});
    if (!imported.ok) throw new Error(imported.error);
    const importMs = performance.now()-start;
    const worker = new Worker(chrome.runtime.getURL('search-worker.js'),{type:'module'});
    const query = {text:'',author:'',from:null,to:null,media:'',sort:'newest'};
    let id = 0;
    const search = (q) => new Promise((resolve,reject)=>{worker.onmessage=e=>e.data.error?reject(new Error(e.data.error)):resolve(e.data.result);worker.postMessage({id:++id,query:{...query,...q}});});
    const timings=[];
    for (const q of [{},{text:'月光森林'},{text:'多智能体'},{text:'browser'},{text:'的'},{author:'author42'},{media:'image'},{text:'完全不存在的词'}]) {
      const result = await search(q);timings.push({query:q,ms:Math.round(result.elapsedMs),matched:result.matched,scanned:result.scanned});
    }
    const first=await search({}); const second=await search({cursor:first.next});
    timings.push({query:'第二页',ms:Math.round(second.elapsedMs),scanned:second.scanned});
    worker.terminate();
    const estimate=await navigator.storage.estimate();
    return {records:imported.total,importMs:Math.round(importMs),storageMB:Math.round(estimate.usage/1048576*10)/10,timings};
  });
  await ui.reload(); await ui.waitForFunction(()=>document.querySelectorAll('.post').length===50);
  const cdp=await ui.context().newCDPSession(ui);await cdp.send('Performance.enable');
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const before=await metric();await ui.waitForTimeout(8000);const after=await metric();
  outcome.idle8s={taskMs:Math.round((after.TaskDuration-before.TaskDuration)*1000),scriptMs:Math.round((after.ScriptDuration-before.ScriptDuration)*1000),heapMB:Math.round(after.JSHeapUsedSize/1048576*10)/10,nodes:after.Nodes};
  await ui.screenshot({path:'output/playwright/history-20000.png'});
  await cdp.detach();return outcome;
}
