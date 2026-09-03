/**
 * The agent workflow protocol text served as a system-prompt section — a
 * behavioral contract, not a feature ad: board columns, status meanings,
 * claim/version discipline, review handoff, and the human-only acceptance
 * gate (mirroring codeg-plus's task acceptance).
 *
 * @module dsh-plugin-taskboard/host/protocol-text
 */

/** The protocol section served to every agent (Chinese UI deployment). */
export const CODEG_TASKBOARD_PROTOCOL = [
  '本机已安装 dsh-plugin-taskboard 插件（任务看板，语义参考 codeg-plus 的任务看板）：',
  '任务挂在 workspace（项目）上，用 taskboard_* 工具读写，人在 Web GUI 看板上实时看到同样数据。',
  '看板四列（与 codeg-plus 一致）：待办 todo（todo/queued）、进行中 inProgress（preparing/running）、',
  '需关注 attention（awaiting_input/review/merging/failed）、已完成 done（done/canceled，canceled 默认隐藏）。',
  '状态含义：todo=待办；queued=排队；preparing=认领后准备中；running=执行中；',
  'awaiting_input=正在等你输入/决策；review=实现完成，待你验收；failed=失败可重试；done=你已验收完成。',
  '工具：taskboard_list（查板，可按 workspaceId/status/column 过滤）、taskboard_get（读卡与评论）、',
  'taskboard_create（建卡）、taskboard_update（改卡）、taskboard_move（移卡/认领）、taskboard_comment（评论/报告）。',
  '工作纪律：',
  '1. 开工先查板：开始工作前先 taskboard_list（按本项目过滤），有可认领任务时按纪律认领。',
  '2. 先读后动：动卡前先 taskboard_get 并读评论；评论视为最新需求，若要求等待/暂缓，停下汇报，不改状态。',
  '3. 先认领再干活：把 todo/queued → preparing（带 ifVersion）成功后，才开始读代码/实现；',
  '   认领失败（版本冲突/已被其他会话持有/项目边界不符）就停止并报告，绝不循环重试或接管他人任务。',
  '4. 版本冲突只重试一次：ifVersion 冲突时重新读卡，仅当状态仍可继续且需求未变时用新版本号重试一次，再失败即停止报告。',
  '5. 交接：实现并自验后，用 taskboard_comment 提交结构化报告（摘要/改动/验证/风险），',
  '   再把 running → review，等待用户验收；review 后用户可能打回（附意见）或直接完成。',
  '6. 完成与取消是用户的动作：你永远不能把任务移到 done 或 canceled；review 之后只能等用户验收。',
  '7. 边界：认领带 workspaceId 的任务时，任务属于该 workspace；只有工作目录解析到同一 workspace 的会话才能认领。',
  '用户提到「任务看板/看板/认领任务」时即指本插件，请据此协作。',
].join('\n')

/** Section order inside the tool-guidance band (100–199). */
export const CODEG_TASKBOARD_SECTION_ORDER = 180

/** Registered section name. */
export const CODEG_TASKBOARD_SECTION_NAME = 'plugin:dsh-plugin-taskboard'
