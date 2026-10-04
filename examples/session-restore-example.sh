#!/usr/bin/env bash
# 「从版本恢复」造成对象身份更替时，并行编辑会话的端到端调用示例（本轮修复）。
#
# 场景复现题目中的事故链：
#   1) 编辑会话基线含事件 A（编号 1）；甲在会话里只改 A 的描述（暂存、未提交）
#   2) 另一编辑者删除 A、创建事件 B，发布后从该版恢复草稿——B 重新占用编号 1
#   3) 旧会话提交：修复前会把 A 的描述错误写进 B；
#      修复后返回 409 SESSION_MERGE_CONFLICT，冲突项 type=identity_replaced，
#      草稿一字未动；重复提交返回首次冲突（alreadyConflicted:true）
#   4) 恢复返回的 idMap 标明旧→新编号；会话列表 restoreCrossed=true 可辨认
#   5) 基于恢复后的草稿重开会话：普通并行编辑规则不变——
#      不同字段自动合并；同字段异值、编辑删除相撞仍整次拒绝
#   6) 已发布快照与访客年表不受影响（访客仍能读到第 1 版）
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/session-restore-example.sh
# 可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
put() { curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 取当前草稿 #1 的描述（PUT 事件须同时给 title/description，用它保住未触及字段）
desc1() { get_ed "$BASE/api/editor/state" | jfield 'd.events.find(e=>e.id===1).description'; }

say "1) 建底稿：事件 A（编号 1）与一条主张"
A=$(post "$BASE/api/editor/events" -d '{"title":"事件A（旧编号1）'$TS'","description":"A 的原描述"}' | jfield 'd.event.id')
CA=$(post "$BASE/api/editor/events/$A/claims" \
  -d '{"precision":"year","year":1958,"source":"李宝山口述 '$TS'"}' | jfield 'd.claim.id')
EPOCH0=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRestoreEpoch')
echo "事件 A=#$A，主张 #$CA，当前身份代次 restoreEpoch=$EPOCH0"
[ "$A" = 1 ] || { echo "FAIL：空库起步 A 应为 #1"; exit 1; }

say "2) 甲开启编辑会话，只暂存「改 A 的描述」（不提交、不写草稿）"
S=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲","note":"跨恢复旧会话 '$TS'"}')
SID=$(echo "$S" | jfield 'd.session.sessionId')
echo "$S" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`旧会话 #${d.session.sessionId}：baseRevisionNo=${d.session.baseRevisionNo}，baseRestoreEpoch=${d.session.baseRestoreEpoch}`);'
post "$BASE/api/editor/sessions/$SID/ops" -d '{"ops":[
  {"op":"update_event","eventId":1,"description":"甲只改在 A 上的描述 '$TS'"}
]}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log(`已暂存 ${d.staged} 条；草稿尚未变化。`);'

say "3) 另一编辑者：删除 A → 创建 B → 发布 → 从该版恢复草稿（B 重新占用编号 1）"
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/events/$A" >/dev/null
B=$(post "$BASE/api/editor/events" -d '{"title":"事件B（恢复后占用编号1）'$TS'","description":"B 的描述"}' | jfield 'd.event.id')
CB=$(post "$BASE/api/editor/events/$B/claims" \
  -d '{"precision":"year","year":1959,"source":"王秀兰口述 '$TS'"}' | jfield 'd.claim.id')
VNO=$(post "$BASE/api/editor/publish" -d "{
  \"selection\":[{\"eventId\":$B,\"claimId\":$CB}],
  \"baseVersionNo\":0,\"editor\":\"乙\",\"note\":\"删除A、以B发布 '$TS'\"
}" | jfield 'd.versionNo')
echo "乙发布第 $VNO 版（只含 B，B 的草稿编号为 #$B）"
PV=$(get_ed "$BASE/api/editor/restore-preview/$VNO")
REST=$(post "$BASE/api/editor/restore" -d "{
  \"versionNo\":$VNO,
  \"draftRevisionNo\":$(echo "$PV" | jfield 'd.draftRevisionNo'),
  \"currentVersionNo\":$(echo "$PV" | jfield 'd.currentVersionNo')
}")
echo "$REST" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const m=d.idMap.events[0];
console.log(`恢复完成：事件旧#${m.oldEventId} → 新#${m.newEventId}；新草稿修订号 ${d.revisionNo}`);
if(m.newEventId!==1){console.error("FAIL：恢复后 B 应重新占用编号 1");process.exit(1)}
console.log("事件编号映射：", d.idMap.events.map(x=>`事件旧#${x.oldEventId}→新#${x.newEventId}`).join(", "));
console.log("主张编号映射：", d.idMap.events.map(x=>`主张旧#${x.oldClaimId}→新#${x.newClaimId}`).join(", "));
console.log("关系编号映射条数：", d.idMap.relations.length);'
EPOCH1=$(get_ed "$BASE/api/editor/state" | jfield 'd.draftRestoreEpoch')
[ "$EPOCH1" = "$((EPOCH0+1))" ] && echo "OK：恢复把身份代次 $EPOCH0 → $EPOCH1（普通编辑不会推进）" || { echo "FAIL：代次应为 $((EPOCH0+1))，实际 $EPOCH1"; exit 1; }

