'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM edit_session_ops;
    DELETE FROM edit_sessions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0, restore_epoch = 0, last_restore_version_no = NULL;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

async function openSession(editor = '甲') {
  const r = await call('POST', '/api/editor/sessions', { body: { editor } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.session;
}

async function stageOps(sessionId, ops, expect = 201) {
  const r = await call('POST', `/api/editor/sessions/${sessionId}/ops`, { body: { ops } });
  assert.strictEqual(r.status, expect, JSON.stringify(r.json));
  return r.json;
}

async function commit(sessionId, expect = 200) {
  const r = await call('POST', `/api/editor/sessions/${sessionId}/commit`);
  assert.strictEqual(r.status, expect, JSON.stringify(r.json));
  return r.json;
}

// 发布当前草稿（每事件取其唯一 / 指定主张），再从该版恢复草稿；返回恢复响应。
async function publishAndRestore(selection) {
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '乙', note: '恢复用版本' },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  const pv = await call('GET', `/api/editor/restore-preview/${pub.json.versionNo}`);
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: pub.json.versionNo,
      draftRevisionNo: pv.json.draftRevisionNo,
      currentVersionNo: pv.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  return restored.json;
}

// ---------- 口令与可见性 ----------

test('会话接口需要编辑者口令；访客公开接口不含会话内容', async () => {
  for (const [method, url] of [
    ['POST', '/api/editor/sessions'],
    ['GET', '/api/editor/sessions'],
    ['GET', '/api/editor/sessions/1'],
    ['POST', '/api/editor/sessions/1/ops'],
    ['POST', '/api/editor/sessions/1/commit'],
  ]) {
    const r = await call(method, url, { token: null, body: {} });
    assert.strictEqual(r.status, 401, `${method} ${url}`);
    const bad = await call(method, url, { token: 'wrong', body: {} });
    assert.strictEqual(bad.status, 401);
  }
  // 访客接口没有会话路由
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.ok(!('sessions' in pub.json));
});

// ---------- 开启会话 ----------

test('开启会话：记录当时的草稿修订号与事件/主张/关系快照（基线只读）', async () => {
  const e1 = await makeEvent('动员会', '晒谷场');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const e2 = await makeEvent('通水会');
  const rid = await makeRel(e1, e2, '二人口述一致');
  const revBefore = (await getState()).draftRevisionNo;

  const s = await openSession('甲');
  assert.strictEqual(s.status, 'open');
  assert.strictEqual(s.baseRevisionNo, revBefore);
  assert.strictEqual(s.currentRevisionNo, revBefore);
  assert.strictEqual(s.baseline.counts.eventCount, 2);
  assert.strictEqual(s.baseline.counts.claimCount, 1);
  assert.strictEqual(s.baseline.counts.relationCount, 1);
  assert.strictEqual(s.baseline.events[0].claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(s.baseline.relations[0].id, rid);
  assert.deepStrictEqual(s.ops, []);
  assert.strictEqual(s.result, null);

  // 开启后草稿继续变化，基线保持不变
  await makeEvent('后来者');
  const detail = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(detail.json.session.baseline.counts.eventCount, 2);
  assert.strictEqual(detail.json.session.currentRevisionNo, revBefore + 1);
  assert.strictEqual(detail.json.session.baseRevisionNo, revBefore);

  // 列表
  const list = await call('GET', '/api/editor/sessions');
  assert.strictEqual(list.json.sessions.length, 1);
  assert.strictEqual(list.json.sessions[0].sessionId, s.sessionId);
  assert.strictEqual(list.json.sessions[0].opCount, 0);
  assert.strictEqual(list.json.draftRevisionNo, revBefore + 1);
});

// ---------- 暂存校验 ----------

test('暂存操作：沿用现有主张日期/出处/关系校验，问题整批列出并整批拒绝', async () => {
  const e1 = await makeEvent('事件一');
  const s = await openSession();

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/ops`, {
    body: {
      ops: [
        { op: 'create_claim', tempId: 'c1', eventId: e1, precision: 'day', year: 1958, month: 2, day: 30, source: 'x' }, // 日期非法
        { op: 'create_claim', tempId: 'c2', eventId: e1, precision: 'year', year: 1958, source: '' }, // 出处为空
        { op: 'create_relation', tempId: 'r1', earlierId: e1, laterId: e1 }, // 自环
        { op: 'update_event', eventId: 999, title: 'x' }, // 对象不在工作稿
        { op: 'create_claim', tempId: 'c3', eventId: e1, precision: 'year', year: 1958, source: '合法' }, // 合法
        { op: 'create_event', tempId: 'c3', title: '重复临时编号' }, // tempId 冲突（同批）
        { op: 'frobnicate' }, // 未知操作
      ],
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'SESSION_OPS_INVALID');
  assert.strictEqual(r.json.problems.length, 6);
  assert.ok(r.json.problems[0].message.includes('没有第 30 天'));
  assert.ok(r.json.problems.some((p) => p.message.includes('出处')));
  assert.ok(r.json.problems.some((p) => p.message.includes('不能先于自身')));
  assert.ok(r.json.problems.some((p) => p.message.includes('不在会话工作稿中')));
  assert.ok(r.json.problems.some((p) => p.message.includes('已被使用')));
  assert.ok(r.json.problems.some((p) => p.message.includes('未知操作类型')));

  // 整批拒绝：一条都没有暂存
  const detail = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(detail.json.session.ops.length, 0);

  // 非数组 / 空数组 → 400
  assert.strictEqual((await call('POST', `/api/editor/sessions/${s.sessionId}/ops`, { body: {} })).status, 400);
  assert.strictEqual((await call('POST', `/api/editor/sessions/${s.sessionId}/ops`, { body: { ops: [] } })).status, 400);
});

test('暂存操作：同批内可用临时编号引用新建对象；工作稿即时可见', async () => {
  const e1 = await makeEvent('旧事件');
  const s = await openSession();
  const r = await stageOps(s.sessionId, [
    { op: 'create_event', tempId: 'xin-1', title: '新事件', description: '会话内暂存' },
    { op: 'create_claim', tempId: 'c-1', eventRef: 'xin-1', precision: 'month', year: 1959, month: 5, source: '王秀兰口述' },
    { op: 'create_relation', tempId: 'r-1', earlierId: e1, laterRef: 'xin-1', source: '先后有序' },
    { op: 'update_event', eventId: e1, description: '改过的描述' },
  ]);
  assert.strictEqual(r.staged, 4);
  assert.strictEqual(r.opCount, 4);
  // 工作稿：2 事件（旧+新）、1 主张、1 关系
  assert.strictEqual(r.working.counts.eventCount, 2);
  assert.strictEqual(r.working.counts.claimCount, 1);
  assert.strictEqual(r.working.counts.relationCount, 1);
  const xin = r.working.events.find((e) => e.tempId === 'xin-1');
  assert.strictEqual(xin.claims[0].dateLabel, '1959 年 05 月');
  assert.strictEqual(r.working.relations[0].laterTempId, 'xin-1');

  // 暂存不写草稿
  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].description, '');
});

// ---------- 提交：无并发 ----------

test('提交成功：原子应用全部变更，返回新修订号与临时编号映射；修订号只推进一次', async () => {
  const e1 = await makeEvent('事件一', '旧描述');
  const e2 = await makeEvent('事件二');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '旧出处' });
  const revBefore = (await getState()).draftRevisionNo;

  const s = await openSession();
  await stageOps(s.sessionId, [
    { op: 'create_event', tempId: 'xin-1', title: '新事件' },
    { op: 'create_claim', tempId: 'c-1', eventRef: 'xin-1', precision: 'day', year: 1960, month: 1, day: 2, source: '新出处', note: '考异' },
    { op: 'create_relation', tempId: 'r-1', earlierId: e1, laterRef: 'xin-1' },
    { op: 'update_event', eventId: e1, description: '新描述' },
    { op: 'update_claim', claimId: c1, source: '改过的出处' },
    { op: 'delete_event', eventId: e2 },
  ]);

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.alreadyCommitted, false);
  assert.strictEqual(r.json.revisionNo, revBefore + 1); // 整次提交只推进一次
  assert.strictEqual(r.json.applied.eventsCreated, 1);
  assert.strictEqual(r.json.applied.claimsCreated, 1);
  assert.strictEqual(r.json.applied.relationsCreated, 1);
  assert.strictEqual(r.json.applied.eventsUpdated, 1);
  assert.strictEqual(r.json.applied.claimsUpdated, 1);
  assert.strictEqual(r.json.applied.eventsDeleted, 1);

  // 临时编号 → 正式编号映射
  const em = r.json.idMap.events.find((m) => m.tempId === 'xin-1');
  const cm = r.json.idMap.claims.find((m) => m.tempId === 'c-1');
  const rm = r.json.idMap.relations.find((m) => m.tempId === 'r-1');
  assert.ok(em.eventId > 0 && cm.claimId > 0 && rm.relationId > 0);
  assert.strictEqual(cm.eventId, em.eventId);

  // 草稿已应用全部变更
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revBefore + 1);
  assert.strictEqual(st.events.length, 2);
  const one = st.events.find((e) => e.id === e1);
  assert.strictEqual(one.description, '新描述');
  assert.strictEqual(one.claims[0].source, '改过的出处');
  const xin = st.events.find((e) => e.id === em.eventId);
  assert.strictEqual(xin.title, '新事件');
  assert.strictEqual(xin.claims[0].dateLabel, '1960 年 01 月 02 日');
  assert.strictEqual(xin.claims[0].intervalStart, '1960-01-02');
  assert.strictEqual(st.relations.length, 1);
  assert.strictEqual(st.relations[0].earlierId, e1);
  assert.strictEqual(st.relations[0].laterId, em.eventId);
});

// ---------- 提交幂等 ----------

test('重试同一提交不重复写入：返回首次结果与 alreadyCommitted', async () => {
  await makeEvent('事件一');
  const s = await openSession();
  await stageOps(s.sessionId, [{ op: 'create_event', tempId: 'x', title: '只应出现一次' }]);

  const first = await commit(s.sessionId);
  assert.strictEqual(first.alreadyCommitted, false);
  const revAfter = (await getState()).draftRevisionNo;

  const again = await commit(s.sessionId);
  assert.strictEqual(again.alreadyCommitted, true);
  assert.strictEqual(again.revisionNo, first.revisionNo);
  assert.deepStrictEqual(again.idMap, first.idMap);

  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revAfter); // 修订号未再推进
  assert.strictEqual(st.events.filter((e) => e.title === '只应出现一次').length, 1);

  // 已关闭会话不能再暂存
  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/ops`, {
    body: { ops: [{ op: 'create_event', tempId: 'y', title: 't' }] },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SESSION_NOT_OPEN');
});

// ---------- 三方合并：自动合并 ----------

test('彼此未触及的对象与字段自动合并，不覆盖另一人的改动', async () => {
  const e1 = await makeEvent('事件一', '原始描述');
  const e2 = await makeEvent('事件二');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '出处甲' });

  // 甲开会话，只改 e1 的 description
  const sa = await openSession('甲');
  await stageOps(sa.sessionId, [{ op: 'update_event', eventId: e1, description: '甲改的描述' }]);

  // 乙（直接改草稿）：改 e1 的 title、改 c1 的 source、删 e2、新增事件
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '乙改的标题', description: '原始描述' } });
  await call('PUT', `/api/editor/claims/${c1}`, {
    body: { precision: 'year', year: 1958, source: '乙改的出处' },
  });
  await call('DELETE', `/api/editor/events/${e2}`);
  const e3 = await makeEvent('乙新增的事件');

  const r = await commit(sa.sessionId);
  // 自动合并记录：e1 双方改了不同字段
  const am = r.autoMerged.find((m) => m.objectType === 'event' && m.id === e1);
  assert.deepStrictEqual(am.sessionFields, ['description']);
  assert.deepStrictEqual(am.otherFields, ['title']);

  const st = await getState();
  const one = st.events.find((e) => e.id === e1);
  assert.strictEqual(one.title, '乙改的标题'); // 乙的字段保留
  assert.strictEqual(one.description, '甲改的描述'); // 甲的字段生效
  assert.strictEqual(one.claims[0].source, '乙改的出处'); // 乙改的主张未被覆盖
  assert.ok(!st.events.some((e) => e.id === e2)); // 乙的删除保留
  assert.ok(st.events.some((e) => e.id === e3)); // 乙新增的事件保留
});

