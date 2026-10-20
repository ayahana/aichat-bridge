import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as shared from '../extension/shared.js';
import * as qwen from '../extension/qwen-dom.js';
import { page, user, answer, url } from './helpers/qwen-fixture.js';

const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('qwen-dom.js'))", 'globalThis.__adapter')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__shared');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('stage reporter validates and bounds attempts even when transport fails or stalls', async () => {
  const sent = [];
  const report = shared.createStageReporter(true, stage => {
    sent.push(stage);
    if (stage === 'submitting') throw new Error('synchronous failure');
    if (stage === 'submitted') return Promise.reject(new Error('unsupported route'));
    return new Promise(() => {});
  });
  for (let i = 0; i < 5; i++) for (const value of ['submitting', 'submitted', 'first_output', 'secret text', null, {}, []]) report(value);
  await flush();
  assert.deepEqual(sent, ['submitting', 'submitted', 'first_output']);
  const disabled = shared.createStageReporter(false, () => assert.fail('disabled reporting sent data'));
  disabled('submitting');
});

async function fixture({ platform = 'qq', transport = 'success', mismatch = false, busy = false } = {}) {
  const { window: win } = page({ runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = win.document, input = qwen.composer(doc), send = qwen.sendButton(doc, input);
  const messages = [], listeners = [], timers = new Map();
  let now = 1000, nextTimer = 0, clicks = 0, leased = false;
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = win.setInterval = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
  win.clearTimeout = win.clearInterval = id => timers.delete(id);
  win.__adapter = qwen; win.__shared = shared;
  send.addEventListener('click', () => {
    clicks++;
    const prompt = input.value; input.value = '';
    user(doc, mismatch ? 'Unrelated private question' : prompt);
    answer(doc, '<p>Owned answer</p>');
    if (busy) send.querySelector('use').setAttribute('xlink:href', '#stop');
  });
  win.chrome = { runtime: {
    id: 'stage-fixture', getURL: path => `chrome-extension://stage-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'bridge:stage') {
        if (transport === 'reject') throw new Error('optional endpoint unavailable');
        if (transport === 'stall') return new Promise(() => {});
      }
      let data = {};
      if (message.type === 'bridge:poll') {
        data = { job: leased ? null : { id: 'stage-job', assistant: 'qwen', platform, conversationUrl: url, prompt: 'PRIVATE PROMPT', timeoutMs: 90000, images: [] } };
        leased = true;
      }
      return { ok: true, data };
    },
  } };
  win.eval(source); await flush();
  return {
    messages, get clicks() { return clicks; },
    async pulse(ms = 1000) {
      now += ms;
      for (const listener of listeners) listener({ type: 'bridge:wake' }, { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') });
      await flush();
    },
    close() { timers.clear(); win.close(); },
  };
}

for (const transport of ['success', 'reject', 'stall']) {
  test(`QQ stage reporting is bounded, private and does not block delivery: ${transport}`, async () => {
    const x = await fixture({ transport });
    try {
      for (let i = 0; i < 8; i++) await x.pulse();
      assert.equal(x.clicks, 1);
      const reports = x.messages.filter(message => message.type === 'bridge:stage');
      assert.deepEqual(reports.map(message => message.stage), ['submitting', 'submitted', 'first_output']);
      for (const message of reports) assert.deepEqual(Object.keys(message).sort(), ['conversationUrl', 'jobId', 'sessionId', 'stage', 'type']);
      assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
      assert.equal(x.messages.find(message => message.type === 'bridge:result').text, 'Owned answer');
      assert.equal(x.messages.some(message => message.type === 'bridge:error'), false);
    } finally { x.close(); }
  });
}

test('Feishu content performs no optional stage requests', async () => {
  const x = await fixture({ platform: 'feishu' });
  try {
    for (let i = 0; i < 8; i++) await x.pulse();
    assert.equal(x.clicks, 1);
    assert.equal(x.messages.some(message => message.type === 'bridge:stage'), false);
    assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
  } finally { x.close(); }
});

for (const option of ['mismatch', 'busy']) {
  test(`stage reporting preserves attribution and completion checks: ${option}`, async () => {
    const x = await fixture({ [option]: true });
    try {
      for (let i = 0; i < 8; i++) await x.pulse();
      assert.equal(x.clicks, 1);
      assert.equal(x.messages.some(message => message.stage === 'first_output'), false);
      assert.equal(x.messages.some(message => message.type === 'bridge:result'), false);
      if (option === 'mismatch') assert.equal(x.messages.some(message => message.stage === 'submitted'), false);
      await x.pulse(90000);
      assert.equal(x.messages.filter(message => message.type === 'bridge:error').length, 1);
      assert.equal(x.clicks, 1);
    } finally { x.close(); }
  });
}
