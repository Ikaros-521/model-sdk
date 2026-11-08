'use strict';
const $ = id => document.getElementById(id);
const state = { providers: [], history: [], signature: '', credentialEpoch: 0, busy: false, controller: null, events: [], result: null, started: 0, timer: null, blocks: new Map() };
const labels = { dashscope: '阿里云百炼 · DashScope', 'dashscope-anthropic': '阿里云百炼 · Anthropic 协议', 'qwen-token-plan': 'Qwen Token Plan · 国际套餐', 'qwen-token-plan-cn': 'Qwen Token Plan · 中国套餐', 'qwen-token-plan-individual': 'Qwen Token Plan · 个人套餐', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', deepseek: 'DeepSeek', 'moonshotai-cn': '月之暗面 · 中国', 'moonshotai': '月之暗面', 'zai': '智谱 GLM', 'zai-coding-cn': '智谱 Coding · 中国', 'minimax-cn': 'MiniMax · 中国', openrouter: 'OpenRouter', groq: 'Groq', azure: 'Azure OpenAI', 'amazon-bedrock': 'Amazon Bedrock' };
function notice(message = '', error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function safe(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const key = $('api-key').value;
  if (key) for (const secret of new Set([key, encodeURIComponent(key)])) text = text.split(secret).join('[REDACTED]');
  return text;
}
function config() { return { mode: $('mode').value, provider: $('provider').value, protocol: $('protocol').value, baseURL: $('base-url').value.trim(), model: $('model').value.trim(), apiKey: $('api-key').value }; }
function valid(discovery = false) {
  if (!$('api-key').value.trim()) { $('api-key').focus(); throw new Error('请先输入 API Key。'); }
  if (!discovery && !$('model').value.trim()) { $('model').focus(); throw new Error('请选择或输入模型 ID。'); }
  if ($('mode').value === 'custom') { const url = new URL($('base-url').value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含账号、查询参数的 HTTP(S) API 根地址。'); }
}
function modelsForSelection() { return state.providers.find(p => p.id === $('provider').value)?.models ?? []; }
function fillModels(models, selectFirst = false) {
  $('model-options').replaceChildren(...models.map(model => { const option = document.createElement('option'); option.value = model.id; option.label = model.name || model.id; return option; }));
  if (selectFirst && models.length) $('model').value = models[0].id;
  $('model-hint').textContent = models.length ? `${models.length} 个候选模型 · 可直接输入其他模型 ID` : '手动输入模型 ID，或点击 ↻ 从端点发现。';
}
function updateMode() {
  const mode = $('mode').value;
  $('provider-field').hidden = mode !== 'catalog'; $('protocol-field').hidden = mode !== 'custom'; $('endpoint-field').hidden = mode === 'catalog';
  $('base-url').placeholder = mode === 'deepseek' ? '默认 https://api.deepseek.com/anthropic' : 'https://api.example.com/v1';
  if (mode === 'catalog') fillModels(modelsForSelection(), true);
  else { $('model').value = mode === 'deepseek' ? 'deepseek-v4-flash' : ''; fillModels([]); }
  notice();
}
function busy(value) {
  state.busy = value;
  for (const element of $('config-form').querySelectorAll('input, select, button, textarea')) element.disabled = value;
  $('send').disabled = value; $('clear').disabled = value; $('stream').disabled = value; $('stop').hidden = !value;
  if (!value) { clearInterval(state.timer); state.controller = null; }
}
function metrics(status, usage) {
  $('metric-status').textContent = status;
  const number = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  const input = usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined;
  $('metric-input').textContent = number(input); $('metric-output').textContent = number(usage?.outputTokens); $('metric-total').textContent = number(usage?.totalTokens);
}
function diagnostics() {
  $('event-count').textContent = `${state.events.length} 条事件（最多保留 200 条）`;
  $('raw').textContent = safe({ result: state.result, events: state.events });
}
function turn(role, text = '') {
  $('empty').hidden = true;
  const article = document.createElement('article'); article.className = `turn ${role}`;
  const header = document.createElement('div'); header.className = 'turn-head'; header.textContent = role === 'user' ? 'YOU / 测试输入' : `MODEL / ${$('model').value}`;
  const body = document.createElement('div'); body.className = 'turn-body'; body.textContent = text;
  article.append(header, body); $('conversation').append(article); scroll(); return { article, body };
}
function scroll() { $('conversation').scrollTop = $('conversation').scrollHeight; }
function renderBlocks(target) {
  target.body.textContent = [...state.blocks.values()].filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  const reasoning = [...state.blocks.values()].filter(b => b.type === 'reasoning').map(b => b.text ?? '').join('');
  let details = target.article.querySelector('.reasoning');
  if (reasoning) {
    if (!details) { details = document.createElement('details'); details.className = 'reasoning'; const summary = document.createElement('summary'); summary.textContent = '推理过程'; details.append(summary, document.createElement('div')); target.article.insertBefore(details, target.body); }
    details.lastChild.textContent = reasoning;
  }
  let tools = target.article.querySelector('.tool-result');
  const calls = [...state.blocks.values()].filter(b => b.type === 'tool-call');
  if (calls.length) { if (!tools) { tools = document.createElement('div'); tools.className = 'tool-result'; target.article.append(tools); } tools.textContent = safe({ note: '检测到工具调用：本测试台不执行工具。', calls }); }
  scroll();
}
function event(chunk, target) {
  if (state.events.length < 200) state.events.push(chunk);
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') { const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'; const block = state.blocks.get(chunk.index) ?? { type, text: '' }; block.text += chunk.text; state.blocks.set(chunk.index, block); renderBlocks(target); }
  else if (chunk.type === 'block-end') { state.blocks.set(chunk.index, chunk.block); renderBlocks(target); }
  else if (chunk.type === 'usage') metrics('生成中', chunk.usage);
  else if (chunk.type === 'result') state.result = chunk.result;
  diagnostics();
}
async function request(path, body, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-model-sdk-playground': '1' }, body: JSON.stringify(body), signal });
  if (!response.ok) { let error; try { error = await response.json(); } catch {} const rejected = error?.error?.rejectedHeaders; throw new Error(`${error?.error?.message ?? error?.message ?? `请求失败：HTTP ${response.status}`}${rejected?.length ? `（被拒请求头：${rejected.join('、')}）` : ''}`); }
  return response;
}
async function readStream(response, target) {
  if (!response.body) throw new Error('服务未返回响应流。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try { while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); if (buffer.length > 4 * 1024 * 1024) throw new Error('单条流事件超出测试台限制。'); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) event(JSON.parse(line), target); } } buffer += decoder.decode(); if (buffer.trim()) event(JSON.parse(buffer), target); }
  finally { reader.releaseLock(); }
  if (!state.result) throw new Error('响应流结束，但未收到最终结果。');
}
$('message-form').addEventListener('submit', async e => {
  e.preventDefault(); if (state.busy) return;
  const text = $('prompt').value.trim(); if (!text) return;
  try { valid(); } catch (error) { notice(error.message, true); return; }
  const current = config(); const { apiKey: _key, ...connection } = current; const signature = JSON.stringify([connection, state.credentialEpoch, $('system').value, $('reasoning').value]);
  if (state.signature && signature !== state.signature) { state.history = []; notice('连接或系统配置已变更，本次调用已开始新的上下文。'); } else notice();
  state.signature = signature;
  const user = { role: 'user', content: [{ type: 'text', text }] };
  const messages = [...state.history, user];
  turn('user', text); const target = turn('assistant'); target.article.classList.add('pending'); $('prompt').value = '';
  state.events = []; state.result = null; state.blocks = new Map(); state.started = performance.now(); state.controller = new AbortController(); busy(true); metrics('生成中'); diagnostics();
  state.timer = setInterval(() => { $('metric-time').textContent = `${((performance.now() - state.started) / 1000).toFixed(1)} s`; }, 100);
  try {
    const response = await request('/api/generate', { config: current, messages, system: $('system').value.trim() || undefined, stream: $('stream').checked, maxTokens: Number($('max-tokens').value), timeoutMs: Number($('timeout').value) * 1000, reasoningEffort: $('reasoning').value || undefined }, state.controller.signal);
    if ($('stream').checked) await readStream(response, target); else state.result = await response.json();
    const result = state.result; state.blocks = new Map((result.message?.content ?? []).map((block, i) => [i, block])); renderBlocks(target); diagnostics();
    const finish = result.finish?.kind; const failed = finish === 'error' || finish === 'aborted';
    metrics(failed ? (finish === 'aborted' ? '已取消' : '调用失败') : finish === 'max-tokens' ? '输出截断' : '调用成功', result.usage);
    if (failed) { const failure = result.finish?.failure; notice(`${safe(failure?.message ?? '模型调用未完成，请展开调用诊断查看。')}${Number.isInteger(failure?.status) ? `（上游 HTTP ${failure.status}）` : ''}`, true); }
    if (finish === 'tool-calls') notice('模型返回了工具调用。本测试台只展示、不执行工具；下次输入会重新开始上下文。');
    if (finish === 'stop') state.history = [...messages, result.message]; else state.history = [];
    if (!target.body.textContent && !target.article.querySelector('.tool-result')) target.body.textContent = failed ? '本次调用未返回可用正文。' : '模型未返回文本内容，请查看诊断。';
  } catch (error) {
    const cancelled = error.name === 'AbortError'; metrics(cancelled ? '已取消' : '调用失败'); notice(cancelled ? '已停止本地等待。远端可能仍在计算或计费。' : safe(error.message), !cancelled);
    if (!target.body.textContent) target.body.textContent = cancelled ? '已停止生成。' : '调用未完成。';
    state.events.push({ type: cancelled ? 'cancelled' : 'client-error', message: safe(error.message) }); diagnostics();
  } finally { target.article.classList.remove('pending'); $('metric-time').textContent = `${((performance.now() - state.started) / 1000).toFixed(2)} s`; busy(false); $('prompt').focus(); }
});
$('discover').addEventListener('click', async () => {
  if (state.busy) return;
  try { valid(true); } catch (error) { notice(error.message, true); return; }
  busy(true); state.controller = new AbortController(); metrics('发现模型'); notice('正在读取模型列表，不会发起推理调用。');
  try { const response = await request('/api/discover', { config: config() }, state.controller.signal); const data = await response.json(); fillModels(data.models ?? []); notice(`已读取 ${data.models?.length ?? 0} 个模型。可在模型 ID 中选择或手动输入。`); metrics('发现完成'); }
  catch (error) { notice(error.name === 'AbortError' ? '已取消模型发现。' : safe(error.message), error.name !== 'AbortError'); metrics('发现未完成'); }
  finally { busy(false); }
});
$('stop').addEventListener('click', () => state.controller?.abort());
$('toggle-key').addEventListener('click', () => { const shown = $('api-key').type === 'password'; $('api-key').type = shown ? 'text' : 'password'; $('toggle-key').textContent = shown ? '隐藏' : '显示'; $('toggle-key').setAttribute('aria-label', shown ? '隐藏密钥' : '显示密钥'); $('toggle-key').setAttribute('aria-pressed', String(shown)); });
$('api-key').addEventListener('input', () => { state.credentialEpoch++; });
$('mode').addEventListener('change', updateMode);
$('provider').addEventListener('change', () => { fillModels(modelsForSelection(), true); notice(); });
$('clear').addEventListener('click', () => { state.history = []; state.signature = ''; state.events = []; state.result = null; $('conversation').querySelectorAll('.turn').forEach(n => n.remove()); $('empty').hidden = false; metrics('待开始'); $('metric-time').textContent = '—'; diagnostics(); notice(); });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('raw').textContent); notice('诊断已复制（密钥已脱敏）。'); } catch { notice('无法访问剪贴板，请手动选择诊断内容复制。', true); } });
$('prompt').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('message-form').requestSubmit(); } });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }));
window.addEventListener('pagehide', () => { state.controller?.abort(); $('api-key').value = ''; state.history = []; });
(async () => {
  try { const response = await fetch('/api/catalog'); if (!response.ok) throw new Error(`目录加载失败：HTTP ${response.status}`); const data = await response.json(); state.providers = data.providers ?? []; const priority = ['dashscope', 'dashscope-anthropic', 'deepseek', 'openai', 'anthropic', 'google', 'moonshotai-cn', 'zai', 'openrouter']; state.providers.sort((a, b) => { const rank = id => priority.includes(id) ? priority.indexOf(id) : 100; return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id); }); $('provider').replaceChildren(...state.providers.map(provider => { const option = document.createElement('option'); option.value = provider.id; option.textContent = labels[provider.id] ?? provider.id; return option; })); $('provider').disabled = false; $('provider-count').textContent = `/ ${state.providers.length} 个平台`; fillModels(modelsForSelection(), true); }
  catch (error) { notice(safe(error.message), true); $('mode').value = 'custom'; updateMode(); notice('平台目录暂不可用，仍可使用自定义端点。', true); }
})();