test('双方把同一字段改成相同值不冲突；双方都删除同一对象不冲突', async () => {
  const e1 = await makeEvent('旧标题');
  const e2 = await makeEvent('将被双方都删除');
  const s = await openSession();
  await stageOps(s.sessionId, [
    { op: 'update_event', eventId: e1, title: '殊途同归' },
    { op: 'delete_event', eventId: e2 },
  ]);
  // 对方：同样的标题改动 + 同样的删除
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '殊途同归', description: '' } });
  await call('DELETE', `/api/editor/events/${e2}`);

  const r = await commit(s.sessionId);
  const st = await getState();
  assert.strictEqual(st.events.find((e) => e.id === e1).title, '殊途同归');
  assert.ok(!st.events.some((e) => e.id === e2));
});

// ---------- 三方合并：冲突 ----------

test('同一字段被双方改成不同值 → 整次拒绝，逐项列出基线/当前值/拟提交值', async () => {
  const e1 = await makeEvent('基线标题');
  const e2 = await makeEvent('事件二');

  const s = await openSession();
  await stageOps(s.sessionId, [
    { op: 'update_event', eventId: e1, title: '甲拟提交的标题' },
    { op: 'delete_event', eventId: e2 }, // 即使有无冲突的操作，也整次拒绝
  ]);
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '乙改成的标题', description: '' } });
  const revBefore = (await getState()).draftRevisionNo; // 对方改动后的修订号

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(r.json.conflicts.length, 1);
  const c = r.json.conflicts[0];
  assert.strictEqual(c.type, 'field_conflict');
  assert.strictEqual(c.objectType, 'event');
  assert.strictEqual(c.id, e1);
  assert.deepStrictEqual(c.fields, [{ field: 'title', baseline: '基线标题', current: '乙改成的标题', proposed: '甲拟提交的标题' }]);
  assert.strictEqual(c.baseline.title, '基线标题');
  assert.strictEqual(c.current.title, '乙改成的标题');
  assert.strictEqual(c.proposed.title, '甲拟提交的标题');

  // 草稿未被会话改动（对方的修改原样保留，e2 未被删除）
  const st = await getState();
  assert.strictEqual(st.draftRevisionNo, revBefore);
  assert.strictEqual(st.events.find((e) => e.id === e1).title, '乙改成的标题');
  assert.ok(st.events.some((e) => e.id === e2));

  // 会话已关闭；重复提交返回同样的冲突（不重复写入）
  const again = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.alreadyConflicted, true);
  assert.strictEqual(again.json.conflicts.length, 1);
  assert.strictEqual((await getState()).draftRevisionNo, revBefore);
});