say "4) 旧会话提交：必须整次拒绝（409 identity_replaced），A 的描述不得写进 B"
code=$(http_code -X POST "${h_ed[@]}" "$BASE/api/editor/sessions/$SID/commit")
[ "$code" = 409 ] && echo "OK：HTTP 409" || { echo "FAIL：期望 409，实际 $code"; exit 1; }
post "$BASE/api/editor/sessions/$SID/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.code!=="SESSION_MERGE_CONFLICT"){console.error(JSON.stringify(d));process.exit(1)}
const c=d.conflicts[0];
console.log(`code=${d.code}，冲突类型=${c.type}，原因=${c.reason}`);
console.log(`身份代次：基线 ${c.baseRestoreEpoch} → 当前 ${c.currentRestoreEpoch}，最近恢复自第 ${c.restoredFromVersionNo} 版`);
console.log("说明：", c.message);
if(c.type!=="identity_replaced"||c.reason!=="draft_restored"||c.restoredFromVersionNo!==1) process.exit(1);'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.id===1);
console.log(`当前草稿 #1：「${e.title}」描述=「${e.description}」`);
if(!e.title.includes("事件B")||e.description!=="B 的描述"){console.error("FAIL：A 的描述被错误写进 B！");process.exit(1)}
console.log("OK：#1 仍是恢复后的 B，描述未被旧会话污染；整次拒绝、草稿一字未动");'

say "5) 重复提交：会话已关闭，返回首次冲突结果，不重复写入"
post "$BASE/api/editor/sessions/$SID/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.alreadyConflicted||d.conflicts[0].type!=="identity_replaced"){console.error(JSON.stringify(d));process.exit(1)}
console.log(`OK：alreadyConflicted=${d.alreadyConflicted}，冲突类型仍为 identity_replaced`);'
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/sessions/$SID/ops" \
  -d '{"ops":[{"op":"update_event","eventId":1,"description":"x"}]}')
[ "$code" = 409 ] && echo "OK：已关闭会话不能再暂存 → 409 SESSION_NOT_OPEN" || { echo "FAIL：期望 409，实际 $code"; exit 1; }

say "6) 会话详情 / 列表可辨认：restoreCrossed=true、代次字段"
get_ed "$BASE/api/editor/sessions" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const it=d.sessions.find(s=>s.editor.includes("甲")&&s.note.includes("跨恢复旧会话"));
console.log(`列表：当前 draftRestoreEpoch=${d.draftRestoreEpoch}；旧会话 baseRestoreEpoch=${it.baseRestoreEpoch}，restoreCrossed=${it.restoreCrossed}，conflictCount=${it.conflictCount}`);
if(it.restoreCrossed!==true) process.exit(1);'

say "7) 基于恢复后的最新草稿重开会话：不同字段仍自动合并（既有三方合并不变）"
S2=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲（重开）"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$S2/ops" -d '{"ops":[
  {"op":"update_event","eventId":1,"description":"甲在 B 上补充的描述 '$TS'"}
]}' >/dev/null
# 对方（直接编辑）同时改标题；描述保持恢复后的值
put "$BASE/api/editor/events/1" -d "{\"title\":\"事件B（乙改标题）$TS\",\"description\":\"$(desc1)\"}" >/dev/null
post "$BASE/api/editor/sessions/$S2/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error(JSON.stringify(d));process.exit(1)}
console.log("重开会话提交成功，自动合并记录：", JSON.stringify(d.autoMerged));'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=d.events.find(x=>x.id===1);
console.log(`合并后 #1：标题=「${e.title}」（乙改的），描述=「${e.description}」（甲改的）`);
if(!e.title.includes("乙改标题")||!e.description.includes("甲在 B 上补充")) process.exit(1);
if(d.draftRestoreEpoch!==1){console.error("FAIL：普通编辑不应推进身份代次");process.exit(1)}'

say "8) 恢复后同字段异值、编辑删除相撞仍按既有规则整次拒绝"
S3=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$S3/ops" -d "{\"ops\":[{\"op\":\"update_event\",\"eventId\":1,\"title\":\"甲拟标题 $TS\"}]}" >/dev/null
put "$BASE/api/editor/events/1" -d "{\"title\":\"乙拟标题 $TS\",\"description\":\"$(desc1)\"}" >/dev/null
post "$BASE/api/editor/sessions/$S3/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.status!==409||d.conflicts[0].type!=="field_conflict"){console.error(JSON.stringify(d));process.exit(1)}
console.log("OK：同字段异值 → 409 field_conflict（", d.conflicts[0].message, "）");'

S4=$(post "$BASE/api/editor/sessions" -d '{"editor":"甲"}' | jfield 'd.session.sessionId')
post "$BASE/api/editor/sessions/$S4/ops" -d '{"ops":[{"op":"delete_event","eventId":1}]}' >/dev/null
put "$BASE/api/editor/events/1" -d "{\"title\":\"乙又改标题 $TS\",\"description\":\"$(desc1)\"}" >/dev/null
post "$BASE/api/editor/sessions/$S4/commit" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.status!==409||d.conflicts[0].type!=="edit_delete"){console.error(JSON.stringify(d));process.exit(1)}
console.log("OK：会话删除 vs 对方修改 → 409 edit_delete；事件保留，草稿未动");'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`草稿仍含 #1：${d.events.some(e=>e.id===1)}，事件数=${d.events.length}`);
if(!d.events.some(e=>e.id===1)) process.exit(1);'

say "9) 已发布快照与访客年表保持兼容：访客仍读到第 $VNO 版的 B"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.published||d.currentVersionNo!==1){console.error(JSON.stringify(d));process.exit(1)}
const t=d.version.events[0].title;
console.log(`访客年表 currentVersionNo=${d.currentVersionNo}，首个事件=「${t}」（不含任何会话信息：${!("sessions" in d)}）`);
if(!t.includes("事件B")) process.exit(1);'

say "全部断言通过 ✅"
echo "提示：跨恢复的旧会话不可继续提交；请对照恢复响应的 idMap，在恢复后的草稿上重开会话。"
