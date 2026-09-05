/**
 * The built-in template gallery: ready-made automations a user can start from,
 * mirroring the role codeg-plus's 模板库 plays in its 自动化 page. Pure data — the
 * host serves it as-is and the editor fills its form from one row.
 *
 * Every template deliberately asks for something a coding agent can finish
 * unattended and report on. None of them commits, pushes, deploys or writes to
 * anything outside the working tree: an unattended run has nobody to catch a bad
 * decision, so the templates model the restraint the standing preamble asks for.
 *
 * @module dsh-plugin-automation/shared/templates
 */

/**
 * @typedef {object} AutomationTemplate
 * @property {string} id - stable template id.
 * @property {string} name - the automation name the form starts with.
 * @property {string} group - gallery section.
 * @property {string} note - one line describing what it does.
 * @property {string} prompt - the prompt body.
 * @property {object} schedule - a valid schedule for it.
 * @property {string} action - the delivery kind the template suggests.
 */

/** @type {AutomationTemplate[]} */
export const AUTOMATION_TEMPLATES = [
  {
    id: 'test-regression',
    name: '每日测试回归',
    group: '质量',
    note: '每个工作日早上跑一遍测试，把失败的用例和可能的原因写清楚',
    prompt: [
      '在当前项目里跑一遍测试套件（自己找出正确的命令：package.json 的 scripts、Makefile、Cargo.toml 等）。',
      '',
      '如果全绿：一句话报告通过，并附上执行的命令与耗时。',
      '如果有失败：逐条列出失败的用例、失败信息，以及你判断的原因；能确定是环境问题的说明是环境问题。',
      '不要为了让测试通过而修改测试或源码 —— 这一轮只做诊断。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
    action: 'headless',
  },
  {
    id: 'dirty-tree-report',
    name: '收工前的改动清点',
    group: '日常',
    note: '每个工作日傍晚清点未提交的改动，提醒哪些该收尾',
    prompt: [
      '清点当前项目的工作树状态：未提交的改动、未推送的提交、以及当前分支相对主干的落后/领先情况。',
      '',
      '按「已经可以提交」「还差什么」「看起来是临时试验、可以丢」三类归纳，并给出每一类的具体文件。',
      '只读不写：不要 add、不要 commit、不要 stash、不要切分支。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '0 18 * * 1-5' },
    action: 'headless',
  },
  {
    id: 'dependency-audit',
    name: '每周依赖巡检',
    group: '维护',
    note: '每周一检查依赖是否过期、有无已知漏洞，给出升级建议',
    prompt: [
      '检查当前项目的依赖：哪些已经过期、哪些有已知安全问题、哪些锁文件与清单不一致。',
      '用项目自带的工具（npm outdated / npm audit、cargo outdated、pip list --outdated 等），能离线判断的就离线判断。',
      '',
      '产出一份升级建议：分「建议现在升」「需要人决定（可能不兼容）」「先别动」三档，每条写清理由与风险。',
      '不要真的执行升级，也不要改锁文件。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '0 10 * * 1' },
    action: 'headless',
  },
  {
    id: 'review-recent-commits',
    name: '近期提交自查',
    group: '质量',
    note: '每天早上审一遍最近的提交，指出可疑的改动',
    prompt: [
      '审查当前分支最近 24 小时的提交（没有就说没有）。',
      '',
      '重点看：明显的逻辑错误、被顺手删掉的校验、写死的路径或密钥、只在一处改了但别处也需要改的地方、缺测试的新分支逻辑。',
      '按严重程度逐条列出，每条给出文件与行号。只给意见，不改代码。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '30 9 * * 1-5' },
    action: 'headless',
  },
  {
    id: 'todo-sweep',
    name: 'TODO 清理提案',
    group: '维护',
    note: '每周五扫一遍 TODO/FIXME，挑出真正该处理的',
    prompt: [
      '扫描当前项目里的 TODO / FIXME / XXX / HACK 注释。',
      '',
      '排除依赖目录与构建产物。对每一条判断：它还成立吗？是否已经被别的改动解决了？值不值得现在做？',
      '产出一张按「该做」「可以删掉这条注释」「留着」分类的清单，附文件与行号。不要动代码。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '0 15 * * 5' },
    action: 'headless',
  },
  {
    id: 'queue-for-review',
    name: '把待办投到看板',
    group: '协作',
    note: '按计划在任务看板建一张卡，等人或 agent 在会话里接手（不自动执行）',
    prompt: [
      '（这条模板不会自己动手，只会在任务看板上建一张卡。把你希望有人接手时看到的说明写在这里。）',
      '',
      '例如：检查上周新增的接口有没有补上文档与测试，缺的补齐。',
    ].join('\n'),
    schedule: { kind: 'cron', cron: '0 9 * * 1' },
    action: 'taskboard',
  },
]