test('编辑与删除相撞：双方互撞均整次拒绝', async () => {
  // 情形一：会话修改，对方删除
  const e1 = await makeEvent('将被对方删除');
  const s1 = await openSession();
  await stageOps(s1.sessionId, [{ op: 'update_event', eventId: e1, title: '会话内修改' }]);
  await call('DELETE', `/api/editor/events/${e1}`);
  const r1 = await call('POST', `/api/editor/sessions/${s1.sessionId}/commit`);
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.json.conflicts[0].type, 'edit_delete');
  assert.strictEqual(r1.json.conflicts[0].sessionAction, 'update');
  assert.strictEqual(r1.json.conflicts[0].current, null);
  assert.strictEqual(r1.json.conflicts[0].proposed.title, '会话内修改');

  // 情形二：会话删除，对方修改
  const e2 = await makeEvent('将被会话删除');
  const s2 = await openSession();
  await stageOps(s2.sessionId, [{ op: 'delete_event', eventId: e2 }]);
  await call('PUT', `/api/editor/events/${e2}`, { body: { title: '对方改过的标题', description: '' } });
  const r2 = await call('POST', `/api/editor/sessions/${s2.sessionId}/commit`);
  assert.strictEqual(r2.status, 409);
  const c2 = r2.json.conflicts.find((c) => c.id === e2);
  assert.strictEqual(c2.type, 'edit_delete');
  assert.strictEqual(c2.sessionAction, 'delete');
  assert.strictEqual(c2.current.title, '对方改过的标题');
  assert.strictEqual(c2.proposed, null);
  assert.ok((await getState()).events.some((e) => e.id === e2)); // 未删除

  // 情形三：会话删除事件，对方在其上新增了主张（删除会丢弃对方新增内容）
  const e3 = await makeEvent('对方要补主张的事件');
  const s3 = await openSession();
  await stageOps(s3.sessionId, [{ op: 'delete_event', eventId: e3 }]);
  await makeClaim(e3, { precision: 'year', year: 1961, source: '对方新增的主张' });
  const r3 = await call('POST', `/api/editor/sessions/${s3.sessionId}/commit`);
  assert.strictEqual(r3.status, 409);
  const c3 = r3.json.conflicts.find((c) => c.id === e3);
  assert.strictEqual(c3.type, 'edit_delete');
  assert.strictEqual(c3.blockers.length, 1);
  assert.strictEqual(c3.blockers[0].objectType, 'claim');
  assert.ok((await getState()).events.some((e) => e.id === e3));
});

