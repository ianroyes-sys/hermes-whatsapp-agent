const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const spool = require('./dispatch-spool');
test('claimed or interrupted tasks cannot silently replay; bytes survive', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-spool-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'one.json'), JSON.stringify({ task: 'fixture' }));
  const item = spool.claim(root, 'one.json');
  assert.equal(item.job.task, 'fixture'); assert.equal(spool.claim(root, 'one.json'), null);
  fs.writeFileSync(path.join(root, 'one.json'), JSON.stringify({ task: 'duplicate' }));
  assert.equal(spool.claim(root, 'one.json'), null);
  assert.equal(JSON.parse(fs.readFileSync(item.path)).task, 'fixture');
});
test('task result is queued durably before original claim is acknowledged', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-spool-result-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'one.json'), JSON.stringify({task:'fixture'}));
  const item = spool.claim(root, 'one.json'); spool.queueResult(item, 'result available');
  assert.equal(fs.existsSync(item.path), false);
  const notify = spool.claim(root, 'one.result-notify.json');
  assert.equal(notify.job.notify, 'result available');
  assert.equal(fs.existsSync(notify.path), true); // remains until confirmed send resolution
  spool.acknowledge(notify); assert.equal(fs.existsSync(notify.path), false);
});
test('invalid dispatch data is preserved instead of deleted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-spool-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bad.json'), 'invalid');
  assert.equal(spool.claim(root, 'bad.json'), null);
  assert.equal(fs.readFileSync(path.join(root, 'bad.json.processing.invalid'), 'utf8'), 'invalid');
});

test('parsed null, arrays, primitives and malformed jobs are quarantined without losing bytes', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-job-shapes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cases=[null,[],42,'text',false,{}, {task:42},{notify:{}},{task:' '},{task:'x',notify:'y'},{task:'x',agent:[]},{notify:'x',source:null}];
  for(const [i,job] of cases.entries()) {
    const name=`${i}.json`,raw=JSON.stringify(job);fs.writeFileSync(path.join(root,name),raw);
    assert.equal(spool.claim(root,name),null);
    assert.equal(fs.readFileSync(path.join(root,name+'.processing.invalid'),'utf8'),raw);
  }
});
test('a second invalid job cannot overwrite the first quarantined payload', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-invalid-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const raw of ['null','[]']) {fs.writeFileSync(path.join(root,'one.json'),raw);assert.equal(spool.claim(root,'one.json'),null);}
  assert.deepEqual(fs.readdirSync(root).map(f=>fs.readFileSync(path.join(root,f),'utf8')).sort(),['[]','null']);
});
test('conflicting result notice preserves the original task claim', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-result-conflict-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'one.json'),JSON.stringify({task:'fixture'}));const item=spool.claim(root,'one.json');
  const target=path.join(root,'one.result-notify.json');fs.writeFileSync(target,JSON.stringify({notify:'other result'}));
  assert.throws(()=>spool.queueResult(item,'new result'),/Conflicting/);assert.ok(fs.existsSync(item.path));
  assert.equal(JSON.parse(fs.readFileSync(target)).notify,'other result');
});
test('retrying result publication does not recreate an already claimed identical notice', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-result-claimed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'one.json'),JSON.stringify({task:'fixture'}));const item=spool.claim(root,'one.json');
  fs.writeFileSync(path.join(root,'one.result-notify.json'),JSON.stringify({notify:'result',source:'hermes-result'})+'\n');
  const notify=spool.claim(root,'one.result-notify.json');spool.queueResult(item,'result');
  assert.ok(fs.existsSync(notify.path));assert.equal(fs.existsSync(path.join(root,'one.result-notify.json')),false);assert.equal(fs.existsSync(item.path),false);
});
test('actual inbox integration survives malformed jobs and synchronous send failure without replay', async t => {
  const vm=require('node:vm');const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-dispatch-integration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'a.json'),'null');fs.writeFileSync(path.join(root,'b.json'),JSON.stringify({notify:'fixture'}));
  const source=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');const start=source.indexOf('function processDispatchInbox()');const end=source.indexOf('setInterval(processDispatchInbox',start);
  let sends=0;const context={fs,DISPATCH_INBOX:root,dispatchSpool:spool,currentSock:{sendMessage(){sends++;throw new Error('fixture synchronous failure');}},selfJid:'fixture',config:{replyPrefix:''},logEvent(){},resolveAgent(){return null;},enqueueTask(){throw new Error('unexpected task');},Promise};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  assert.doesNotThrow(()=>context.processDispatchInbox());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sends,1);assert.ok(fs.existsSync(path.join(root,'b.json.processing')));
  context.processDispatchInbox();await new Promise(resolve=>setImmediate(resolve));assert.equal(sends,1);
});

test('connection events clear stale dispatch sockets and distinguish pairing from heartbeat', () => {
  const vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  const marker='sock.ev.on("connection.update", ';const start=source.indexOf(marker)+marker.length;const end=source.indexOf('\n  });',start);
  assert.ok(start>=marker.length && end>start);
  const sock={user:{id:'fixture'}};let activity={};
  const context={sock,currentSock:null,selfJid:null,writeActivity(p){activity={...activity,...p};},console:{log(){}},qrcode:{generate(){}},jidNormalizedUser:x=>x,logEvent(){},config:{botName:'fixture'},process:{env:{},exit(){throw new Error('unexpected exit');}},DisconnectReason:{loggedOut:401},setTimeout(){},start(){}};
  vm.createContext(context);const update=vm.runInContext('('+source.slice(start,end)+'\n})',context);
  update({qr:'fixture-nonsecret'});assert.equal(activity.connected,false);assert.equal(activity.pairingRequired,true);assert.equal(context.currentSock,null);
  update({connection:'open'});assert.equal(activity.connected,true);assert.equal(activity.pairingRequired,false);assert.equal(context.currentSock,sock);
  update({connection:'close'});assert.equal(activity.connected,false);assert.equal(context.currentSock,null);assert.equal(context.selfJid,null);
  const newer={};context.currentSock=newer;activity.connected=true;update({connection:'close'});assert.equal(context.currentSock,newer);assert.equal(activity.connected,true);
});
