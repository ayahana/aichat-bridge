import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup() {
  const dom = new JSDOM(html, { url: 'https://extension.invalid/options.html', runScripts: 'outside-only' });
  const { window } = dom, calls = [], intervals = [];
  const groups = { chatgpt: [{ chatId: 'a', name: 'Group A' }, { chatId: 'b', name: 'Group B' }], claude: [{ chatId: 'a', name: 'Claude A' }] };
  const platforms = {}, jobs = [];
  let rejectSave = false;
  window.setInterval = fn => { intervals.push(fn); };
  window.chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    const platform = message.platform || platforms[message.assistant] || 'qq';
    if (message.type === 'options:status') return { ok: true, data: { assistant: message.assistant, platform, enabled: true, channelEnabled: true, configured: true,
      connection: { state: 'connected' }, groups: groups[message.assistant] || [], jobs,
      platforms: { qq: { enabled: true }, feishu: { enabled: true } } } };
    if (message.type === 'options:tabs') return { ok: true, data: { tabs: [] } };
    if (message.type === 'options:moderation') return { ok: true, data: { words: [] } };
    if (message.type === 'options:platform') platforms[message.assistant] = message.platform;
    else if (message.type === 'options:group-policy') {
      if (rejectSave) return { ok: false, error: '保存被拒绝' };
      groups[message.assistant].find(group => group.chatId === message.chatId).policy = structuredClone(message.policy);
    } else throw new Error(`Unexpected RPC: ${message.type}`);
    return { ok: true, data: {} };
  } } };
  window.eval(source); await settle();
  const $ = id => window.document.getElementById(id);
  return { $, window, calls, groups, jobs, close: () => window.close(), reject() { rejectSave = true; },
    async change(id, value) { const node = $(id); if (node.type === 'checkbox') node.checked = value; else node.value = value; node.dispatchEvent(new window.Event('change', { bubbles: true })); await settle(); },
    async click(id) { $(id).click(); await settle(); },
    async poll() { intervals[0](); await settle(); },
    async submit() { $('group-policy-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); } };
}

test('QQ policy defaults are opt-in and platform capability is unknown until observed', async () => {
  const x = await setup();
  try {
    assert.equal(x.$('group-policy-section').hidden, false);
    assert.equal(x.$('policy-fields').disabled, true);
    await x.change('policy-group', 'a');
    for (const id of ['policy-enabled', 'policy-paused', 'policy-reply-to-bot', 'policy-context']) assert.equal(x.$(id).checked, false);
    assert.equal(x.$('policy-continuation').value, '0');
    assert.equal(x.$('policy-cooldown').value, '10');
    assert.equal(x.$('policy-max-pending').value, '3');
    assert.match(x.$('policy-capability').textContent, /未知/);
    assert.match(x.$('group-policy-section').textContent, /取得群成员同意/);
    x.groups.chatgpt[0].ordinaryObservedAt = Date.now();
    await x.poll();
    assert.match(x.$('policy-capability').textContent, /曾实际观察到/);
    assert.match(x.$('policy-capability').textContent, /不代表当前权限/);
  } finally { x.close(); }
});

test('policy drafts survive polling, group switching and assistant switching with strict scope', async () => {
  const x = await setup();
  try {
    await x.change('policy-group', 'a');
    await x.change('policy-nicknames', '小助手\nHelper');
    await x.change('policy-context', true);
    await x.poll();
    assert.equal(x.$('policy-nicknames').value, '小助手\nHelper');
    await x.change('policy-group', 'b');
    assert.equal(x.$('policy-context').checked, false);
    await x.change('policy-group', 'a');
    assert.equal(x.$('policy-context').checked, true);
    await x.click('view-claude');
    assert.equal(x.$('policy-nicknames').value, '');
    await x.click('view-chatgpt');
    assert.equal(x.$('policy-nicknames').value, '小助手\nHelper');
    await x.change('policy-enabled', true);
    await x.change('policy-paused', true);
    await x.change('policy-reply-to-bot', true);
    await x.change('policy-continuation', '45');
    await x.change('policy-cooldown', '12');
    await x.change('policy-max-pending', '4');
    await x.submit();
    const saved = x.calls.find(call => call.type === 'options:group-policy');
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), { type: 'options:group-policy', assistant: 'chatgpt', platform: 'qq', chatId: 'a', policy: {
      enabled: true, paused: true, replyToBot: true, contextEnabled: true, continuationSeconds: 45, cooldownSeconds: 12, maxPending: 4, nicknames: ['小助手', 'Helper']
    } });
    assert.match(x.$('policy-save-state').textContent, /已保存/);
  } finally { x.close(); }
});

test('invalid numeric policy never saves; a rejected save retains the draft', async () => {
  const x = await setup();
  try {
    await x.change('policy-group', 'a');
    for (const [id, value] of [['policy-continuation', '121'], ['policy-cooldown', '-1'], ['policy-max-pending', '1.5']]) {
      const old = x.$(id).value;
      await x.change(id, value); await x.submit();
      assert.equal(x.calls.some(call => call.type === 'options:group-policy'), false);
      assert.match(x.$('feedback').textContent, /整数/);
      await x.change(id, old);
    }
    x.reject(); await x.change('policy-nicknames', '保留草稿'); await x.submit(); await x.poll();
    assert.match(x.$('feedback').textContent, /保存被拒绝/);
    assert.equal(x.$('policy-nicknames').value, '保留草稿');
    assert.match(x.$('policy-save-state').textContent, /未保存/);
  } finally { x.close(); }
});

test('Feishu hides and disables QQ policy settings and keeps reply-style controls', async () => {
  const x = await setup();
  try {
    await x.change('policy-group', 'a');
    await x.click('view-platform-feishu');
    assert.equal(x.$('group-policy-section').hidden, true);
    assert.equal(x.$('policy-fields').disabled, true);
    assert.equal(x.$('save-group-policy').disabled, true);
    assert.equal(x.$('reply-style-section').hidden, false);
    await x.submit();
    assert.equal(x.calls.some(call => call.type === 'options:group-policy'), false);
  } finally { x.close(); }
});


test('job diagnostics label verified stages honestly and show absent timings as unknown', async () => {
  const x = await setup();
  try {
    x.jobs.push({ id: 'queued', chatId: 'a', state: 'queued', createdAt: Date.now(), diagnostics: { remainingMs: 120000 } });
    await x.poll();
    assert.match(x.$('jobs').textContent, /领取任务：未知/);
    assert.match(x.$('jobs').textContent, /排队耗时：未知/);
    assert.match(x.$('jobs').textContent, /剩余处理时间：120.0 秒/);
    x.jobs[0].state = 'started';
    x.jobs[0].diagnostics = { leasedAt: Date.now(), startedAt: Date.now(), queueWaitMs: 2300, remainingMs: 60000, stages: { submitting: Date.now(), submitted: Date.now(), first_output: Date.now() } };
    await x.poll();
    assert.match(x.$('jobs').textContent, /排队耗时：2.3 秒/);
    assert.match(x.$('jobs').textContent, /首次完整候选（非首 token）/);
    assert.match(x.$('jobs').textContent, /提交确认以网页中匹配到用户提问为准，不是仅点击发送/);
  } finally { x.close(); }
});