test('关系端点已删除：会话新增关系/主张引用对方已删除的事件 → 整次拒绝', async () => {
  const e1 = await makeEvent('保留的事件');
  const e2 = await makeEvent('将被对方删除');
  const s = await openSession();
  await stageOps(s.sessionId, [
    { op: 'create_relation', tempId: 'r1', earlierId: e1, laterId: e2, source: 'x' },
    { op: 'create_claim', tempId: 'c1', eventId: e2, precision: 'year', year: 1960, source: 'y' },
  ]);
  await call('DELETE', `/api/editor/events/${e2}`);

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.conflicts.length, 2);
  const relC = r.json.conflicts.find((c) => c.objectType === 'relation');
  assert.strictEqual(relC.type, 'endpoint_deleted');
  assert.strictEqual(relC.missingEventId, e2);
  assert.strictEqual(relC.proposed.laterId, e2);
  const claimC = r.json.conflicts.find((c) => c.objectType === 'claim');
  assert.strictEqual(claimC.type, 'endpoint_deleted');
  assert.strictEqual(claimC.missingEventId, e2);
  // 未写入任何内容
  assert.strictEqual((await getState()).relations.length, 0);
});

test('会话修改的主张被对方删除 → 编辑与删除相撞', async () => {
  const e1 = await makeEvent('事件一');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '原始出处' });
  const s = await openSession();
  await stageOps(s.sessionId, [{ op: 'update_claim', claimId: c1, source: '会话改的出处' }]);
  await call('DELETE', `/api/editor/claims/${c1}`);
  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.conflicts[0].type, 'edit_delete');
  assert.strictEqual(r.json.conflicts[0].objectType, 'claim');
  assert.strictEqual(r.json.conflicts[0].baseline.source, '原始出处');
  assert.strictEqual(r.json.conflicts[0].proposed.source, '会话改的出处');
});

