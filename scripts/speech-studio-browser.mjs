import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { speechStudio } from '../src/routes/speechStudio.js';
import { SPEECH_INSTRUCTIONS, speechBody, speechHash } from '../src/lib/catalogSpeech.js';

// A separate, local Chromium test with every request intercepted. Never signs
// into an account, calls OpenAI, or uses credentials from the environment.
const origin = 'https://learnalertapp.com';
const studioURL = origin + '/admin/api/catalog/speech/studio';
const mediaId = '00000000-0000-5000-a000-000000000001';
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0, ...new Array(124).fill(0)]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const state = { posts: [], unexpected: [], budgets: [], job: null, attached: true, ...options };
  const profile = {configured:true, disabled:false, model:'gpt-4o-mini-tts', voice:'cedar', instructions:SPEECH_INSTRUCTIONS, responseFormat:'mp3', maxInputCharacters:1000, maxInputBytes:1800, requiresBudget:true};
  const htmlResponse = speechStudio(), html = await htmlResponse.text(), headers = Object.fromEntries(htmlResponse.headers);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });
    if (url.origin !== origin) { state.unexpected.push(request.url()); return route.abort(); }
    if (method === 'GET' && path === '/admin/api/catalog/speech/studio') return route.fulfill({ status:200, headers, body:html });
    if (method === 'GET' && path === '/admin/api/catalog/speech/status') return json({...profile, ...(state.profile || {})});
    if (method === 'GET' && path === '/admin/api/catalog') return json({items:[{id:'spanish', title:'Spanish <tag>', status:'draft'}]});
    if (path === '/admin/api/catalog/spanish/speech/budgets') {
      if (method === 'GET') return json({items:state.budgets});
      if (method === 'POST') {
        const body = request.postDataJSON(); state.posts.push({path, body});
        const budget = {...body, model:profile.model, catalogId:'spanish', requests:0, reservedUsd:0, actualCostUsd:null};
        state.budgets.push(budget); return json({budget},201);
      }
    }
    if (path === '/admin/api/catalog/spanish/speech' && method === 'POST') {
      const body = request.postDataJSON(); state.posts.push({path, body});
      const requestHash = await speechHash(speechBody(body.input,{}));
      const result = {id:mediaId, reference:'catalog:'+mediaId, requestHash, budgetId:body.budgetId, state:'ready', contentType:'audio/mpeg', byteSize:mp3.length, cached:Boolean(state.job?.state === 'ready'), actualCostUsd:null, qaStatus:'pending'};
      if (!state.job) state.job = {...result, input:body.input, state:state.failGeneration ? 'uncertain' : 'ready'};
      if (state.failGeneration) return json({error:{code:'TTS_OUTCOME_UNCERTAIN',message:'The outcome needs reconciliation. Do not retry.'}},503);
      await new Promise(resolve=>setTimeout(resolve,100));
      state.attached = true; return json(result,result.cached?200:201);
    }
    if (/^\/admin\/api\/catalog\/spanish\/speech\/[a-f0-9]{64}$/.test(path) && method === 'GET') {
      if (state.expired) return route.fulfill({status:200,contentType:'text/html',body:'Sign in'});
      if (!state.job) return json({error:{message:'Not found'}},404);
      return json({...state.job, media:state.attached && state.job.state==='ready' ? {id:mediaId,reference:'catalog:'+mediaId,contentType:'audio/mpeg',byteSize:mp3.length}:null});
    }
    if (path === '/admin/api/catalog/media/'+mediaId && method === 'GET') return route.fulfill({status:200,contentType:'audio/mpeg',body:mp3,headers:{'Cache-Control':'no-store'}});
    state.unexpected.push(method+' '+request.url()); return route.abort();
  });
  await page.goto(studioURL); await page.getByText('Ready. Select a course and its approved run. No audio is generated automatically.').waitFor();
  const selectRun = async () => {
    await page.locator('#catalog').selectOption('spanish');
    await page.getByText('Catalog selected. Generation only happens when you click Generate MP3.').waitFor();
    await page.getByText('Create a new bounded run only with owner approval', {exact:true}).click();
    await page.locator('#budget-id').fill('approved-pilot');
    await page.locator('#budget-usd').fill('5');
    await page.locator('#max-requests').fill('3');
    await page.locator('#per-request-usd').fill('1');
    await page.locator('#cost-ack').check();
    await page.getByRole('button',{name:'Create bounded run (no audio yet)',exact:true}).click();
    await page.getByText('Bounded run saved. No audio generated. Keep using this run for the whole approved allowance.').waitFor();
  };
  return {context,page,state,selectRun,async close(){assert.deepEqual(state.unexpected,[]);await context.close();}};
}
try {
  await test('studio visible controls create only the explicit allowance and one mocked MP3; private download works',async()=>{
    const h=await fixture();
    try {
      assert.equal(await h.page.locator('#budget-usd').inputValue(),'');
      assert.equal(h.state.posts.length,0);
      assert.equal(await h.page.locator('#catalog option').last().textContent(),'Spanish <tag> (spanish)');
      await h.selectRun(); assert.equal(h.state.posts.length,1);
      assert.deepEqual(h.state.posts[0].body,{id:'approved-pilot',maxRequests:3,reservationBudgetUsd:5,reservationPerRequestUsd:1,acknowledgeEstimatedCost:true});
      await h.page.locator('#input').fill('¡Hola! ¿Cómo estás?');
      await h.page.getByRole('button',{name:'Generate MP3 using selected run'}).click();
      await h.page.getByText('MP3 saved privately. Listening and pronunciation review are still required.').waitFor();
      assert.equal(h.state.posts.length,2);
      assert.deepEqual(h.state.posts[1].body,{input:'¡Hola! ¿Cómo estás?',budgetId:'approved-pilot'});
      assert.equal(h.state.job.requestHash,'f99a87816d424cb2079daf5303adb591d63ab3a87f382e442b45e03d7cc8492a');
      assert.equal(await h.page.locator('#audio').getAttribute('src'),'/admin/api/catalog/media/'+mediaId);
      assert.equal(await h.page.locator('#download').getAttribute('href'),'/admin/api/catalog/media/'+mediaId);
      const downloading=h.page.waitForEvent('download'); await h.page.locator('#download').click();
      const download=await downloading; assert.match(download.suggestedFilename(),/^learnalert-cedar-[a-f0-9]{64}\.mp3$/);
      assert.equal(await download.failure(),null);
      if(process.env.STUDIO_SCREENSHOTS){
        await mkdir(process.env.STUDIO_SCREENSHOTS,{recursive:true});
        await h.page.screenshot({path:process.env.STUDIO_SCREENSHOTS+'/desktop.png',fullPage:true});
        await h.page.setViewportSize({width:390,height:844});
        await h.page.screenshot({path:process.env.STUDIO_SCREENSHOTS+'/mobile.png',fullPage:true});
      }
    }finally{await h.close();}
  });
  await test('studio reload never retries uncertain generation, preserves recovery and recovers only ready cached audio',async()=>{
    const h=await fixture({failGeneration:true,attached:false});
    try {
      await h.selectRun(); await h.page.locator('#input').fill('Hola.');
      await h.page.getByRole('button',{name:'Generate MP3 using selected run'}).click();
      await h.page.getByText('The outcome needs reconciliation. Do not retry.').waitFor();
      assert.equal(h.state.posts.length,2);
      await h.page.reload();
      await h.page.getByText('A previous request needs a status check. No generation was resumed.').waitFor();
      assert.equal(h.state.posts.length,2);
      await h.page.getByRole('button',{name:'Check saved request status'}).click();
      await h.page.getByText('Saved state: uncertain. Do not retry an uncertain or failed request.').waitFor();
      await h.page.getByRole('button',{name:'Clear completed recovery view'}).click();
      await h.page.getByText('This request is still in progress or uncertain. Keep it for reconciliation.').waitFor();
      assert.equal(await h.page.locator('#recovery').isVisible(),true);
      h.state.job.state='ready';h.state.failGeneration=false;
      await h.page.getByRole('button',{name:'Check saved request status'}).click();
      await h.page.getByRole('button',{name:'Recover completed saved media'}).waitFor();
      await h.page.getByRole('button',{name:'Recover completed saved media'}).click();
      await h.page.getByText('Existing saved MP3 attached. No new provider request was needed.').waitFor();
      assert.equal(h.state.posts.length,3);assert.deepEqual(h.state.posts[2].body,{...h.state.posts[1].body,cacheOnly:true});
      assert.equal(await h.page.locator('#recovery').isVisible(),false);
    }finally{await h.close();}
  });
  await test('expired sign-in and changed model cannot trigger a recovery POST',async()=>{
    const h=await fixture({failGeneration:true,attached:false});
    try {
      await h.selectRun();await h.page.locator('#input').fill('Buenos días.');
      await h.page.getByRole('button',{name:'Generate MP3 using selected run'}).click();
      await h.page.getByText('The outcome needs reconciliation. Do not retry.').waitFor();
      h.state.expired=true;
      await h.page.getByRole('button',{name:'Check saved request status'}).click();
      await h.page.getByText('Sign-in may have expired. Open the admin studio, sign in, then check the saved request status. Do not generate again.').waitFor();
      assert.equal(h.state.posts.length,2);
      h.state.expired=false;h.state.job.state='ready';h.state.profile={model:'explicitly-changed-model'};
      await h.page.reload();await h.page.getByText('A previous request needs a status check. No generation was resumed.').waitFor();
      await h.page.getByRole('button',{name:'Check saved request status'}).click();
      await h.page.getByRole('button',{name:'Recover completed saved media'}).click();
      await h.page.getByText('The speech profile changed. Stop and review this saved request.').waitFor();
      assert.equal(h.state.posts.length,2);
    }finally{await h.close();}
  });
  await test('proxy-stripped headers cannot make framed or JavaScript-disabled controls actionable',async()=>{
    for(const javaScriptEnabled of [true,false]){
      const context=await browser.newContext({javaScriptEnabled});
      try{
        const response=speechStudio(),html=await response.text(),headers=Object.fromEntries(response.headers);
        delete headers['content-security-policy']; // Match the existing website proxy.
        const seen=[];
        await context.route('**/*',async route=>{
          seen.push(route.request().url());
          if(route.request().url()===origin+'/frame-test') return route.fulfill({contentType:'text/html',body:'<iframe id="studio-frame" src="'+studioURL+'"></iframe>'});
          assert.equal(route.request().url(),studioURL);
          return route.fulfill({headers,body:html});
        });
        const page=await context.newPage();
        await page.goto(javaScriptEnabled?origin+'/frame-test':studioURL);
        const controls=javaScriptEnabled?page.frameLocator('#studio-frame').locator('#studio-controls'):page.locator('#studio-controls');
        if(javaScriptEnabled) await page.frameLocator('#studio-frame').getByText('Open the speech studio directly in its own tab. Generation is unavailable inside a frame.').waitFor();
        assert.equal(await controls.isVisible(),false);
        assert.deepEqual(seen,javaScriptEnabled?[origin+'/frame-test',studioURL]:[studioURL]);
      }finally{await context.close();}
    }
  });
} finally { await browser.close(); }
