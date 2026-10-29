#!/usr/bin/env node
/* Mock OpenAI 兼容 LLM 服务（SSE 流式），供 AI 助手 E2E 与本地开发使用。
   用法：node web/tools/ai-mock-llm.js [端口]   （默认 18647，只绑 127.0.0.1）
   场景路由：按最新一条 user 消息里的关键字决定行为；工具轮回看 tool 结果续演。
   - 含「场景筛选」→ tool_call set_filter（标签[日记] + 大区间）→ 文本收尾
   - 含「场景问答」→ tool_call search_notes（query=搬家）→ 带 [[path]] 引用的文本
   - 含「场景写入」→ tool_call create_notes（一条带标签的笔记）
   - 含「场景修改」→ tool_call update_notes（path 从用户消息里解析）
   - 含「场景删除」→ tool_call delete_notes（path 从用户消息里解析）
   - 含「场景思考」→ 先 reasoning_content 流，再正文流（不调工具）
   - 含「场景慢速」→ 每字 300ms 慢流（测试停止按钮）
   - 其他 → 原样回声文本
   无工具参与的纯文本场景按 3 个增量分片下发，测试前端流式渲染。 */
'use strict';
const http = require('http');
const port = Number(process.argv[2]) || 18647;

function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function chunk(res, delta, finish) {
  sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }] });
}
async function streamText(res, text, opts) {
  opts = opts || {};
  chunk(res, { role: 'assistant' });
  if (opts.reasoning) {
    for (const piece of opts.reasoning.match(/[\s\S]{1,6}/g) || []) {
      chunk(res, { reasoning_content: piece });
      await sleep(opts.slow ? 60 : 15);
    }
  }
  const parts = opts.slow ? text.split('') : (text.match(/[\s\S]{1,8}/g) || []);
  for (const piece of parts) {
    chunk(res, { content: piece });
    await sleep(opts.slow ? 300 : 25);
  }
  chunk(res, {}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}
async function streamTool(res, name, args) {
  chunk(res, { role: 'assistant' });
  chunk(res, { tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: name, arguments: '' } }] });
  const s = JSON.stringify(args);
  for (const piece of s.match(/[\s\S]{1,10}/g) || []) {
    chunk(res, { tool_calls: [{ index: 0, function: { arguments: piece } }] });
    await sleep(10);
  }
  chunk(res, {}, 'tool_calls');
  res.write('data: [DONE]\n\n');
  res.end();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function findPaths(text) { return String(text || '').match(/micro\/\d{4}\/\d{2}\/[^\s，。;；"']+/g) || []; }
function firstPath(text) { const p = findPaths(text); return p.length ? p[0] : ''; }
function toolCallName(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      const asst = messages[i - 1];
      if (asst && asst.tool_calls && asst.tool_calls[0]) return asst.tool_calls[0].function.name;
    }
  }
  return '';
}
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return String(messages[i].content || '');
  return '';
}
function toolResultsSinceLastUser(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') break;
    if (messages[i].role === 'tool') out.unshift(String(messages[i].content || ''));
  }
  return out;
}

const server = http.createServer((req, res) => {
  /* 浏览器带 Authorization 头会触发 preflight（真实服务商都支持；mock 侧补齐） */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const p = req.url.split('?')[0].replace(/^\/v1/, '');
  if (p !== '/chat/completions') { res.writeHead(404); res.end('not found'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let msg = {};
    try { msg = JSON.parse(body || '{}'); } catch (_) {}
    const messages = msg.messages || [];
    const user = lastUserText(messages);
    const toolResults = toolResultsSinceLastUser(messages);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

    if (!toolResults.length) {
      if (user.includes('场景筛选')) return streamTool(res, 'set_filter', { tags: ['日记'], from: '2000-01-01', to: '2099-12-31' });
      if (user.includes('场景问答')) return streamTool(res, 'search_notes', { query: '搬家' });
      if (user.includes('场景写入')) return streamTool(res, 'create_notes', { notes: [{ text: 'AI 代写：mock 创建的测试笔记', tags: ['备忘'] }] });
      if (user.includes('场景修改')) {
        const p = firstPath(user);
        return p ? streamTool(res, 'update_notes', { items: [{ path: p, tags_add: ['收藏'] }] }) : streamText(res, '没有在消息里找到 path。');
      }
      if (user.includes('场景删除')) {
        const p = firstPath(user);
        return p ? streamTool(res, 'delete_notes', { paths: [p] }) : streamText(res, '没有在消息里找到 path。');
      }
      if (user.includes('场景思考')) return streamText(res, '这是带思考过程的回答正文。', { reasoning: '用户让我展示思考，我应该直接回答。' });
      if (user.includes('场景慢速')) return streamText(res, '这句话流式输出得很慢，适合测试停止按钮。', { slow: true });
      return streamText(res, '收到：「' + aiClip(user, 60) + '」');
    }
    /* 工具轮：按刚执行的工具续演 */
    const name = toolCallName(messages);
    const result = toolResults[toolResults.length - 1];
    if (name === 'set_filter') return streamText(res, '已按「日记」标签和时间区间完成筛选，请看左侧信息流。');
    if (name === 'search_notes') {
      const p = firstPath(result);
      return streamText(res, p ? '你在 [[' + p + ']] 里写过搬家的内容。' : '没有检索到相关笔记。');
    }
    if (name === 'create_notes') return streamText(res, '已创建 1 篇笔记（经你确认）。');
    if (name === 'update_notes') return streamText(res, '已修改，加了「收藏」标签。');
    if (name === 'delete_notes') return streamText(res, '已删除该笔记（git 历史可找回）。');
    return streamText(res, '工具执行完成。');
  });
});
function aiClip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
server.listen(port, '127.0.0.1', () => console.log('[ai-mock-llm] listening on http://127.0.0.1:' + port));