// ---------- 恢复造成的对象身份更替（跨恢复提交整次拒绝） ----------

test('会话开启后草稿被从版本恢复：旧会话提交返回 identity_replaced 冲突，草稿不动且幂等', async () => {
  // 底稿：事件 A(#1)，甲在旧会话里只改 A 的描述
  const aId = await makeEvent('事件A', 'A 的原描述');
  const aClaim = await makeClaim(aId, { precision: 'year', year: 1958, source: '李宝山口述' });
  const s = await openSession('甲');
  assert.strictEqual(s.baseRestoreEpoch, 0);
  assert.strictEqual(s.currentRestoreEpoch, 0);
  await stageOps(s.sessionId, [{ op: 'update_event', eventId: aId, description: '甲改的 A 描述' }]);

  // 另一编辑者：删除 A、另建事件 B（#1），发布并从该版恢复草稿 → B 重新占用编号 1
  await call('DELETE', `/api/editor/events/${aId}`);
  const bId = await makeEvent('事件B', 'B 的描述');
  const bClaim = await makeClaim(bId, { precision: 'year', year: 1959, source: '王秀兰口述' });
  const restored = await publishAndRestore([{ eventId: bId, claimId: bClaim }]);
  const newB = restored.idMap.events[0].newEventId;
  assert.strictEqual(newB, 1); // 恢复后编号从 1 重新分配，B 占用了旧 A 的编号
  assert.strictEqual(restored.revisionNo, (await getState()).draftRevisionNo);

  // 旧会话提交：不得把 A 的描述写进 B，须整次拒绝
  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409, JSON.stringify(r.json));
  assert.strictEqual(r.json.code, 'SESSION_MERGE_CONFLICT');
  assert.strictEqual(r.json.conflicts.length, 1);
  const c = r.json.conflicts[0];
  assert.strictEqual(c.type, 'identity_replaced');
  assert.strictEqual(c.reason, 'draft_restored');
  assert.strictEqual(c.baseRestoreEpoch, 0);
  assert.strictEqual(c.currentRestoreEpoch, 1);
  assert.strictEqual(c.restoredFromVersionNo, 1);
  assert.ok(c.message.includes('恢复'));

  // 草稿一字未动：#1 仍是 B，描述没有被写成 A 的
  const st = await getState();
  assert.strictEqual(st.draftRestoreEpoch, 1);
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].id, 1);
  assert.strictEqual(st.events[0].title, '事件B');
  assert.strictEqual(st.events[0].description, 'B 的描述');
  assert.ok(!st.events.some((e) => e.description === '甲改的 A 描述'));

  // 会话已关闭；重复提交返回首次冲突结果，草稿仍不动（幂等）
  const again = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.alreadyConflicted, true);
  assert.strictEqual(again.json.conflicts[0].type, 'identity_replaced');
  const st2 = await getState();
  assert.strictEqual(st2.events[0].description, 'B 的描述');
  assert.strictEqual(st2.draftRevisionNo, st.draftRevisionNo);

  // 已关闭会话不能再暂存
  const ops = await call('POST', `/api/editor/sessions/${s.sessionId}/ops`, {
    body: { ops: [{ op: 'update_event', eventId: 1, description: 'x' }] },
  });
  assert.strictEqual(ops.status, 409);
  assert.strictEqual(ops.json.code, 'SESSION_NOT_OPEN');
});

