async (page) => {
  const context=page.context();const ui=context.pages().find(p=>p.url().startsWith('chrome-extension://'));
  const rpc=message=>ui.evaluate(message=>chrome.runtime.sendMessage(message),message);
  for(const p of context.pages())if(p.url().startsWith('https://x.com/'))await p.close();
  await rpc({type:'clear'});await rpc({type:'settings',settings:{paused:false}});
  const html='<!doctype html><html><head><meta charset="utf-8"><title>Collector performance</title><style>body{margin:0}article{height:500px;width:600px}main{min-height:3000px}</style></head><body><main><article data-testid="tweet"><div data-testid="User-Name"><a href="/tester">Test</a><a href="/tester">@tester</a><a href="/tester/status/555500001111"><time datetime="2026-09-09T12:00:00Z">1h</time></a></div><div data-testid="tweetText">性能测试内容</div><button data-testid="like"><span>0</span></button></article></main></body></html>';
  await context.route('https://x.com/seen-load',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  const fixture=await context.newPage();await fixture.goto('https://x.com/seen-load');await fixture.bringToFront();await fixture.waitForTimeout(2000);
  const health=()=>ui.evaluate(async()=>{
    for(const tab of await chrome.tabs.query({})){try{const h=await chrome.tabs.sendMessage(tab.id,{type:'health'});if(h)return h;}catch{}}
  });
  const cdp=await context.newCDPSession(fixture);await cdp.send('Performance.enable');
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  let before=await metric();const h1=await health();await fixture.waitForTimeout(10000);let after=await metric();const h2=await health();
  const idle={taskMs:Math.round((after.TaskDuration-before.TaskDuration)*1000),scriptMs:Math.round((after.ScriptDuration-before.ScriptDuration)*1000),scanDelta:h2.scans-h1.scans,mutationDelta:h2.mutationBatches-h1.mutationBatches};
  before=await metric();
  await fixture.evaluate(async()=>{for(let frame=0;frame<600;frame++){document.querySelector('[data-testid="like"] span').textContent=String(frame);await new Promise(resolve=>requestAnimationFrame(resolve));}});
  after=await metric();const h3=await health();
  const mutations={frames:600,taskMs:Math.round((after.TaskDuration-before.TaskDuration)*1000),scriptMs:Math.round((after.ScriptDuration-before.ScriptDuration)*1000),scanDelta:h3.scans-h2.scans};
  // A clear while a just-read post is pending must never resurrect that old post.
  await rpc({type:'clear'});await fixture.waitForTimeout(800);await rpc({type:'settings',settings:{paused:false}});await fixture.waitForTimeout(800);
  const afterClear=(await rpc({type:'status'})).count;
  await rpc({type:'settings',settings:{paused:true}});
  await cdp.detach();await fixture.close();
  if(idle.scanDelta||afterClear)throw new Error(JSON.stringify({idle,afterClear}));
  return {idle10s:idle,mutations,afterClear};
}
