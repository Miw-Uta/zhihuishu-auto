/**
 * 新版智慧树适配配置（wisdom-mooc.zhihuishu.com/study/index）—— v0.7.0。
 *
 * 选择器来源标注：
 *   - 「实测」= 2026-11-17 第二阶段在真实新版页面采集到的 DOM 结构；
 *   - 「框架级」= Element Plus 组件库的标准子结构（与实测父节点同族），
 *     使用前仍需在页面上验证，不允许直接假定存在。
 *
 * 平台改版时优先改这里，不要把选择器散落到其他文件。
 */
window.ZHS_MODERN_CONFIG = {
  version: '0.8.0',

  selectors: {
    // ---- 播放器（实测：<video id="vjs_container_html5_api" class="vjs-tech">，
    //      祖先链 #vjs_container.video-js ← #container.able-player-container ← .video-play）----
    video: ['#container video', 'video#vjs_container_html5_api', 'video.vjs-tech', 'video'],
    playerRoot: ['#container.able-player-container'],

    // ---- 课程目录（实测：.catalog-com > .chapter-wrapper > .el-collapse > .el-collapse-item）----
    catalogRoot: ['.catalog-com .chapter-wrapper', '.catalog-com'],
    chapterItem: ['.chapter-item'],                    // 实测：小节条目 div，当前节带 .current
    chapterItemCurrent: ['.chapter-item.current'],     // 实测：正在播放的小节
    chapterTitle: ['.chapter-title'],                  // 实测：章标题（「第一章:」）
    chapterName: ['.chapter-name'],                    // 实测：章名
    itemNum: ['.item-num'],                            // 实测：小节编号（「1.1」）
    itemName: ['.item-name'],                          // 实测：小节名
    itemBox: ['.item-box'],                            // 实测：小节状态容器

    // ---- 完成状态三态（实测：已完成 = img.finish-icon；进行中 = .el-progress[role=progressbar]；
    //      未开始 = 两者皆无，item-box 内仅 <!----> 占位）----
    finishIcon: ['img.finish-icon'],
    progressBar: ['.el-progress[role="progressbar"]'],

    // ---- 「测试」条目（实测：div.test-box > img + span("测试")，与 .chapter-content 平级）----
    testEntry: ['.test-box'],

    // ---- 折叠面板（实测父节点 .el-collapse-item.is-active；header 为框架级，切换前运行验证）----
    collapseItem: ['.el-collapse-item'],
    collapseHeader: ['.el-collapse-item__header'],

    // ---- 小节点击目标候选（切换用：按序尝试并验证生效，不假定某一层可点击）----
    lessonClickTargets: ['.chapter-item', '.item-box', '.item-name'],

    // ---- AI 随堂练习弹窗（实测：.el-overlay.el-modal-dialog > .el-overlay-dialog >
    //      .el-dialog.ai-class-exercise-dialog）----
    quizDialog: ['.ai-class-exercise-dialog'],
    quizDialogOverlay: ['.el-overlay.el-modal-dialog'],
    quizType: ['.item .row .type'],                    // 实测：<span class="type">1. [单选题] </span>
    quizTitle: ['.item .question-info'],               // 实测：题干容器（.container 内为题目 HTML）
    quizOption: ['.item .option'],                     // 实测：每个选项 .option
    optionMark: ['.class-question-select'],            // 实测：选项字母（A/B/C/D），isSelect/isRight/isError 挂在此
    optionAnswer: ['.answer'],                         // 实测：选项文本
    correctOps: ['.correct-ops'],                      // 实测：提交后公示「正确答案： X」
    submitBtn: ['.ai-class-exercise-dialog .dialog-footer .el-button.btn'],  // 实测：提交按钮

    // ---- 通知弹窗（实测：.el-dialog.ai-notice-dialog，按钮 .btn 文案「好的」）----
    noticeDialog: ['.ai-notice-dialog'],
    noticeBtn: ['.ai-notice-dialog .btn'],

    // ---- 弹窗关闭（实测 2026-11-17 事件流捕获：点击 header 的 IMG.header-icon 关闭弹窗；
    //      无 headerbtn/关闭类名，footer「已提交」按钮仅状态展示不触发关闭）----
    quizCloseBtn: ['.ai-class-exercise-dialog .ai-class-exercise-dialog-header .header-icon'],
  },

  classes: {
    currentLesson: 'current',  // 实测：正在播放的小节标记（.chapter-item.current）
    activePanel: 'is-active',  // 实测：折叠面板展开标记（.el-collapse-item.is-active）
    selected: 'isSelect',    // 实测：选项被选中
    right: 'isRight',        // 实测：正确选项（提交后）
    error: 'isError',        // 实测：答错的所选项
    finishBtn: 'is-finish',  // 实测：提交按钮完成态（「已提交」）
  },

  text: {
    submitRe: /^提交作答$/,
    submittedRe: /^已提交$/,
    noticeOkRe: /^好的$/,
    typeRe: /\[单选题\]|\[多选题\]|\[判断题\]/,
    // 判断题语义选项匹配（自动作答用）：「对」系选项文本特征
    trueRe: /^(正确|对|√|是对的?|正确说法?|true|yes)$/i,
    // 「错」系选项文本特征
    falseRe: /^(错误|错|×|是错的?|错误说法?|false|no)$/i,
  },

  autoAnswer: {
    enabled: true,          // 自动作答总开关（popup 可覆盖）
    // 策略：'vnode' = 判断题语义首答/单多选首项提交（默认——2026-11-18 实测：
    //        reload 跳过仅对已答过的题有效（刷新后弹窗仍是原题），未答题目无法跳过，
    //        已删除 reload 策略；作答是唯一自动化路线，单多选首答命中率受限——
    //        新版答案不下发前端）
    strategy: 'vnode',
    submitDelayMs: [1800, 3600],   // 选答案→提交 的拟人延迟（读题+作答时间）
    retryDelayMs: [1500, 3000],    // 读到答错反馈→改选重交 的拟人延迟（仅可重交形态）
    maxRounds: 4,           // 同一道题最多作答轮数（上限保护）
  },

  limits: {
    maxSpeed: 1.8,   // 与旧版平台风控约束保持一致（playbackRate <= 1.8）
    minSpeed: 0.5,
    stallMs: 12000,  // 播放位置 12s 未前进视为卡住
    switchLockMs: 18000,          // 切集后的防重复锁
    endedConfirmMs: 20000,        // ended 后等待 finish-icon 出现的最长确认窗口
    endedConfirmPollMs: 2000,     // ended 后轮询完成状态的间隔
  },
};