test('身份代次跨多次恢复仍可辨认；会话详情与列表暴露代次与 restoreCrossed', async () => {
  const e1 = await makeEvent('事件A');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: '出处一' });
  const s = await openSession('甲');
  await stageOps(s.sessionId, [{ op: 'update_event', eventId: e1, title: '甲改A' }]);

  // 第一次恢复（A 仍在版中，编号恰好不变，但代次已推进）
  await publishAndRestore([{ eventId: e1, claimId: c1 }]);
  // 恢复后草稿仍可继续编辑并再发布、再恢复：第二次恢复
  const e2 = await makeEvent('事件C');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1960, source: '出处二' });
  const stateBefore = await getState();
  const pub2 = await call('POST', '/api/editor/publish', {
    // 第二次发布须以当前最新版本号 1 为基准
    body: {
      selection: [
        { eventId: 1, claimId: 1 },
        { eventId: e2, claimId: c2 },
      ],
      baseVersionNo: stateBefore.currentVersionNo,
      editor: '乙',
    },
  });
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  const pv2 = await call('GET', `/api/editor/restore-preview/${pub2.json.versionNo}`);
  const restored2 = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: pub2.json.versionNo,
      draftRevisionNo: pv2.json.draftRevisionNo,
      currentVersionNo: pv2.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored2.status, 200, JSON.stringify(restored2.json));

  const r = await call('POST', `/api/editor/sessions/${s.sessionId}/commit`);
  assert.strictEqual(r.status, 409);
  const c = r.json.conflicts[0];
  assert.strictEqual(c.type, 'identity_replaced');
  assert.strictEqual(c.baseRestoreEpoch, 0);
  assert.strictEqual(c.currentRestoreEpoch, 2);
  assert.strictEqual(c.restoredFromVersionNo, 2);

  // 会话详情与列表
  const detail = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(detail.json.session.baseRestoreEpoch, 0);
  assert.strictEqual(detail.json.session.currentRestoreEpoch, 2);
  assert.strictEqual(detail.json.session.status, 'conflicted');
  const list = await call('GET', '/api/editor/sessions');
  assert.strictEqual(list.json.draftRestoreEpoch, 2);
  const item = list.json.sessions.find((x) => x.sessionId === s.sessionId);
  assert.strictEqual(item.baseRestoreEpoch, 0);
  assert.strictEqual(item.currentRestoreEpoch, 2);
  assert.strictEqual(item.restoreCrossed, true);
  assert.strictEqual(item.conflictCount, 1);
});

test('恢复后基于最新草稿重开会话：新会话同代次，普通三方合并照常自动合并', async () => {
  // 旧会话跨恢复被拒
  const aId = await makeEvent('事件A', 'A 描述');
  const aClaim = await makeClaim(aId, { precision: 'year', year: 1958, source: '出处A' });
  const old = await openSession('甲');
  await stageOps(old.sessionId, [{ op: 'update_event', eventId: aId, description: '旧会话改的' }]);
  await call('DELETE', `/api/editor/events/${aId}`);
  const bId = await makeEvent('事件B', 'B 描述');
  const bClaim = await makeClaim(bId, { precision: 'year', year: 1959, source: '出处B' });
  await publishAndRestore([{ eventId: bId, claimId: bClaim }]);
  assert.strictEqual((await call('POST', `/api/editor/sessions/${old.sessionId}/commit`)).status, 409);

  // 恢复后重开会话：基线代次 = 当前代次
  const s2 = await openSession('甲（重开）');
  assert.strictEqual(s2.baseRestoreEpoch, 1);
  assert.strictEqual(s2.currentRestoreEpoch, 1);
  assert.strictEqual(s2.baseline.events[0].id, 1);
  assert.strictEqual(s2.baseline.events[0].title, '事件B');

  // 普通并行编辑：会话改描述，对方改标题 → 不同字段自动合并（既有规则不变）
  await stageOps(s2.sessionId, [{ op: 'update_event', eventId: 1, description: '甲在B上改的描述' }]);
  await call('PUT', '/api/editor/events/1', { body: { title: '事件B（乙改标题）', description: 'B 描述' } });
  const ok = await commit(s2.sessionId);
  const am = ok.autoMerged.find((m) => m.objectType === 'event' && m.id === 1);
  assert.deepStrictEqual(am.sessionFields, ['description']);
  assert.deepStrictEqual(am.otherFields, ['title']);
  const st = await getState();
  assert.strictEqual(st.events[0].title, '事件B（乙改标题）');
  assert.strictEqual(st.events[0].description, '甲在B上改的描述');
  assert.strictEqual(st.draftRestoreEpoch, 1); // 普通编辑不推进代次
});

test('恢复后重开的会话，普通同字段异值与编辑删除相撞仍按既有规则整次拒绝', async () => {
  const bId = await makeEvent('事件B', 'B 描述');
  const bClaim = await makeClaim(bId, { precision: 'year', year: 1959, source: '出处B' });
  await publishAndRestore([{ eventId: bId, claimId: bClaim }]); // 代次推进到 1

  // 同字段异值
  const s1 = await openSession('甲');
  await stageOps(s1.sessionId, [{ op: 'update_event', eventId: 1, title: '甲的标题' }]);
  await call('PUT', '/api/editor/events/1', { body: { title: '乙的标题', description: 'B 描述' } });
  const r1 = await call('POST', `/api/editor/sessions/${s1.sessionId}/commit`);
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.json.conflicts[0].type, 'field_conflict');

  // 编辑删除相撞：会话删除，对方修改
  const s2 = await openSession('甲');
  await stageOps(s2.sessionId, [{ op: 'delete_event', eventId: 1 }]);
  await call('PUT', '/api/editor/events/1', { body: { title: '乙又改的标题', description: 'B 描述' } });
  const r2 = await call('POST', `/api/editor/sessions/${s2.sessionId}/commit`);
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.json.conflicts[0].type, 'edit_delete');
  assert.ok((await getState()).events.some((e) => e.id === 1)); // 整次拒绝，未删除
});

test('未经历恢复的普通并行编辑：代次始终为 0，既有自动合并行为不变', async () => {
  const e1 = await makeEvent('事件一', '原始描述');
  const s = await openSession();
  assert.strictEqual(s.baseRestoreEpoch, 0);
  await stageOps(s.sessionId, [{ op: 'update_event', eventId: e1, description: '甲改的描述' }]);
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '乙改的标题', description: '原始描述' } });
  const ok = await commit(s.sessionId);
  assert.strictEqual(ok.restoreEpoch, 0);
  const st = await getState();
  assert.strictEqual(st.events.find((e) => e.id === e1).title, '乙改的标题');
  assert.strictEqual(st.events.find((e) => e.id === e1).description, '甲改的描述');
  // 列表项 restoreCrossed 为 false
  const list = await call('GET', '/api/editor/sessions');
  assert.strictEqual(list.json.sessions.find((x) => x.sessionId === s.sessionId).restoreCrossed, false);
});

// ---------- 冲突后重开会话 ----------

test('冲突后基于最新草稿重开会话：看到对方改动，重新暂存后提交成功', async () => {
  const e1 = await makeEvent('基线标题');
  const s1 = await openSession();
  await stageOps(s1.sessionId, [{ op: 'update_event', eventId: e1, title: '甲的标题' }]);
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '乙的标题', description: '' } });
  const conflict = await call('POST', `/api/editor/sessions/${s1.sessionId}/commit`);
  assert.strictEqual(conflict.status, 409);

  // 重开会话：基线含对方的最新改动
  const s2 = await openSession();
  assert.strictEqual(s2.baseline.events.find((e) => e.id === e1).title, '乙的标题');
  assert.strictEqual(s2.baseRevisionNo, (await getState()).draftRevisionNo);
  // 人工重编：在对方标题基础上只改描述
  await stageOps(s2.sessionId, [{ op: 'update_event', eventId: e1, description: '甲补充的描述' }]);
  const ok = await commit(s2.sessionId);
  assert.strictEqual(ok.alreadyCommitted, false);
  const st = await getState();
  assert.strictEqual(st.events.find((e) => e.id === e1).title, '乙的标题');
  assert.strictEqual(st.events.find((e) => e.id === e1).description, '甲补充的描述');
});

// ---------- 与现有功能共存 ----------

test('会话提交后的草稿可正常校验与发布，baseVersionNo 冲突规则不变', async () => {
  const s = await openSession();
  await stageOps(s.sessionId, [
    { op: 'create_event', tempId: 'a', title: '动员会' },
    { op: 'create_event', tempId: 'b', title: '通水会' },
    { op: 'create_claim', tempId: 'ca', eventRef: 'a', precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' },
    { op: 'create_claim', tempId: 'cb', eventRef: 'b', precision: 'month', year: 1959, month: 5, source: '王秀兰口述' },
    { op: 'create_relation', tempId: 'r', earlierRef: 'a', laterRef: 'b', source: '二人口述一致' },
  ]);
  const r = await commit(s.sessionId);
  const ea = r.idMap.events.find((m) => m.tempId === 'a').eventId;
  const eb = r.idMap.events.find((m) => m.tempId === 'b').eventId;
  const ca = r.idMap.claims.find((m) => m.tempId === 'ca').claimId;
  const cb = r.idMap.claims.find((m) => m.tempId === 'cb').claimId;

  const selection = [
    { eventId: ea, claimId: ca },
    { eventId: eb, claimId: cb },
  ];
  const val = await call('POST', '/api/editor/validate', { body: { selection } });
  assert.strictEqual(val.json.ok, true);

  const pub = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo: 0 } });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);

  // 过期基准仍 409（现有规则不变）
  const stale = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo: 0 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.code, 'VERSION_CONFLICT');

  // 访客可见已发布版本；会话内容不出现在公开接口
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.ok(!('sessions' in view.json));
});

test('会话内删除事件级联删除其主张与关系；对方未触及的删除正常生效', async () => {
  const e1 = await makeEvent('保留');
  const e2 = await makeEvent('将被会话删除');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1958, source: 'x' });
  const rid = await makeRel(e1, e2);
  const revBefore = (await getState()).draftRevisionNo;

  const s = await openSession();
  await stageOps(s.sessionId, [{ op: 'delete_event', eventId: e2 }]);
  const r = await commit(s.sessionId);
  assert.strictEqual(r.revisionNo, revBefore + 1);

  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].id, e1);
  assert.strictEqual(st.relations.length, 0);
  // 主张也随事件删除（库内核查）
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM claims WHERE id = ?').get(c2).n, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM relations WHERE id = ?').get(rid).n, 0);
});

test('空会话提交：无变更不推进修订号，同样幂等', async () => {
  await makeEvent('事件一');
  const revBefore = (await getState()).draftRevisionNo;
  const s = await openSession();
  const r = await commit(s.sessionId);
  assert.strictEqual(r.revisionNo, revBefore);
  assert.deepStrictEqual(r.idMap, { events: [], claims: [], relations: [] });
  const again = await commit(s.sessionId);
  assert.strictEqual(again.alreadyCommitted, true);
  assert.strictEqual((await getState()).draftRevisionNo, revBefore);
});

test('会话详情与列表展示状态流转；不存在的会话 404', async () => {
  const s = await openSession('乙');
  await stageOps(s.sessionId, [{ op: 'create_event', tempId: 'x', title: 't' }]);
  await commit(s.sessionId);

  const detail = await call('GET', `/api/editor/sessions/${s.sessionId}`);
  assert.strictEqual(detail.json.session.status, 'committed');
  assert.strictEqual(detail.json.session.result.revisionNo, (await getState()).draftRevisionNo);
  assert.strictEqual(detail.json.session.ops.length, 1);
  assert.ok(detail.json.session.closedAt);

  const list = await call('GET', '/api/editor/sessions');
  assert.strictEqual(list.json.sessions[0].status, 'committed');
  assert.strictEqual(list.json.sessions[0].opCount, 1);

  assert.strictEqual((await call('GET', '/api/editor/sessions/99')).status, 404);
  assert.strictEqual((await call('POST', '/api/editor/sessions/99/commit')).status, 404);
  assert.strictEqual((await call('GET', '/api/editor/sessions/abc')).status, 400);
});
