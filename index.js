/*
 *  生图工坊 · DrawGen v1.8.10
 *  SillyTavern 第三方扩展 —— 独立生图插件
 *
 *  管线：AI 回复 → 副AI提取生图描述（整段 / 分层）→ 注入 image###…### 标记 → 中转站生图 → 标记原位换成图片
 *    （主模型自己模仿写的标记：自动提取开着时剥掉走正常管线；关着时才直接按标记生图）
 *
 *  · 楼层正文里每一个 image###…### 标记原位换成图片，一楼几个标记几张图；
 *    没图的标记显示「生成图片」按钮，出图后是折叠条，重画保留历史可翻页
 *  · 面板两个页签卡片「🎨 生图」「📝 提取」；日版 / 夜版主题；酒馆扩展抽屉里有入口块
 *  · 生图 / 提取各自多站点（首次安装内置常用中转站档案）；画风 / 提取规则 / 角色锚点各自多套预设
 *  · 分层提取：镜头/环境/氛围/人物/服装/动作（六层），各一框一锁，可只重摇一层，环境/氛围/服装跨楼沿用
 *  · v1.7.0 与 Tavo 生图工坊 v1.18.16 对齐：
 *    画质 quality 参数（随站点保存）、chat/completions 失败自动退 images/generations、
 *    地址直指 images 接口时直连、站点只认 response_format=url 时自动改发重试、
 *    全角 × 尺寸归一化、生图超时（默认 300 秒）与取消真正生效、
 *    失败提示带 HTTP 状态码与站点原话、画风 JSON 导入导出、预设包导入（模板 / 规则 / 系统提示 / 锚点归并）
 *  · v1.7.1 面板纵向压缩；自动提取固定等待 1800→800ms（未自定义过的老配置自动迁移，下限 100ms）；
 *    提取请求不再把本插件注入的生图块和内嵌 base64 图发给副AI（少烧 prefill）；忙等轮询 1200→300ms；
 *    修复 v1.7.0 内置提取站点因结构问题未真正播种的问题
 *  · v1.8.0 稳定性与提速（按酒馆机制排查）：
 *    落盘 —— 注入记录和图库同步进 msg.swipe_info[swipe_id].extra（酒馆切 swipe 会用它覆盖 msg.extra，
 *      之前切走再切回来记录和图整体被抹掉）；saveChat 统一走 persistChat（await + 同帧合并 + 失败提示）；
 *      生图期间切回复/删楼不再把图归错人或写进孤儿楼
 *    标记 —— image###…### 识别放宽：井号写多写少、全角＃、大小写都认；
 *      漏写闭合时不再把下一个标记吞掉（内层禁止再出现前缀）
 *    提速 —— 生图移出提取锁（之前下一楼提取要干等整张图生完，且生图失败会误触发提取重试）；
 *      提取请求封顶 max_tokens；正文上限 9000→4000 字；提取看门狗防锁死
 *    计费 —— chat 失败按原因决定是否退 images（限流/鉴权/5xx/已返回200 不再二连击）；
 *      锁脸编辑接口 200 无图就不再试下一种形状
 *    其它 —— 延迟框清空不再退成 1800、图片宽度清空不再退成 60（归一化值回显到框里）；
 *      提取超时默认 180 秒（0=不限会锁死）；图片下载带超时与中止；「停止」能掐断并发的生图
 *    面板 —— 手机端整体变矮 60px；修「延迟 / 图片宽度」输入框不齐（格子底边对齐 + 长标签收短）
 *  · v1.8.1 跨段落的长标记现在能变成图了：酒馆把正文换行渲染成多个段落后，一条跨段的标记
 *    被切进不同文本节点，逐节点跑正则匹配不到完整标记 —— findAllTags 认得出但 DOM 里建不出槽，
 *    标记文字赖在楼里、生成好的图没地方显示。新增 Range 跨节点替换 + 槽建不出时图退到楼尾兜底。
 *    标记首尾井号改为必须同一串（1.8.0 放宽成「两个以上」会被正文里的 ## 提前截断）。
 *    撤销 1.8.0 擅自把送给副AI的正文上限从 9000 砍到 4000（她的正文本来就长，不该替她做减法）。
*    手机端面板再矮 60px。
 *  · v1.8.2 回滚 1.8.1 两处我擅自改的提取行为（它们当场把提取搞坏了）：
 *    ① 去掉 max_tokens —— thinking 系模型光思考就吃满额度，正文一个字挤不出来：
 *       要么退去读 reasoning_content 当提示词（状态条「副AI没按分层输出，已整段兜底」、
 *       预览框里是一段思考），要么连 content 都是空的直接「无法解析响应」甩原始 JSON。
 *    ② 提取「超时」默认回 0（不限）并回退那次把老配置 0 抬成 180 的迁移 ——
 *       thinking 模型想得久，180 秒会把慢站点整个掐断。死锁交给看门狗兜（看门狗只解锁和提示，
 *       不中断在跑的请求），不该替她改请求行为。
 *    另：解析失败时说人话（「只输出了思考内容」/「正文被截断」），不再只甩一串原始 JSON。
 *  · v1.8.3 旧图清理：新增「存图天数」（默认 7，0 = 不清理）。超期的图连服务器文件一起删，
 *    聊天里的引用同时摘掉，摘空的槽恢复成「生成图片」按钮可重新生成。
 *    年龄取自文件名里的毫秒时间戳（sdg_<ts>_…），所以只认插件自己生成的图 ——
 *    她自己传的图、别人插件的图、内嵌 base64 一律不碰。切聊天/启动后触发，内部 12 小时节流。
 *  · v1.8.4 GPT 渠道两处排雷 + 删标记连图一起清：
 *    ① 「内容被审核拒」GPT 系回的是 400（偶尔 403）+ moderation_blocked /
 *       content_policy_violation / safety system，原先被当成「chat 接口不通」，
 *       拿同一个提示词又退去 images 打一发 —— 一次生图两次被拒、耗时翻倍、safe 看两遍。
 *       这类错误现在立刻停（Grok 不做内容审核，走不到这条路，所以那边一直正常）。
 *    ② 失败提示原先印成「生图失败 400：生图失败 / …」（前缀被当成站点原话、通道标识丢了），
 *       现在是「生图失败 400（chat）：站点原话」，状态码仍排在最前面。
 *    ③ 删掉正文里那一整条 image###…### 标记，这一楼的图跟着清（只摘聊天里的引用）。
 *  · v1.8.5 修 1.8.4 清图清错（它清掉了她二十几楼的图）：
 *    病根是拿「正文里没有标记」当成「标记被她删了」。她很多楼本来就不带标记
 *    （图在 extra.sdg_gal 里、靠 showOrphanImage 贴在楼尾显示），而重绘会在启动、
 *    切聊天、每次 DOM 变动后把所有楼跑一遍 —— 一遍扫过去全被当成「标记被删」清掉；
 *    隐藏楼不进 DOM、不重绘，所以躲过了。
 *    改成三条：①清图只认 tagsSeen 的前后对比（上一次重绘时这楼有标记、这次编辑后没有了），
 *    没亲眼看到这个转变就什么都不做，刷新后表是空的也什么都不做；
 *    ②只清事件带来的那一个楼号，重绘路径一行数据都不碰；
 *    ③只摘聊天里的引用、不删服务器文件（文件交给「存图天数」统一清，判错了还能用聊天备份找回）。
 *    另撤掉 1.8.4 那条「标记少了就清掉编号 ≥ 标记数的槽」——自动生图的槽位是 tags.length-1，
 *    一楼多条标记只生一张图时，图正好落在最后那个槽上，删掉一条标记就把它砍了。
 *  · v1.8.6 完整调用链审查：思考文本不再当提示词；chat 返回 200 后解析失败不再重复扣费；
 *    停止可贯穿图片下载和上传；指定 images 接口时不会被代理选项挡住；
 *    旧图清理同步处理所有 swipe 快照，编辑中的临时正文不触发清图；看门狗解锁后旧提取结果失效。
 *  · v1.8.9 图片与工具栏等宽，竖图不再因限高缩窄；异步生图只更新原回复图库，
 *    重画按当前标记匹配分层记录；切回复或改正文后不写入旧提取结果、不继续批量生图。
 *  · v1.8.10 远端图下载失败尝试酒馆代理，真实图片字节保存到酒馆；未存下的外链明确提示，
 *    可重试保存或补存当前聊天所有回复旧图。新安装默认长期保留，已有保留天数不改。
 */
(function () {
    "use strict";

    const EXT_KEY = "st-drawgen";
    const VERSION = "1.8.10";
    const LOG = "[DrawGen]";

    /* ============================================================
       常量与默认设置
       ============================================================ */
    const DEFAULT_TEMPLATE = "image###{Description}###";
    const ALT_TEMPLATE = "<draw>{Description}</draw>";
    const TPL_PH_RE = /\{(?:Description|Camera|Env|Mood|Chars|Outfit|Pose)\}/g;

    /* —— 分层提取 —— */
    const LAYERS = ["camera", "env", "mood", "chars", "outfit", "pose"];
    const LAYER_LABEL = { camera: "镜头", env: "环境", mood: "氛围", chars: "人物", outfit: "服装", pose: "动作" };
    const LAYER_ICON = { camera: "📷", env: "🌆", mood: "🎞️", chars: "🧍", outfit: "👗", pose: "🤝" };
    const LAYER_PH = { camera: "{Camera}", env: "{Env}", mood: "{Mood}", chars: "{Chars}", outfit: "{Outfit}", pose: "{Pose}" };
    const LAYER_INHERIT = { env: true, mood: true, outfit: true };   // 副AI回 NO_CHANGE 时沿用上一楼的层
    const NOCHANGE = "NO_CHANGE";

    const DEFAULT_SYS_EMO = "You extract concise visual image-generation descriptions from Chinese roleplay text. Focus on visible emotion, relationship tension, micro-expressions, body language, atmosphere, lighting, and cinematic mood. Output only the final English Description. Do not think aloud. Do not explain.";
    const DEFAULT_SYS_PLOT = "You extract concise visual image-generation descriptions from Chinese roleplay text. Focus on visible plot actions, scene composition, character placement, objects, environment, time, lighting, camera distance, and narrative context. Output only the final English Description. Do not think aloud. Do not explain.";

    const DEFAULT_ANCHOR_GUIDE = [
        "以下角色锚点仅为候选资料库，不是强制全部使用。提取时请严格根据正文当前场景按需调用：",
        "1. 只调用正文中明确出场、且当前画面确实需要入镜的角色。",
        "2. 未出场、仅被提及、仅存在于回忆/对话/电话/聊天记录中的角色，不要加入当前画面。",
        "3. 单人场景只输出单人描述，双人场景只输出双人描述；只有正文明确存在多人同场互动时，才输出多人描述。",
        "4. 若正文只出现某一个角色，则只调用该角色的锚点；其他角色若未实际出场，一律忽略。",
        "5. 这些角色锚点只用于校准已出场角色的外貌，不用于凭空增加角色。"
    ].join("\n");

    const DEFAULTS = {
        enabled: true,
        theme: "night",             // day | night
        showBall: true,
        tab: "gen",                 // 面板当前页签 gen | ext
        // —— 提取（副AI）——
        extEndpoint: "", extKey: "", extModel: "",
        extProfilesJson: "", extProfileId: "",
        genProfilesJson: "", genProfileId: "",
        extSystemPromptsJson: "",
        extActiveSystemPrompt: "sys_emo",
        extRules: "",
        extAnchors: "",
        anchorGuideOn: true,
        extProxy: false,
        requestTimeout: 0,
        retryOnce: true,
        // —— 分层 ——
        layered: false,
        layerLocks: {},
        // —— 注入 ——
        template: DEFAULT_TEMPLATE,
        autoExtract: true,
        autoInject: true,
        autoGenerate: true,
        autoDelay: 800,
        hideTagText: true,          // 出图后标记文字不显示（标记原位换成图）
        // —— 生图 ——
        genEndpoint: "", genKey: "", genModel: "",
        genFixedPrompt: "", genPostfixPrompt: "",
        stylesJson: "", styleId: "",     // 画风预设（可存多个随时切）
        rulesJson: "", rulesId: "",      // 提取规则预设
        anchorsJson: "", anchorsId: "",  // 角色锚点预设
        grokSize: "1024x1024",
        genQuality: "",            // 画质参数：GPT 2.5 系 low/medium/high/xhigh/max；Grok low/medium/auto；留空不发送（随站点档案保存）
        faceRef: "", faceRefOn: false, faceRefMode: "chat",   // 脸部参考图（data URL）+ 锁脸开关 + 发送方式（chat=聊天多模态 / edits=/images/edits 编辑接口）
        genProxy: false,
        genTimeout: 300,
        convertToJpeg: false,
        imageKeepDays: 0,          // 默认长期保存；用户主动设置正数才按天清理，保留已有配置
        imageCleanAt: 0,           // 上次清理时间，半天跑一次就够
        showImage: true,
        imageMaxWidth: 100,
        // —— 界面 ——
        ballLeft: "", ballTop: "",
        panelLeft: "", panelTop: ""
    };

    /* -- 内置站点档案（与 Tavo 生图工坊 v1.18.16 对齐；仅在本插件首次安装、站点列表为空时播种一次，之后完全由用户自己管理） -- */
    const BUILTIN_GEN_PROFILE_ID = "smu0ujfttbq";
    const BUILTIN_EXT_PROFILE_ID = "smu0ujfttce";
    const BUILTIN_GEN_PROFILES =
        [
            {
                "id":  "smu0ujfttbq",
                "name":  "wong",
                "models":  [
                               "01-ai/yi-large",
                               "deepseek-ai/deepseek-v4-flash",
                               "deepseek-ai/deepseek-v4-flash-0731",
                               "deepseek-ai/deepseek-v4-pro-0813",
                               "deepseek-v4-flash",
                               "deepseek-v4-flash-vision-exp",
                               "glm-5.2-200k",
                               "glm-5.3-200k",
                               "google/gemma-4-31b-it",
                               "grok-4.20-0309-non-reasoning",
                               "grok-4.20-0309-reasoning",
                               "grok-4.20-multi-agent-0309",
                               "grok-4.3",
                               "grok-4.5",
                               "grok-4.6",
                               "grok-4.7",
                               "grok-composer-2.5-fast",
                               "grok-imagine-image",
                               "grok-imagine-image-2.0",
                               "grok-imagine-image-edit",
                               "grok-imagine-image-lite",
                               "grok-imagine-image-quality",
                               "grok-imagine-video",
                               "hy-image-v3.5-preview",
                               "mimo-v2.5",
                               "mimo-v2.6-flash",
                               "minimax-m2.1-highspeed",
                               "minimax-m2.5-highspeed",
                               "minimax-m2.7-highspeed",
                               "minimax-m3",
                               "minimaxai/minimax-m3",
                               "ministral-14b-latest",
                               "ministral-3b-latest",
                               "ministral-8b-latest",
                               "mistralai/mistral-large",
                               "moonshotai/kimi-k2.6",
                               "moonshotai/kimi-k3",
                               "openai/gpt-oss-120b",
                               "openai/gpt-oss-20b",
                               "qwen3.7-max",
                               "qwen3.8-flash",
                               "qwen3.8-max",
                               "qwen3.8-omni-flash",
                               "sensenova-6.7-flash-lite",
                               "sensenova-6.8-flash-lite"
                           ],
                "endpoint":  "https://wzw.pp.ua/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "grok-imagine-image-2.0",
                "provider":  "grok",
                "size":  "1024×1792",
                "quality":  "medium"
            },
            {
                "id":  "smu123btrp1",
                "name":  "so",
                "endpoint":  "https://api.67.si/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2",
                "models":  [
                               "deepseek/deepseek-v4-flash",
                               "gpt-image-2",
                               "grok-4.20-0309-non-reasoning",
                               "grok-4.20-0309-reasoning",
                               "grok-4.20-fast",
                               "grok-4.20-multi-agent-0309",
                               "grok-4.5",
                               "grok-4.6",
                               "grok-4.7",
                               "grok-chat-fast",
                               "grok-imagine-video",
                               "openai/gpt-oss-120b",
                               "qwen/qwen3.8-27b",
                               "qwen3.6-plus",
                               "qwen3.7-max",
                               "qwen3.7-plus",
                               "qwen3.8-max",
                               "stealth/union-alpha",
                               "z-ai/glm-5.3-flash"
                           ],
                "provider":  "gemini",
                "size":  "1024×1536",
                "quality":  "high"
            },
            {
                "id":  "smuc2dlkvis",
                "name":  "卡皮巴拉",
                "endpoint":  "https://kapibala.asia/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5",
                "models":  [
                               "gemini-3.6-flash-high",
                               "grok-4.6",
                               "doubao-seedance-2-0-260128",
                               "grok-imagine-video-1.5",
                               "gpt-6-sol",
                               "gpt-6-astra",
                               "grok-composer-2.5-fast",
                               "deepseek-v4-pro-0813",
                               "glm-5.3-flash",
                               "grok-imagine-image-quality",
                               "MiniMax-M2.7",
                               "gpt-6-luna",
                               "speech-2.8-hd",
                               "doubao-seedance-2-5-260628",
                               "speech-2.8-turbo",
                               "MiniMax-M3",
                               "grok-imagine-image-2.0",
                               "image-01",
                               "deepseek-v4-flash-0731",
                               "glm-5.2",
                               "MiniMax-Hailuo-2.3",
                               "glm-5.3",
                               "deepseek-v4.1-flash",
                               "grok-4.5",
                               "gpt-5.5",
                               "image-01-live",
                               "gemini-3.7-flash-high",
                               "MiniMax-M2.7-highspeed",
                               "gpt-image-2",
                               "gpt-6.1-sol",
                               "gemini-3.8-flash-high",
                               "gpt-5.6-terra",
                               "MiniMax-H3-Local",
                               "Qwen3.8-27B",
                               "gpt-5.6-luna",
                               "grok-4.20-multi-agent-0309",
                               "gpt-image-2.5",
                               "grok-4.7",
                               "gpt-5.6-sol"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smug927se4",
                "name":  "fate",
                "endpoint":  "https://fate.xxxxa.art/v1/images/generations",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5-sunburst",
                "models":  [
                               "agnes-2.5-flash",
                               "agnes-3.0-flash",
                               "atria-dawn",
                               "bailu-2.7",
                               "bailu-dash",
                               "command-a-plus",
                               "deepseek-v4-flash",
                               "deepseek-v4.1-flash",
                               "dots-3-note-preview",
                               "gemini-3.6-flash",
                               "gemini-3.7-flash",
                               "glm-4.7-flash",
                               "glm-5.2",
                               "glm-5.3",
                               "glm-5.3-flash",
                               "gpt-image-2",
                               "gpt-image-2.5-flare",
                               "gpt-image-2.5-sunburst",
                               "grok-4.7",
                               "grok-composer-2.5-fast",
                               "hy3",
                               "kimi-k3",
                               "ling-3.0-flash-fin",
                               "longcat-2.5-preview",
                               "mercury-2.5",
                               "mimo-v2.5",
                               "mimo-v2.6-flash",
                               "minimax-m3",
                               "muse-spark-1.3-contributor",
                               "nemotron-3.5-lightning-30b",
                               "qwen3-8b",
                               "qwen3.8-27b",
                               "sensenova-6.8-flash-lite",
                               "sensenova-u1.5-lite",
                               "space-bunny-alpha",
                               "step-3.5-flash",
                               "step-3.7-flash",
                               "step-5-preview"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smumhpgodan",
                "name":  "node",
                "endpoint":  "https://cn.nodeproxy.download/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "firefly-gpt-image",
                "models":  [
                               "firefly-gemini-omni",
                               "minimax-m2",
                               "minimax-m2.1",
                               "firefly-seedance20-fast",
                               "gemini-3.1-pro-preview",
                               "firefly-veo31-ref",
                               "gemma3:12b",
                               "gemini-3.1-flash-image",
                               "gemini-3.7-flash-high",
                               "firefly-nano-banana",
                               "firefly-veo31-fast",
                               "glm-4.6",
                               "minimax-m3",
                               "gemini-3.6-flash-high",
                               "gemini-3.5-flash-low",
                               "gemini-3.1-pro-low",
                               "minimax-m2.5",
                               "gemma4:31b",
                               "firefly-nano-banana2",
                               "firefly-seedance20",
                               "glm-4.7",
                               "gemma3:4b",
                               "gemini-3-flash",
                               "firefly-gpt-image",
                               "firefly-kling3",
                               "gemini-3.1-pro-high",
                               "firefly-veo31",
                               "firefly-nano-banana-pro",
                               "gemini-3.8-flash-high",
                               "firefly-kling-o3",
                               "gemma3:27b",
                               "gemini-3.1-flash-lite",
                               "gemini-3.5-flash-high"
                           ],
                "size":  "768×1024"
            },
            {
                "id":  "smunetg02p7",
                "name":  "咕嘎",
                "endpoint":  "https://ai.xmiaom.com/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5",
                "models":  [
                               "chatgpt-voice",
                               "claude-sonnet-5",
                               "claude-sonnet-5.5",
                               "deepseek-v4.1-flash",
                               "gemini-3.7-flash",
                               "glm-5.3",
                               "glm-5.3-flash",
                               "gpt-5.6-sol",
                               "gpt-6-sol",
                               "gpt-image-2.5",
                               "gpt-image-2.5-4k",
                               "grok-4.20-multi-agent-xhigh",
                               "grok-4.3-fast",
                               "grok-4.6",
                               "grok-4.7",
                               "grok-imagine-image",
                               "grok-imagine-image-2.0",
                               "grok-imagine-image-lite",
                               "grok-imagine-image-pro",
                               "grok-imagine-video",
                               "hy4",
                               "jev-latest",
                               "kimi-k3",
                               "mimo-v2.5",
                               "mimo-v2.6-flash",
                               "minimax-h3",
                               "muse-spark-1.3-contributor",
                               "Nano Banana 2",
                               "Nano Banana 2 Lite",
                               "Nano Banana Pro",
                               "NSFW",
                               "omni1.1-flash",
                               "qwen3.8-flash",
                               "space-bunny-alpha",
                               "veo-3.1-fast",
                               "veo-3.1-lite",
                               "veo-3.1-quality"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smutfmlvylv",
                "name":  "松贝",
                "endpoint":  "https://draw.songbey.com/v1/images/generations",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5",
                "models":  [
                               "gpt-image-2.5"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smuttp97ea0",
                "name":  "帝国",
                "endpoint":  "https://ar26710.space/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2",
                "models":  [
                               "[anti]claude-opus-4-6-thinking",
                               "[anti]claude-sonnet-4-6",
                               "[anti]gemini-3-flash",
                               "[anti]gemini-3.1-flash-lite",
                               "[anti]gemini-3.1-pro-preview",
                               "[anti]gemini-3.5-flash",
                               "[anti]gemini-3.6-flash",
                               "[anti]gemini-3.7-flash",
                               "[anti]gemini-3.8-flash",
                               "[c]claude-3-7-sonnet",
                               "[c]claude-sonnet-4",
                               "[free-key]gemini-2.5-flash",
                               "[free-key]gemini-3-flash-preview",
                               "[free-key]gemini-3.1-flash-lite-preview",
                               "[free-key]gemini-3.5-flash",
                               "[free-key]gemini-3.6-flash",
                               "[free-key]gemini-3.7-flash",
                               "[G]deepseek-v3.1",
                               "[G]deepseek-v3.2",
                               "[G]minimax-m2.7",
                               "[K]GLM-5.3-Flash",
                               "[N]glm-5.3",
                               "[N]glm-5.3-flash",
                               "[N]kimi-k3",
                               "[N]minimax-m3",
                               "[web]gemini-3.5-flash",
                               "[web]gemini-3.5-flash-thinking",
                               "[web]gemini-3.6-flash",
                               "[web]gemini-3.7-flash",
                               "[假流]gemini-2.5-pro",
                               "[假流]gemini-2.5-pro-search",
                               "[假流]gemini-3.1-pro-preview",
                               "[假流]gemini-3.1-pro-preview-search",
                               "[假流]gemini-3.5-flash",
                               "[假流]gemini-3.5-flash-search",
                               "[假流]gemini-3.6-flash",
                               "[假流]gemini-3.6-flash-search",
                               "[假流]gemini-3.7-flash",
                               "[假流]gemini-3.7-flash-search",
                               "[假流]gemini-3.8-flash",
                               "[假流]gemini-3.8-flash-search",
                               "[官反]grok-4.20-fast",
                               "[官反]grok-4.5",
                               "[官反]grok-4.6",
                               "[正式版]DeepSeek-V4-Flash-0731",
                               "[正式版N]deepseek-v4-flash",
                               "[正式版N]deepseek-v4-pro",
                               "[正式版Y]deepseek-v4.1-flash",
                               "[绘图]gemini-3.1-flash-image",
                               "gpt-image-2"
                           ],
                "size":  "1024×1792",
                "quality":  "high"
            },
            {
                "id":  "smuu10fkzon",
                "name":  "肘子",
                "endpoint":  "https://api.dzzi.ai/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "[按次]gpt-image-2.5-flare",
                "models":  [
                               "[CLI]gemini-3-flash-preview",
                               "[CLI]gemini-3-flash-preview-128",
                               "[CLI]gemini-3-flash-preview-128-nothinking",
                               "[CLI]gemini-3-flash-preview-nothinking",
                               "[CLI]gemini-3.5-flash",
                               "[CLI]gemini-3.5-flash-128",
                               "[CLI]gemini-3.5-flash-128-nothinking",
                               "[CLI]gemini-3.5-flash-nothinking",
                               "[CLI]gemini-3.8-flash",
                               "[CLI]gemini-3.8-flash-128",
                               "[CLI]gemini-3.8-flash-128-nothinking",
                               "[CLI]gemini-3.8-flash-nothinking",
                               "[kiro]claude-opus-4-6",
                               "[kiro]claude-opus-4-6-thinking",
                               "[kiro]claude-opus-4-7",
                               "[kiro]claude-opus-4-7-thinking",
                               "[kiro]claude-opus-4-8",
                               "[kiro]claude-opus-4-8-thinking",
                               "[kiro]claude-opus-5",
                               "[kiro]claude-opus-5-5",
                               "[kiro]claude-opus-5-thinking",
                               "[kiro]claude-sonnet-4-6",
                               "[kiro]claude-sonnet-5",
                               "[按次]claude-haiku-4-5",
                               "[按次]claude-haiku-4-5-20251001",
                               "[按次]claude-haiku-4-5-thinking",
                               "[按次]claude-opus-4-6",
                               "[按次]claude-opus-4-6-thinking",
                               "[按次]claude-opus-4-6-thinking-high",
                               "[按次]claude-opus-4-6-thinking-low",
                               "[按次]claude-opus-4-6-thinking-max",
                               "[按次]claude-opus-4-7",
                               "[按次]claude-opus-4-7-thinking",
                               "[按次]claude-opus-4-7-thinking-high",
                               "[按次]claude-opus-4-7-thinking-low",
                               "[按次]claude-opus-4-7-thinking-max",
                               "[按次]claude-opus-4-7-thinking-xhigh",
                               "[按次]claude-opus-4-8",
                               "[按次]claude-opus-4-8-thinking",
                               "[按次]claude-opus-4-8-thinking-high",
                               "[按次]claude-opus-4-8-thinking-low",
                               "[按次]claude-opus-4-8-thinking-max",
                               "[按次]claude-opus-4-8-thinking-xhigh",
                               "[按次]claude-opus-5",
                               "[按次]claude-opus-5-5",
                               "[按次]claude-opus-5-5-thinking-high",
                               "[按次]claude-opus-5-5-thinking-low",
                               "[按次]claude-opus-5-5-thinking-max",
                               "[按次]claude-opus-5-thinking",
                               "[按次]claude-opus-5-thinking-max",
                               "[按次]claude-opus-5-thinking-xhigh",
                               "[按次]claude-sonnet-4-6",
                               "[按次]claude-sonnet-4-6-thinking",
                               "[按次]claude-sonnet-4-6-thinking-high",
                               "[按次]claude-sonnet-4-6-thinking-max",
                               "[按次]claude-sonnet-5",
                               "[按次]claude-sonnet-5-5",
                               "[按次]claude-sonnet-5-5-thinking",
                               "[按次]deepseek-v4-flash",
                               "[按次]deepseek-v4-flash-0731",
                               "[按次]deepseek-v4-pro",
                               "[按次]deepseek-v4-pro-0813",
                               "[按次]deepseek-v4-pro-0813-thinking",
                               "[按次]deepseek-v4-pro-thinking",
                               "[按次]deepseek-v4.1-flash",
                               "[按次]gemini-3-flash-preview",
                               "[按次]gemini-3-flash-preview-128",
                               "[按次]gemini-3-flash-preview-128-nothinking",
                               "[按次]gemini-3-flash-preview-nothinking",
                               "[按次]gemini-3-pro-preview",
                               "[按次]gemini-3-pro-preview-128",
                               "[按次]gemini-3-pro-preview-128-nothinking",
                               "[按次]gemini-3-pro-preview-nothinking",
                               "[按次]gemini-3-pro-preview-thinking",
                               "[按次]gemini-3.1-pro-preview",
                               "[按次]gemini-3.1-pro-preview-128",
                               "[按次]gemini-3.1-pro-preview-128-nothinking",
                               "[按次]gemini-3.1-pro-preview-nothinking",
                               "[按次]gemini-3.1-pro-preview-online",
                               "[按次]gemini-3.6-flash",
                               "[按次]gemini-3.6-flash-128",
                               "[按次]gemini-3.6-flash-128-nothinking",
                               "[按次]gemini-3.6-flash-nothinking",
                               "[按次]gemini-3.7-flash",
                               "[按次]gemini-3.7-flash-128",
                               "[按次]gemini-3.7-flash-128-nothinking",
                               "[按次]gemini-3.7-flash-nothinking",
                               "[按次]gemini-3.8-flash",
                               "[按次]gemini-3.8-flash-128",
                               "[按次]gemini-3.8-flash-128-nothinking",
                               "[按次]gemini-3.8-flash-nothinking",
                               "[按次]glm-5.2",
                               "[按次]glm-5.2-thinking",
                               "[按次]glm-5.3",
                               "[按次]gpt-5.2",
                               "[按次]gpt-5.3-codex",
                               "[按次]gpt-5.4",
                               "[按次]gpt-5.5",
                               "[按次]gpt-5.6-sol",
                               "[按次]gpt-5.6-sol-max",
                               "[按次]gpt-5.6-terra",
                               "[按次]gpt-6-astra",
                               "[按次]gpt-6-astra-max",
                               "[按次]gpt-6-sol",
                               "[按次]gpt-6.1-sol",
                               "[按次]gpt-6.1-sol-max",
                               "[按次]gpt-image-2",
                               "[按次]gpt-image-2.5",
                               "[按次]gpt-image-2.5-flare",
                               "[按次]gpt-image-2.5-sunburst",
                               "[按次]grok-4.20-0309-non-reasoning",
                               "[按次]grok-4.20-0309-reasoning",
                               "[按次]grok-4.3",
                               "[按次]grok-4.3-thinking",
                               "[按次]grok-4.5",
                               "[按次]grok-4.6",
                               "[按次]grok-4.7",
                               "[按次]grok-build-0.1",
                               "[按次]kimi-k2.6",
                               "[按次]kimi-k3",
                               "[按次]minimax-m3",
                               "[按次]minimax-m3-thinking",
                               "[正价kiro]claude-opus-4-5",
                               "[正价kiro]claude-opus-4-6",
                               "[正价kiro]claude-opus-4-6-thinking",
                               "[正价kiro]claude-opus-4-6-thinking-high",
                               "[正价kiro]claude-opus-4-6-thinking-low",
                               "[正价kiro]claude-opus-4-6-thinking-max",
                               "[正价kiro]claude-opus-4-7",
                               "[正价kiro]claude-opus-4-7-thinking",
                               "[正价kiro]claude-opus-4-7-thinking-high",
                               "[正价kiro]claude-opus-4-7-thinking-low",
                               "[正价kiro]claude-opus-4-7-thinking-max",
                               "[正价kiro]claude-opus-4-7-thinking-xhigh",
                               "[正价kiro]claude-opus-4-8",
                               "[正价kiro]claude-opus-4-8-thinking",
                               "[正价kiro]claude-opus-4-8-thinking-high",
                               "[正价kiro]claude-opus-4-8-thinking-low",
                               "[正价kiro]claude-opus-4-8-thinking-max",
                               "[正价kiro]claude-opus-4-8-thinking-xhigh",
                               "[正价kiro]claude-opus-5",
                               "[正价kiro]claude-opus-5-thinking",
                               "[正价kiro]claude-opus-5-thinking-high",
                               "[正价kiro]claude-opus-5-thinking-low",
                               "[正价kiro]claude-opus-5-thinking-max",
                               "[正价kiro]claude-opus-5-thinking-xhigh",
                               "[正价kiro]claude-opus-5.5",
                               "[正价kiro]claude-opus-5.5-thinking",
                               "[正价kiro]claude-opus-5.5-thinking-max",
                               "[正价kiro]claude-opus-5.5-thinking-xhigh",
                               "[正价kiro]claude-sonnet-4-5",
                               "[正价kiro]claude-sonnet-4-6",
                               "[正价kiro]claude-sonnet-4-6-thinking",
                               "[正价kiro]claude-sonnet-4-6-thinking-high",
                               "[正价kiro]claude-sonnet-4-6-thinking-low",
                               "[正价kiro]claude-sonnet-4-6-thinking-max",
                               "[正价kiro]claude-sonnet-5",
                               "[正价kiro]claude-sonnet-5-thinking",
                               "[正价kiro]claude-sonnet-5-thinking-high",
                               "[正价kiro]claude-sonnet-5-thinking-low",
                               "[正价kiro]claude-sonnet-5-thinking-max",
                               "[正价kiro]claude-sonnet-5-thinking-xhigh",
                               "[正价kiro]claude-sonnet-5.5",
                               "[正价kiro]claude-sonnet-5.5-thinking",
                               "[正价kiro]claude-sonnet-5.5-thinking-high",
                               "[正价kiro]claude-sonnet-5.5-thinking-low",
                               "[正价kiro]claude-sonnet-5.5-thinking-max",
                               "[正价kiro]claude-sonnet-5.5-thinking-xhigh",
                               "gpt-image-2",
                               "gpt-image-2.5",
                               "n-gpt-image-2"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smuu1hgezl7",
                "name":  "空悲切",
                "endpoint":  "https://api.blanka.cc/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "[超分4K]gpt-image-2.5-sunburst",
                "models":  [
                               "[MAX-CC]claude-fable-5-1",
                               "grok-4.6",
                               "kimi-k2.7",
                               "nai-diffusion-4-5-curated",
                               "[vertex]gemini-3.8-flash",
                               "[kiro量高缓]claude-opus-4-6",
                               "[特特价次kiro]claude-opus-4-6-thinking",
                               "[vertex]gemini-3.1-pro-preview",
                               "[AWSB]claude-opus-4-7",
                               "[ais分流1]gemini-2.5-pro-preview-06-05",
                               "[限时免费kiro-free]claude-sonnet-4-5",
                               "[次]deepseek-v4.1-flash",
                               "[次AG]claude-sonnet-4-6",
                               "[0.2]glm-5.3",
                               "[特特价次kiro]claude-opus-4-8-thinking",
                               "[外审]deepseek-v4-flash-vision-exp",
                               "[高价稳定次kiro]claude-sonnet-5",
                               "[特特价次kiro]claude-opus-5-thinking",
                               "[OCG]deepseek-v4-flash-vision-exp",
                               "[AWSB]claude-opus-4-6",
                               "[次cursor]claude-opus-5",
                               "[cursor量]claude-fable-5",
                               "[反重力量]gemini-3.6-flash-high",
                               "[限时特价不稳定按次]glm-5.3",
                               "[高价稳定次kiro]claude-sonnet-5-thinking",
                               "[cursor量]claude-sonnet-5",
                               "[超分4K]gpt-image-2.5-sunburst",
                               "[高价稳定次kiro]claude-opus-4-8",
                               "[特价]kimi-k3",
                               "[破甲]gpt-5.6-sol",
                               "[高价稳定次kiro]claude-opus-5",
                               "[cursor量]claude-sonnet-4-6",
                               "kimi-k3",
                               "gpt-6-astra",
                               "BAAI/bge-m3",
                               "[ais分流1]gemini-3.1-pro-preview",
                               "[AG量]claude-sonnet-4-6",
                               "[特特价次kiro]claude-opus-4-7-thinking",
                               "[自部署]deepseek-v4-pro-0813",
                               "[0.12]glm-5.3-flash",
                               "[特价]glm-5.3",
                               "[0.2]glm-5.3-flash",
                               "doubao-seed-2-1-pro-260628",
                               "[次cursor]claude-opus-4-7",
                               "gpt-5.5",
                               "[ais分流1]gemini-3.7-flash",
                               "[高价稳定次kiro]claude-sonnet-4.6-thinking",
                               "[企业级4K]gpt-image-2",
                               "[企业级]gpt-image-2.5-flare",
                               "[高价稳定次kiro]claude-opus-4-7",
                               "gpt-6.1-sol",
                               "[ais]gemini-3.1-pro-preview",
                               "grok-4.7",
                               "[特价]gpt-image-2.5-sunburst-1k",
                               "gpt-5.6-sol",
                               "[MAX-CC]claude-opus-5",
                               "[反重力量]gemini-3.7-flash-high",
                               "gpt-6-sol",
                               "[AWSB次]claude-opus-4-8",
                               "[free账号]claude-sonnet-4-5-thinking",
                               "[次cursor]claude-fable-5",
                               "[MAX-CC]claude-opus-4-6",
                               "[0.12]deepseek-v4.1-flash",
                               "[kiro量高缓]claude-opus-4-8",
                               "[网页]deepseek-v4-flash",
                               "[ais]gemini-3.8-flash",
                               "[反重力次]gemini-3.1-pro-high",
                               "[反重力次]gemini-3.1-flash-lite",
                               "[ais分流1]gemini-3.6-flash",
                               "[特价纯血]claude-sonnet-4-6",
                               "grok-4.5",
                               "[free账号]claude-sonnet-4-5",
                               "nai-diffusion-4-full",
                               "[外审]glm-5.1",
                               "[高价稳定次kiro]claude-opus-4.7-thinking",
                               "[特价]glm-5.2",
                               "[特价]gpt-image-2-1k",
                               "[AWSB次]claude-opus-4-6",
                               "doubao-seed-2-0-pro-260215",
                               "[企业次cli]gemini-3.1-pro-preview",
                               "[反重力次]gemini-3.6-flash-high",
                               "[AG量]claude-opus-4-6",
                               "[ais]gemini-2.5-pro-preview-03-25",
                               "[次cursor]claude-opus-4-8",
                               "[AWSB]claude-sonnet-5",
                               "[vertex]gemini-2.5-pro",
                               "[特价]minimax-m3",
                               "[特价]gpt-image-2.5-flare-1k",
                               "[企业级4K]gpt-image-2.5-flare",
                               "[高价稳定次kiro]claude-sonnet-4-6",
                               "qwen3.8-max",
                               "[特价]kimi-k2.7-code",
                               "[企业次cli]gemini-2.5-pro",
                               "[次]deepseek-v4-flash",
                               "[AWSB]claude-haiku-4-5",
                               "[高价稳定次kiro]claude-opus-5-5",
                               "[外审]glm-5.3",
                               "[kiro量高缓]claude-opus-4-8-thinking",
                               "[0.12]deepseek-v4-flash-0731",
                               "nai-diffusion-5-full",
                               "[cursor量]claude-opus-5",
                               "[MAX混次]claude-opus-4-6-thinking",
                               "[MAX-CC]claude-opus-4-7",
                               "[kiro量高缓]claude-sonnet-5",
                               "[限时]gpt-5.6-sol",
                               "[VER次]claude-opus-4-6",
                               "[cursor量]claude-opus-4-7",
                               "[OCG]deepseek-v4-pro",
                               "[特价纯血]claude-opus-4-6",
                               "[AWSB次]claude-opus-4-7",
                               "[ais]gemini-3.5-flash",
                               "[速刷 AWSB次]-claude-opus-4-6",
                               "[特价]glm-5.1",
                               "[kiro量高缓]claude-opus-4-6-thinking",
                               "[高价稳定次kiro]claude-opus-4.6-thinking",
                               "[ais分流1]gemini-2.5-pro-preview-03-25",
                               "[MAX次]claude-opus-4-6",
                               "[网页]deepseek-v4-pro",
                               "[反重力量]gemini-3.1-pro-high",
                               "gemini-3.1-flash-image",
                               "qwen3.7-max",
                               "[次]grok-4.6",
                               "[vertex]gemini-3.7-flash",
                               "[vertex次]gemini-2.5-pro",
                               "[AWSB]claude-fable-5",
                               "[0.12]kimi-k3",
                               "[特价纯血]claude-opus-4-6-thinking",
                               "[特价]qwen3.7-max",
                               "[0.2]deepseek-v4.1-flash-expires-on-0910",
                               "[kiro量高缓]claude-opus-4-7-thinking",
                               "[反重力次]gemini-3.8-flash-high",
                               "[ais分流1]gemini-3.8-flash",
                               "[特价次AG]claude-opus-4-6-thinking",
                               "[反重力量]gemini-3.8-flash-high",
                               "[超分4K]gpt-image-2.5-flare",
                               "[kiro量高缓]claude-opus-4-7",
                               "[特价]qwen3.8-max",
                               "doubao-seed-2-0-code-preview-260215",
                               "[限时免费kiro-free]claude-sonnet-4",
                               "[MAX-CC]claude-sonnet-5-5",
                               "[kiro量高缓]claude-sonnet-4-6",
                               "[自部署]deepseek-v4-flash-0731",
                               "[0.12]glm-5.3",
                               "[稳定AG量]claude-opus-4-6-thinking",
                               "doubao-seed-2-1-turbo-260628",
                               "[反重力次]gemini-3.7-flash-high",
                               "[cursor量]claude-opus-4-6",
                               "[ais]gemini-3.7-flash",
                               "[AWSB]claude-opus-4-8",
                               "[MAX-CC]claude-opus-5-5",
                               "[高价稳定次kiro]claude-opus-5-thinking",
                               "[MAX-CC]claude-fable-5",
                               "[外审]glm-5.3-flash",
                               "[特价]gpt-image-2.5-1k",
                               "[MAX-CC]claude-sonnet-5",
                               "[cursor量]claude-opus-4-8",
                               "[限时免费kiro-free]deepseek-3.2",
                               "[次AG]claude-opus-4-6-thinking",
                               "[高价稳定次kiro]claude-opus-5-5-thinking",
                               "[次cursor]claude-fable-5-1",
                               "[自部署]deepseek-v4.1-flash",
                               "[0.12]deepseek-v4-pro-0813",
                               "[次]deepseek-v4-pro",
                               "[0.12]deepseek-v4.1-flash-expires-on-0910",
                               "[特价次AG]claude-opus-4-6",
                               "[AWSB次]claude-opus-5",
                               "[MAX次]claude-opus-5",
                               "[OCG]deepseek-v4-flash",
                               "[反重力次]gemini-3.5-flash-high",
                               "[限时]gpt-6-astra",
                               "[kiro量高缓]claude-opus-5-5",
                               "[高价稳定次kiro]claude-opus-4-6",
                               "[kiro量高缓]claude-opus-5",
                               "[稳定AG量]claude-sonnet-4-6",
                               "[次AG]claude-opus-4-6",
                               "[限时免费kiro-free]claude-haiku-4.5",
                               "[企业次cli]gemini-3.8-flash",
                               "[企业级]gpt-image-2.5-sunburst",
                               "gpt-5.6-terra",
                               "[ais分流1]gemini-3.5-flash",
                               "nai-diffusion-4-5-full",
                               "[ais分流1]gemini-2.5-pro-preview-05-06",
                               "deepseek-v4-flash",
                               "doubao-seed-2-0-lite-260428",
                               "[特价纯血]claude-sonnet-4-6-thinking",
                               "[0.2]kimi-k3",
                               "[次]glm-5.2",
                               "[MAX-CC]claude-opus-4-8",
                               "[AWSB]claude-sonnet-4-6",
                               "[次]glm-5.3",
                               "[限时]gpt-6-sol",
                               "doubao-seed-1-8-251228",
                               "gpt-image-2.5-sunburst",
                               "[企业级]gpt-image-2",
                               "doubao-seed-2-0-mini-260428",
                               "[MAX-CC]claude-sonnet-4-6",
                               "[ais]gemini-3.6-flash",
                               "gemini-3-pro-image",
                               "[次cursor]claude-opus-4-6",
                               "[外审]deepseek-v4-flash",
                               "[次]glm-5.3-flash",
                               "[kiro量高缓]claude-opus-5-thinking",
                               "[vertex次]gemini-3.1-pro-preview",
                               "[企业级4K]gpt-image-2.5-sunburst",
                               "[外审]glm-5.2",
                               "[高价稳定次kiro]claude-opus-4-8-thinking",
                               "[AG量]claude-opus-4-6-thinking",
                               "nai-diffusion-5-curated",
                               "[外审]deepseek-v4-pro"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smuu2rvis2l",
                "name":  "link",
                "endpoint":  "https://linkapi.ai/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5-flare-h",
                "models":  [
                               "claude-fable-5",
                               "claude-fable-5-1",
                               "claude-haiku-4-5-20251001",
                               "claude-opus-4-5-20251101",
                               "claude-opus-4-6",
                               "claude-opus-4-7",
                               "claude-opus-4-8",
                               "claude-opus-5",
                               "claude-opus-5-5",
                               "claude-sonnet-4-5-20250929",
                               "claude-sonnet-4-6",
                               "claude-sonnet-5",
                               "claude-sonnet-5-5",
                               "codex-auto-review",
                               "gpt-5.5",
                               "gpt-5.5-openai-compact",
                               "gpt-5.6-luna",
                               "gpt-5.6-sol",
                               "gpt-5.6-sol-openai-compact",
                               "gpt-5.6-terra",
                               "gpt-5.6-terra-openai-compact",
                               "gpt-6-astra",
                               "gpt-6-sol",
                               "gpt-6.1-sol",
                               "gpt-4.1",
                               "gpt-4.1-mini",
                               "gpt-4o",
                               "gpt-4o-mini",
                               "gpt-5-mini",
                               "gpt-5.4",
                               "gpt-5.4-mini",
                               "o1",
                               "o3-mini",
                               "text-embedding-3-large",
                               "text-embedding-3-small",
                               "text-embedding-ada-002",
                               "gpt-5.1",
                               "gpt-5.2",
                               "gpt-5.3-codex",
                               "gpt-6-luna",
                               "gpt-5.5-pro",
                               "gemini-2.5-flash",
                               "gemini-2.5-flash-image",
                               "gemini-2.5-pro",
                               "gemini-3-flash-preview",
                               "gemini-3-pro-image",
                               "gemini-3-pro-image-preview",
                               "gemini-3-pro-preview",
                               "gemini-3.1-flash-image",
                               "gemini-3.1-flash-image-preview",
                               "gemini-3.1-flash-lite",
                               "gemini-3.1-flash-lite-image",
                               "gemini-3.1-flash-lite-preview",
                               "gemini-3.1-pro-preview",
                               "gemini-3.5-flash",
                               "gemini-3.5-flash-lite",
                               "gemini-3.6-flash",
                               "gemini-3.7-flash",
                               "gemini-3.8-flash",
                               "gemini-embedding-001",
                               "gemini-embedding-2-preview",
                               "claude-haiku-4-5-20251001-r",
                               "claude-opus-4-6-r",
                               "claude-opus-4-7-r",
                               "claude-opus-4-8-r",
                               "claude-opus-5-5-r",
                               "claude-opus-5-r",
                               "claude-sonnet-4-6-r",
                               "claude-sonnet-5-r",
                               "gemini-2.5-flash-r",
                               "gemini-2.5-pro-r",
                               "gemini-3-flash-preview-r",
                               "gemini-3-pro-preview-r",
                               "gemini-3.1-flash-lite-r",
                               "gemini-3.1-pro-preview-r",
                               "gemini-3.5-flash-lite-r",
                               "gemini-3.5-flash-r",
                               "gemini-3.6-flash-r",
                               "gemini-3.7-flash-r",
                               "gemini-3.8-flash-r",
                               "gemini-3-pro-image-c",
                               "gemini-3.1-flash-image-c",
                               "gpt-image-2-c",
                               "gpt-image-2-h",
                               "gpt-image-2.5-c",
                               "gpt-image-2.5-flare-h",
                               "gpt-image-2.5-sunburst-h",
                               "[free]deepseek-v4.1-flash",
                               "[free]kimi-k3",
                               "[SP]claude-fable-5",
                               "[SP]claude-fable-5-1",
                               "[SP]claude-opus-4-6",
                               "[SP]claude-opus-4-7",
                               "[SP]claude-opus-4-8",
                               "[SP]claude-opus-5",
                               "[SP]claude-opus-5-5",
                               "[SP]claude-sonnet-4-6",
                               "[SP]claude-sonnet-5",
                               "[SP]deepseek-v4-flash",
                               "[SP]deepseek-v4-pro",
                               "[SP]deepseek-v4.1-flash",
                               "[SP]gemini-3.1-pro-preview",
                               "[次]claude-fable-5",
                               "[次]claude-fable-5-1",
                               "[次]claude-opus-4-5",
                               "[次]claude-opus-4-5-thinking",
                               "[次]claude-opus-4-6",
                               "[次]claude-opus-4-6-thinking",
                               "[次]claude-opus-4-7",
                               "[次]claude-opus-4-7-thinking",
                               "[次]claude-opus-4-8",
                               "[次]claude-opus-5",
                               "[次]claude-opus-5-5",
                               "[次]claude-sonnet-4-6",
                               "[次]claude-sonnet-4-6-thinking",
                               "[次]claude-sonnet-5",
                               "[次]deepseek-v4-flash",
                               "[次]deepseek-v4-pro",
                               "[次]deepseek-v4.1-flash",
                               "[次]gemini-2.5-pro",
                               "[次]gemini-3-flash-preview",
                               "[次]gemini-3-pro-preview",
                               "[次]gemini-3.1-pro-preview",
                               "[次]gemini-3.5-flash",
                               "[次]gemini-3.6-flash",
                               "[次]gemini-3.7-flash",
                               "[次]gemini-3.8-flash",
                               "[次]glm-5.1",
                               "[次]glm-5.2",
                               "[次]glm-5.3",
                               "[次]glm-5.3-flash",
                               "[次]grok-4.5",
                               "[次]grok-4.6",
                               "[次]grok-4.7",
                               "grok-4.5",
                               "grok-4.5-latest",
                               "grok-4.6",
                               "grok-4.7",
                               "grok-composer-2.5-fast",
                               "grok-4.20-0309-non-reasoning",
                               "grok-4.20-0309-reasoning",
                               "grok-4.20-multi-agent-0309",
                               "grok-4.3",
                               "grok-build-0.1",
                               "glm-5.2",
                               "glm-5.3",
                               "glm-5.3-flash",
                               "kimi-k3"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smuws1slbio",
                "name":  "xxl",
                "endpoint":  "https://ai.1tim.com/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "gpt-image-2.5-sunburst",
                "models":  [
                               "gpt-image-2.5-flare",
                               "gpt-image-2.5-flare-auto",
                               "gpt-image-2.5-sunburst"
                           ],
                "size":  "1024×1792",
                "quality":  "max"
            },
            {
                "id":  "smux1tna14q",
                "name":  "gg",
                "endpoint":  "https://gcli.ggchan.dev/v1",
                "key":  "sk-在此填入你的Key",
                "model":  "agy-gemini-3.1-flash-image",
                "models":  [
                               "gemini-2.5-pro",
                               "gemini-2.5-pro-maxthinking",
                               "gemini-2.5-pro-nothinking",
                               "gemini-2.5-pro-search",
                               "假流式-gemini-2.5-pro",
                               "假流式-gemini-2.5-pro-maxthinking",
                               "假流式-gemini-2.5-pro-nothinking",
                               "假流式-gemini-2.5-pro-search",
                               "gemini-3.1-pro-preview",
                               "gemini-3.1-pro-preview-nothinking",
                               "gemini-3.1-pro-preview-search",
                               "假流式-gemini-3.1-pro-preview",
                               "假流式-gemini-3.1-pro-preview-nothinking",
                               "假流式-gemini-3.1-pro-preview-search",
                               "gemini-3-flash-preview",
                               "gemini-3-flash-preview-search",
                               "假流式-gemini-3-flash-preview",
                               "假流式-gemini-3-flash-preview-search",
                               "gemini-3.8-flash",
                               "gemini-3.8-flash-search",
                               "假流式-gemini-3.8-flash",
                               "假流式-gemini-3.8-flash-search",
                               "gemini-3.1-flash-lite",
                               "抗截断-gemini-3.8-flash",
                               "抗截断-gemini-3.1-pro-preview",
                               "gemini-2.5-pro-cache",
                               "假流式-gemini-2.5-pro-cache",
                               "gemini-3.1-pro-preview-cache",
                               "假流式-gemini-3.1-pro-preview-cache",
                               "agy-claude-opus-4-6",
                               "agy-claude-opus-4-6-thinking",
                               "agy-claude-sonnet-4-6",
                               "agy-gemini-2.5-flash",
                               "假流式-agy-gemini-2.5-flash",
                               "agy-gemini-2.5-flash-lite",
                               "假流式-agy-gemini-2.5-flash-lite",
                               "agy-gemini-2.5-flash-thinking",
                               "假流式-agy-gemini-2.5-flash-thinking",
                               "agy-gemini-3-flash",
                               "假流式-agy-gemini-3-flash",
                               "agy-gemini-3-flash-agent",
                               "假流式-agy-gemini-3-flash-agent",
                               "agy-gemini-3.1-flash-image",
                               "假流式-agy-gemini-3.1-flash-image",
                               "agy-gemini-3.1-flash-lite",
                               "假流式-agy-gemini-3.1-flash-lite",
                               "agy-gemini-3.1-pro-high",
                               "假流式-agy-gemini-3.1-pro-high",
                               "agy-gemini-3.1-pro-low",
                               "假流式-agy-gemini-3.1-pro-low",
                               "agy-gemini-3.5-flash-extra-low",
                               "假流式-agy-gemini-3.5-flash-extra-low",
                               "agy-gemini-3.5-flash-low",
                               "假流式-agy-gemini-3.5-flash-low",
                               "agy-gemini-3.6-flash",
                               "假流式-agy-gemini-3.6-flash",
                               "agy-gemini-3.6-flash-high",
                               "假流式-agy-gemini-3.6-flash-high",
                               "agy-gemini-3.6-flash-medium",
                               "假流式-agy-gemini-3.6-flash-medium",
                               "agy-gemini-3.6-flash-low",
                               "假流式-agy-gemini-3.6-flash-low",
                               "agy-gemini-3.7-flash",
                               "假流式-agy-gemini-3.7-flash",
                               "agy-gemini-3.7-flash-high",
                               "假流式-agy-gemini-3.7-flash-high",
                               "agy-gemini-3.7-flash-medium",
                               "假流式-agy-gemini-3.7-flash-medium",
                               "agy-gemini-3.7-flash-low",
                               "假流式-agy-gemini-3.7-flash-low",
                               "agy-gemini-3.8-flash-high",
                               "假流式-agy-gemini-3.8-flash-high",
                               "agy-gemini-3.8-flash-medium",
                               "假流式-agy-gemini-3.8-flash-medium",
                               "agy-gemini-3.8-flash-low",
                               "假流式-agy-gemini-3.8-flash-low",
                               "agy-gemini-pro-agent",
                               "假流式-agy-gemini-pro-agent",
                               "agy-gpt-oss-120b-medium"
                           ],
                "size":  "896×1536"
            }
        ];
    const BUILTIN_EXT_PROFILES =
        [
        {
            "id":  "smu0ujfttce",
            "name":  "默认",
            "models":  [
                           "gemini-2.5-pro",
                           "gemini-2.5-pro-maxthinking",
                           "gemini-2.5-pro-nothinking",
                           "gemini-2.5-pro-search",
                           "假流式-gemini-2.5-pro",
                           "假流式-gemini-2.5-pro-maxthinking",
                           "假流式-gemini-2.5-pro-nothinking",
                           "假流式-gemini-2.5-pro-search",
                           "gemini-3.1-pro-preview",
                           "gemini-3.1-pro-preview-nothinking",
                           "gemini-3.1-pro-preview-search",
                           "假流式-gemini-3.1-pro-preview",
                           "假流式-gemini-3.1-pro-preview-nothinking",
                           "假流式-gemini-3.1-pro-preview-search",
                           "gemini-3-flash-preview",
                           "gemini-3-flash-preview-search",
                           "假流式-gemini-3-flash-preview",
                           "假流式-gemini-3-flash-preview-search",
                           "gemini-3.8-flash",
                           "gemini-3.8-flash-search",
                           "假流式-gemini-3.8-flash",
                           "假流式-gemini-3.8-flash-search",
                           "gemini-3.1-flash-lite",
                           "抗截断-gemini-3.8-flash",
                           "抗截断-gemini-3.1-pro-preview",
                           "gemini-2.5-pro-cache",
                           "假流式-gemini-2.5-pro-cache",
                           "gemini-3.1-pro-preview-cache",
                           "假流式-gemini-3.1-pro-preview-cache",
                           "agy-claude-opus-4-6",
                           "agy-claude-opus-4-6-thinking",
                           "agy-claude-sonnet-4-6",
                           "agy-gemini-2.5-flash",
                           "假流式-agy-gemini-2.5-flash",
                           "agy-gemini-2.5-flash-lite",
                           "假流式-agy-gemini-2.5-flash-lite",
                           "agy-gemini-2.5-flash-thinking",
                           "假流式-agy-gemini-2.5-flash-thinking",
                           "agy-gemini-3-flash",
                           "假流式-agy-gemini-3-flash",
                           "agy-gemini-3-flash-agent",
                           "假流式-agy-gemini-3-flash-agent",
                           "agy-gemini-3.1-flash-image",
                           "假流式-agy-gemini-3.1-flash-image",
                           "agy-gemini-3.1-flash-lite",
                           "假流式-agy-gemini-3.1-flash-lite",
                           "agy-gemini-3.1-pro-high",
                           "假流式-agy-gemini-3.1-pro-high",
                           "agy-gemini-3.1-pro-low",
                           "假流式-agy-gemini-3.1-pro-low",
                           "agy-gemini-3.5-flash-extra-low",
                           "假流式-agy-gemini-3.5-flash-extra-low",
                           "agy-gemini-3.5-flash-low",
                           "假流式-agy-gemini-3.5-flash-low",
                           "agy-gemini-3.6-flash",
                           "假流式-agy-gemini-3.6-flash",
                           "agy-gemini-3.6-flash-high",
                           "假流式-agy-gemini-3.6-flash-high",
                           "agy-gemini-3.6-flash-medium",
                           "假流式-agy-gemini-3.6-flash-medium",
                           "agy-gemini-3.6-flash-low",
                           "假流式-agy-gemini-3.6-flash-low",
                           "agy-gemini-3.7-flash",
                           "假流式-agy-gemini-3.7-flash",
                           "agy-gemini-3.7-flash-high",
                           "假流式-agy-gemini-3.7-flash-high",
                           "agy-gemini-3.7-flash-medium",
                           "假流式-agy-gemini-3.7-flash-medium",
                           "agy-gemini-3.7-flash-low",
                           "假流式-agy-gemini-3.7-flash-low",
                           "agy-gemini-3.8-flash-high",
                           "假流式-agy-gemini-3.8-flash-high",
                           "agy-gemini-3.8-flash-medium",
                           "假流式-agy-gemini-3.8-flash-medium",
                           "agy-gemini-3.8-flash-low",
                           "假流式-agy-gemini-3.8-flash-low",
                           "agy-gemini-pro-agent",
                           "假流式-agy-gemini-pro-agent",
                           "agy-gpt-oss-120b-medium"
                       ],
            "endpoint":  "https://gcli.ggchan.dev/v1",
            "key":  "sk-在此填入你的Key",
            "model":  "gemini-3.1-pro-preview"
        }
        ];

    let currentDesc = "", currentIdx = -1, processing = false, initialized = false;
    let extractEpoch = 0;
    const extAborts = new Set();
    /* 在飞的生图控制器。并发是真会发生的（主模型自己写标记那条路是串行循环，
       不受提取锁管；她同时手点另一楼的 🖼 就并发了），单例会被后发者覆盖，
       先发的那个就再也停不掉、钱继续烧。 */
    const genAborts = new Set();
    let retryTimer = null, autoTimer = null, pendingAutoIdx = -1;
    let layersFresh = false;      // 分层框里的内容是否有效（来自成功分层或用户手改）
    let panelVisible = false;
    const genBusy = {};           // "楼号:槽位" → true，正在生图的槽
    const collapsed = {};         // "楼号:槽位" → true，图被折叠起来了

    /* ============================================================
       小工具
       ============================================================ */
    function ctx() { return SillyTavern.getContext(); }
    function q(s) { try { return document.querySelector(s); } catch (e) { return null; } }
    function qa(s) { try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return []; } }

    function esc(s) {
        if (s == null) return "";
        const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML.replace(/"/g, "&quot;");
    }
    function escRe(s) { return String(s || "").replace(/[.*+?${}()|[\]\\]/g, "\\$&"); }
    function safeJson(text, fb) { try { return JSON.parse(String(text || "")); } catch (e) { return fb; } }
    function toast(msg, ok) {
        try {
            const t = window.toastr;
            if (!t) throw new Error("no toastr");
            if (ok === false) t.error(msg, "", { timeOut: 5000 });
            else if (ok === null) t.info(msg, "", { timeOut: 3000 });
            else t.success(msg, "", { timeOut: 3000 });
        } catch (e) { console.log(LOG, msg); }
    }
    function log() { try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {} }

    function cfg() {
        try { return ctx().extensionSettings[EXT_KEY]; } catch (e) { return Object.assign({}, DEFAULTS); }
    }
    function saveNow() {
        try {
            const c = ctx();
            if (c && typeof c.saveSettings === "function") c.saveSettings();
            else if (c && typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced();
        } catch (e) {}
    }
    function save(key, val) {
        try {
            const c = ctx();
            c.extensionSettings[EXT_KEY][key] = val;
            if (typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced();
            else saveNow();
        } catch (e) {}
    }
    function saveCritical(key, val) {
        try { const c = ctx(); c.extensionSettings[EXT_KEY][key] = val; saveNow(); } catch (e) {}
    }

    function loadSettings() {
        try {
            const es = ctx().extensionSettings;
            if (!es[EXT_KEY]) es[EXT_KEY] = {};
            const st = es[EXT_KEY];
            for (const [k, v] of Object.entries(DEFAULTS)) {
                if (st[k] === undefined) st[k] = (v && typeof v === "object") ? Object.assign({}, v) : v;
            }
            if (!st.layerLocks || typeof st.layerLocks !== "object") st.layerLocks = {};
            /* 1.8.2：撤销 1.8.1 那次把「超时」从 0 强抬到 180 的迁移。
               thinking 模型想得久，180 秒会把慢站点掐断；锁死问题交给看门狗兜，
               不该替她改请求行为。只回退迁移写进去的那个 180，她自己填的值不动。 */
            if (st.migrated173 && !st.migrated182) {
                if (Number(st.requestTimeout) === 180) st.requestTimeout = 0;
                st.migrated182 = true;
            }
            /* 1.5：楼层图默认撑满楼层宽度 */
            if (!st.migrated15) {
                if (Number(st.imageMaxWidth) === 60) st.imageMaxWidth = 100;
                st.migrated15 = true;
            }
            /* 1.4：楼层里的提示词文字一律收起；老站点收进站点列表 */
            if (!st.migrated14) {
                st.hideTagText = true;
                st.migrated14 = true;
            }
            if (!st.tplMigrated13) {
                if (String(st.template || "").trim() === ALT_TEMPLATE || !String(st.template || "").trim()) st.template = DEFAULT_TEMPLATE;
                st.tplMigrated13 = true;
            }
            if (!st.extSystemPromptsJson) {
                st.extSystemPromptsJson = JSON.stringify([
                    { id: "sys_emo", name: "情感", value: DEFAULT_SYS_EMO },
                    { id: "sys_plot", name: "剧情", value: DEFAULT_SYS_PLOT }
                ]);
            }
            /* 1.7：首次安装播种内置站点档案（与 Tavo 生图工坊 v1.18.16 同款）；只播一次，已有站点不动，之后完全由用户自管 */
            if (!st.sdgBuiltinSeeded17) {
                const seedFlat = function (list, id, flatMap) {
                    const cur = list.filter(function (p) { return p.id === id; })[0] || list[0];
                    if (!cur) return;
                    for (const f in flatMap) st[flatMap[f]] = String(cur[f] == null ? "" : cur[f]);
                };
                const genList = safeJson(st.genProfilesJson, null);
                if (!Array.isArray(genList) || !genList.length) {
                    st.genProfilesJson = JSON.stringify(BUILTIN_GEN_PROFILES);
                    st.genProfileId = BUILTIN_GEN_PROFILE_ID;
                    seedFlat(BUILTIN_GEN_PROFILES, BUILTIN_GEN_PROFILE_ID,
                        { endpoint: "genEndpoint", key: "genKey", model: "genModel", size: "grokSize", quality: "genQuality" });
                }
                const extList = safeJson(st.extProfilesJson, null);
                if (!Array.isArray(extList) || !extList.length) {
                    st.extProfilesJson = JSON.stringify(BUILTIN_EXT_PROFILES);
                    st.extProfileId = BUILTIN_EXT_PROFILE_ID;
                    seedFlat(BUILTIN_EXT_PROFILES, BUILTIN_EXT_PROFILE_ID,
                        { endpoint: "extEndpoint", key: "extKey", model: "extModel" });
                }
                st.sdgBuiltinSeeded17 = true;
            }
            /* 1.7.1：老默认延迟 1800ms 偏保守（消息在事件回调时已落库），没自定义过的降到 800ms，自定义值不动 */
            if (!st.sdgDelayFast171) {
                if (Number(st.autoDelay) === 1800) st.autoDelay = 800;
                st.sdgDelayFast171 = true;
            }
        } catch (e) { console.error(LOG, "loadSettings:", e); }
    }

    function getSystemPrompts() {
        const list = safeJson(cfg().extSystemPromptsJson, []);
        return Array.isArray(list) && list.length ? list : [{ id: "sys_emo", name: "情感", value: DEFAULT_SYS_EMO }];
    }
    function activeSystemPrompt() {
        const list = getSystemPrompts();
        const id = cfg().extActiveSystemPrompt;
        for (const p of list) if (p.id === id) return p;
        return list[0];
    }

    /* ============================================================
       多站点（提取 / 生图各一套，可存多个随意切换）
       每个站点 = { id, name, endpoint, key, model, models[], size }
       当前站点的值同时写进老的扁平字段（extEndpoint 等），下游代码不用改
       ============================================================ */
    const PROF_FIELDS = {
        ext: { endpoint: "extEndpoint", key: "extKey", model: "extModel" },
        gen: { endpoint: "genEndpoint", key: "genKey", model: "genModel", size: "grokSize", quality: "genQuality" }
    };
    function profJsonKey(kind) { return kind === "gen" ? "genProfilesJson" : "extProfilesJson"; }
    function profIdKey(kind) { return kind === "gen" ? "genProfileId" : "extProfileId"; }
    function newId() { return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36); }

    function snapshotProfile(kind, name) {
        const map = PROF_FIELDS[kind], c = cfg(), p = { id: newId(), name: name || "站点1", models: [] };
        for (const f in map) p[f] = c[map[f]] || "";
        return p;
    }
    function getProfiles(kind) {
        let list = safeJson(cfg()[profJsonKey(kind)], []);
        if (!Array.isArray(list)) list = [];
        list = list.filter(function (p) { return p && p.id; });
        if (!list.length) {
            list = [snapshotProfile(kind, "默认")];
            saveCritical(profJsonKey(kind), JSON.stringify(list));
            saveCritical(profIdKey(kind), list[0].id);
        }
        return list;
    }
    function saveProfiles(kind, list) { saveCritical(profJsonKey(kind), JSON.stringify(list)); }
    function activeProfile(kind) {
        const list = getProfiles(kind), id = cfg()[profIdKey(kind)];
        for (const p of list) if (p.id === id) return p;
        return list[0];
    }
    /* 把站点的值刷进扁平字段（切站点时用） */
    function applyProfile(kind, p) {
        const map = PROF_FIELDS[kind];
        for (const f in map) save(map[f], String(p[f] == null ? "" : p[f]));
    }
    /* 用户改了某个字段：扁平字段 + 当前站点一起存 */
    function saveProfileField(kind, field, val) {
        const map = PROF_FIELDS[kind];
        if (map[field]) save(map[field], val);
        const list = getProfiles(kind), cur = activeProfile(kind);
        for (const p of list) if (p.id === cur.id) p[field] = val;
        saveProfiles(kind, list);
    }
    function setProfileModels(kind, models) {
        const list = getProfiles(kind), cur = activeProfile(kind);
        for (const p of list) if (p.id === cur.id) p.models = models.slice(0, 400);
        saveProfiles(kind, list);
    }
    function switchProfile(kind, id) {
        const list = getProfiles(kind);
        for (const p of list) {
            if (p.id !== id) continue;
            saveCritical(profIdKey(kind), id);
            applyProfile(kind, p);
            refreshSiteUI(kind);
            setStatus("已切到站点「" + (p.name || "未命名") + "」", C_OK);
            return;
        }
    }
    function addProfile(kind) {
        const list = getProfiles(kind);
        const name = window.prompt("新站点名字", "站点" + (list.length + 1));
        if (name === null) return;
        const p = { id: newId(), name: String(name).trim() || "站点" + (list.length + 1), endpoint: "", key: "", model: "", models: [] };
        if (kind === "gen") { p.size = cfg().grokSize || "1024x1024"; p.quality = cfg().genQuality || ""; }
        list.push(p);
        saveProfiles(kind, list);
        saveCritical(profIdKey(kind), p.id);
        applyProfile(kind, p);
        refreshSiteUI(kind);
        setStatus("已新建站点「" + p.name + "」，填地址和 Key", C_OK);
    }
    function renameProfile(kind) {
        const list = getProfiles(kind), cur = activeProfile(kind);
        const name = window.prompt("改名", cur.name || "");
        if (name === null) return;
        for (const p of list) if (p.id === cur.id) p.name = String(name).trim() || p.name;
        saveProfiles(kind, list);
        refreshSiteUI(kind);
    }
    function delProfile(kind) {
        let list = getProfiles(kind);
        if (list.length <= 1) { setStatus("只剩一个站点了，删不了", C_WARN); return; }
        const cur = activeProfile(kind);
        if (!window.confirm("删掉站点「" + (cur.name || "") + "」？")) return;
        list = list.filter(function (p) { return p.id !== cur.id; });
        saveProfiles(kind, list);
        saveCritical(profIdKey(kind), list[0].id);
        applyProfile(kind, list[0]);
        refreshSiteUI(kind);
    }

    /* ============================================================
       文本预设（画风 / 提取规则 / 角色锚点 各一套，可存多个下拉切）
       每套 = { jsonKey, idKey, fields: {字段名: 扁平cfg键}, label, selId }
       当前预设的值同时写进扁平字段，下游生图/提取代码不用改。
       画风 = 拼在生图提示词前后的风格词；提取规则 = 给副AI的写法要求；锚点 = 角色外貌资料。三者互不相干。
       ============================================================ */
    const PRESETS = {
        style:   { jsonKey: "stylesJson",  idKey: "styleId",   label: "画风",     selId: "#sdg-style",   fields: { fixed: "genFixedPrompt", postfix: "genPostfixPrompt" }, inputs: { fixed: "#sdg-gen-fixed", postfix: "#sdg-gen-postfix" } },
        rules:   { jsonKey: "rulesJson",   idKey: "rulesId",   label: "提取规则", selId: "#sdg-rules-p", fields: { text: "extRules" },   inputs: { text: "#sdg-rules" } },
        anchors: { jsonKey: "anchorsJson", idKey: "anchorsId", label: "角色锚点", selId: "#sdg-anch-p",  fields: { text: "extAnchors" }, inputs: { text: "#sdg-anchors" } }
    };
    function getPresets(kind) {
        const P = PRESETS[kind];
        let list = safeJson(cfg()[P.jsonKey], []);
        if (!Array.isArray(list)) list = [];
        list = list.filter(function (p) { return p && p.id; });
        if (!list.length) {
            const c = cfg(), p = { id: newId(), name: "默认" };
            for (const f in P.fields) p[f] = c[P.fields[f]] || "";
            list = [p];
            saveCritical(P.jsonKey, JSON.stringify(list));
            saveCritical(P.idKey, p.id);
        }
        return list;
    }
    function activePreset(kind) {
        const list = getPresets(kind), id = cfg()[PRESETS[kind].idKey];
        for (const p of list) if (p.id === id) return p;
        return list[0];
    }
    function applyPreset(kind, p) {
        const P = PRESETS[kind];
        for (const f in P.fields) save(P.fields[f], String(p[f] == null ? "" : p[f]));
    }
    function savePresetField(kind, field, val) {
        const P = PRESETS[kind];
        if (P.fields[field]) save(P.fields[field], val);
        const list = getPresets(kind), cur = activePreset(kind);
        for (const p of list) if (p.id === cur.id) p[field] = val;
        saveCritical(P.jsonKey, JSON.stringify(list));
    }
    function switchPreset(kind, id) {
        const P = PRESETS[kind];
        for (const p of getPresets(kind)) {
            if (p.id !== id) continue;
            saveCritical(P.idKey, id);
            applyPreset(kind, p);
            refreshPresetUI(kind);
            setStatus("已切到" + P.label + "「" + (p.name || "未命名") + "」", C_OK);
            return;
        }
    }
    function addPreset(kind) {
        const P = PRESETS[kind], list = getPresets(kind);
        const name = window.prompt("新" + P.label + "名字", P.label + (list.length + 1));
        if (name === null) return;
        const p = { id: newId(), name: String(name).trim() || P.label + (list.length + 1) };
        for (const f in P.fields) p[f] = "";
        list.push(p);
        saveCritical(P.jsonKey, JSON.stringify(list));
        saveCritical(P.idKey, p.id);
        applyPreset(kind, p);
        refreshPresetUI(kind);
        setStatus("已新建" + P.label + "「" + p.name + "」", C_OK);
    }
    function renamePreset(kind) {
        const P = PRESETS[kind], list = getPresets(kind), cur = activePreset(kind);
        const name = window.prompt("改名", cur.name || "");
        if (name === null) return;
        for (const p of list) if (p.id === cur.id) p.name = String(name).trim() || p.name;
        saveCritical(P.jsonKey, JSON.stringify(list));
        refreshPresetUI(kind);
    }
    function delPreset(kind) {
        const P = PRESETS[kind];
        let list = getPresets(kind);
        if (list.length <= 1) { setStatus("只剩一个" + P.label + "了，删不了", C_WARN); return; }
        const cur = activePreset(kind);
        if (!window.confirm("删掉" + P.label + "「" + (cur.name || "") + "」？")) return;
        list = list.filter(function (p) { return p.id !== cur.id; });
        saveCritical(P.jsonKey, JSON.stringify(list));
        saveCritical(P.idKey, list[0].id);
        applyPreset(kind, list[0]);
        refreshPresetUI(kind);
    }
    function refreshPresetUI(kind) {
        const P = PRESETS[kind], list = getPresets(kind), cur = activePreset(kind);
        const sel = q(P.selId);
        if (sel) {
            sel.innerHTML = list.map(function (p) {
                return '<option value="' + esc(p.id) + '"' + (p.id === cur.id ? " selected" : "") + '>' + esc(p.name || "未命名") + '</option>';
            }).join("");
        }
        for (const f in P.inputs) { const el = q(P.inputs[f]); if (el) el.value = cfg()[P.fields[f]] || ""; }
    }
    function presetRowHTML(kind, title, extraBtns) {
        const P = PRESETS[kind], id = P.selId.slice(1);
        return field(title, '<div class="sdg-siterow">' +
            '<select id="' + id + '"></select>' +
            '<button type="button" class="sdg-minibtn sdg-p-add" data-k="' + kind + '" title="新建">＋</button>' +
            '<button type="button" class="sdg-minibtn sdg-p-ren" data-k="' + kind + '" title="改名">✎</button>' +
            '<button type="button" class="sdg-minibtn sdg-p-del" data-k="' + kind + '" title="删除">🗑</button>' +
            (extraBtns || "") +
        '</div>');
    }
    function bindPresets() {
        for (const kind in PRESETS) {
            const P = PRESETS[kind];
            const sel = q(P.selId);
            if (sel) sel.addEventListener("change", function (e) { switchPreset(kind, e.target.value); });
            for (const f in P.inputs) {
                const el = q(P.inputs[f]);
                if (el) el.addEventListener("change", function (e) { savePresetField(kind, f, e.target.value); });
            }
            refreshPresetUI(kind);
        }
        qa(".sdg-p-add").forEach(function (b) { b.addEventListener("click", function () { addPreset(b.getAttribute("data-k")); }); });
        qa(".sdg-p-ren").forEach(function (b) { b.addEventListener("click", function () { renamePreset(b.getAttribute("data-k")); }); });
        qa(".sdg-p-del").forEach(function (b) { b.addEventListener("click", function () { delPreset(b.getAttribute("data-k")); }); });

        /* 画风 JSON 导入 / 导出；导入同时兼容预设包（模板/规则/系统提示/锚点一起归并） */
        const btnExp = q("#sdg-style-export"); if (btnExp) btnExp.addEventListener("click", styleExportFile);
        const btnImp = q("#sdg-style-import"); if (btnImp) btnImp.addEventListener("click", stylePickAndImport);
        const fileInp = q("#sdg-style-file");
        if (fileInp) fileInp.addEventListener("change", function (e) {
            const f = e.target.files && e.target.files[0];
            if (f) {
                const reader = new FileReader();
                reader.onload = function () { try { packImportText(String(reader.result || "")); } catch (err) { setStatus("导入失败：" + (err && err.message || err), C_ERR); } };
                reader.onerror = function () { setStatus("读文件失败，再试一次", C_ERR); };
                reader.readAsText(f, "utf-8");
            }
            try { e.target.value = ""; } catch (ev) {}
        });
    }

    /* ============================================================
       画风预设 JSON 导入 / 导出
       · 导出：drawgen-style-pack 包，只含画风，不含 API 与密钥
       · 导入：画风包（styles 数组）按名字合并；
         预设包（templates 数组 / ipe-image-pack 格式）的模板转画风，
         规则 / 系统提示 / 角色锚点各自归并；按名字合并不清空现有内容
       ============================================================ */
    const STYLE_PACK_FMT = "drawgen-style-pack";
    const LEGACY_PACK_FMT = "ipe-image-pack";   /* 兼容旧版预设包导出格式的识别标记 */
    function stylePackBuild() {
        const styles = getPresets("style").map(function (p) {
            return { name: p.name || "未命名", fixed: p.fixed || "", postfix: p.postfix || "" };
        });
        const d = new Date();
        const p2 = function (n) { return String(n).padStart(2, "0"); };
        const stamp = "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
        return { _fmt: STYLE_PACK_FMT, version: VERSION, exportedAt: stamp, styles: styles };
    }
    function styleExportFile() {
        try {
            const pack = stylePackBuild();
            const d = new Date();
            const p2 = function (n) { return String(n).padStart(2, "0"); };
            const stamp = "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
            const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "drawgen-styles-" + stamp + ".json";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
            setStatus("已导出画风 JSON ✓ 共 " + pack.styles.length + " 套", C_OK);
        } catch (e) {
            setStatus("导出失败：" + (e && e.message || e), C_ERR);
        }
    }
    function stylePickAndImport() { const el = q("#sdg-style-file"); if (el) el.click(); }

    function styleItemFromRaw(raw) {
        const it = raw || {};
        const out = { name: String(it.name || it.title || "未命名").trim() || "未命名", fixed: "", postfix: "" };
        if (it.fixed != null || it.postfix != null) { out.fixed = String(it.fixed || ""); out.postfix = String(it.postfix || ""); return out; }
        if (it.prefix != null || it.suffix != null) { out.fixed = String(it.prefix || ""); out.postfix = String(it.suffix || ""); return out; }
        out.postfix = String(it.value != null ? it.value : (it.text != null ? it.text : (it.content != null ? it.content : (it.prompt || ""))));
        return out;
    }

    /* 预设包模板：占位符脚手架（Composition: {Camera} …）进前缀，其余风格正文进后缀；
       旧包写死五标签合同，导入时机械升级为六标签（只动标签枚举） */
    function packSixTagText(v) {
        return String(v == null ? "" : v)
            .replace(/Camera\s*\/\s*Setting\s*\/\s*Mood\s*\/\s*Characters\s*\/\s*Pose/g, "Camera / Setting / Mood / Characters / Outfit / Pose")
            .replace(/镜头\s*\/\s*环境\s*\/\s*氛围\s*\/\s*人物\s*\/\s*动作/g, "镜头 / 环境 / 氛围 / 人物 / 服装 / 动作")
            .replace(/\{Camera\}\/\{Setting\}\/\{Mood\}\/\{Characters\}\/\{Pose\}/g, "{Camera}/{Setting}/{Mood}/{Characters}/{Outfit}/{Pose}")
            .replace(/\{Camera\}\s*\/\s*\{Env\}\s*\/\s*\{Mood\}\s*\/\s*\{Chars\}\s*\/\s*\{Pose\}/g, "{Camera}/{Env}/{Mood}/{Chars}/{Outfit}/{Pose}");
    }
    function packTemplateSplit(raw) {
        let v = packSixTagText(raw);
        const ph = /\{(?:Camera|Env|Setting|Mood|Chars|Characters|Outfit|Pose|Description)\}/;
        const lines = v.split(/\r?\n/);
        let cut = 0;
        while (cut < lines.length && ph.test(lines[cut])) cut++;
        const fixed = lines.slice(0, cut).join("\n").trim();
        const postfix = lines.slice(cut).join("\n").trim();
        if (fixed && postfix) return { fixed: fixed, postfix: postfix };
        return { fixed: "", postfix: v.trim() };
    }
    function packStyleItem(it) {
        const c = styleItemFromRaw(it);
        const sp = packTemplateSplit(it.value != null ? it.value : (it.postfix != null ? it.postfix : ""));
        if (sp.fixed || sp.postfix) return { name: c.name, fixed: sp.fixed, postfix: sp.postfix };
        return c;
    }
    function packTextItem(it) {
        const x = it || {};
        return {
            name: String(x.name || x.title || "未命名").trim() || "未命名",
            text: String(x.text != null ? x.text : (x.value != null ? x.value : (x.content != null ? x.content : (x.prompt || ""))))
        };
    }
    function packRuleItem(it) {
        const c = packTextItem(it);
        c.text = packSixTagText(c.text);
        return c;
    }
    function packSysItem(it) {
        const c = packTextItem(it);
        return { name: c.name, value: packSixTagText(c.text) };
    }

    /* 解析导入文件并按名字合并；返回 null=没变化，否则 {groups, same} */
    function packPlan(text) {
        let parsed;
        try { parsed = JSON.parse(String(text || "")); } catch (e) { throw new Error("这不是合法 JSON"); }
        const plan = { styles: [], rules: [], sys: [], anchors: [], kind: "style" };
        if (parsed && Array.isArray(parsed.styles)) {
            plan.kind = "style";
            plan.styles = parsed.styles;
        } else if (parsed && (parsed._fmt === LEGACY_PACK_FMT || (Array.isArray(parsed.templates) && !Array.isArray(parsed.styles)))) {
            plan.kind = "pack";
            plan.styles = parsed.templates || [];
            plan.rules = parsed.rules || parsed.extractionRules || [];
            plan.sys = parsed.systemPrompts || parsed.sysPrompts || parsed.prompts || [];
            plan.anchors = parsed.anchors || parsed.characterAnchors || [];
        } else if (Array.isArray(parsed)) {
            plan.kind = "style";
            plan.styles = parsed;
        } else if (parsed && (parsed.fixed != null || parsed.postfix != null || parsed.value != null || parsed.text != null)) {
            plan.kind = "style";
            plan.styles = [parsed];
        } else {
            throw new Error("不是可识别的预设包（画风包需要 styles 数组，预设包需要 templates 数组）");
        }
        return plan;
    }
    function packImportText(text) {
        const plan = packPlan(text);
        /* 合并计划：每组 {label, list(现有), incoming(清洗后), key(名字字段), valueFields}，算出新增/覆盖/相同 */
        const groups = [];
        const mkGroup = function (label, current, raw, cleaner, keyField, valueFields, jsonKey, idKey, flatMap) {
            const inc = (Array.isArray(raw) ? raw : []).map(cleaner).filter(function (x) {
                return x && String(x[keyField] || "").trim() && valueFields.some(function (f) { return String(x[f] || "").trim(); });
            });
            return { label: label, list: current, incoming: inc, key: keyField, fields: valueFields, jsonKey: jsonKey, idKey: idKey, flat: flatMap, add: 0, rep: 0, same: 0 };
        };
        groups.push(mkGroup("画风", getPresets("style"), plan.styles, plan.kind === "pack" ? packStyleItem : styleItemFromRaw, "name", ["fixed", "postfix"], PRESETS.style.jsonKey, PRESETS.style.idKey, PRESETS.style.fields));
        if (plan.kind === "pack") {
            groups.push(mkGroup("提取规则", getPresets("rules"), plan.rules, packRuleItem, "name", ["text"], PRESETS.rules.jsonKey, PRESETS.rules.idKey, PRESETS.rules.fields));
            groups.push(mkGroup("系统提示", getSystemPrompts(), plan.sys, packSysItem, "name", ["value"], "extSystemPromptsJson", "extActiveSystemPrompt", null));
            groups.push(mkGroup("角色锚点", getPresets("anchors"), plan.anchors, packRuleItem, "name", ["text"], PRESETS.anchors.jsonKey, PRESETS.anchors.idKey, PRESETS.anchors.fields));
        }
        let totalAdd = 0, totalRep = 0, totalSame = 0;
        groups.forEach(function (g) {
            g.incoming.forEach(function (incoming) {
                const nm = String(incoming[g.key]).trim();
                const found = g.list.find(function (p) { return String(p[g.key] || "").trim() === nm; });
                if (!found) { g.add++; return; }
                const changed = g.fields.some(function (f) { return String(found[f] == null ? "" : found[f]).trim() !== String(incoming[f] == null ? "" : incoming[f]).trim(); });
                if (changed) g.rep++; else g.same++;
            });
            totalAdd += g.add; totalRep += g.rep; totalSame += g.same;
        });
        const usable = groups.reduce(function (n, g) { return n + g.incoming.length; }, 0);
        if (!usable) { setStatus("包里没有可用的预设内容", C_WARN); return; }
        if (totalAdd === 0 && totalRep === 0) { setStatus("文件里的画风和现有完全一致，什么都没变", C_OK); return; }

        const lines = ["将导入预设包，按名字合并："];
        groups.forEach(function (g) {
            if (!g.incoming.length) return;
            lines.push("· " + g.label + "：新增 " + g.add + " / 覆盖 " + g.rep + (g.same ? " / 相同 " + g.same : ""));
        });
        lines.push("同名内容不同的会被覆盖，新增的追加，不会清空现有内容。继续吗？");
        if (totalAdd > 0 || totalRep > 0) {
            const msg = totalRep > 0
                ? ("将覆盖 " + totalRep + " 个同名预设，另新增 " + totalAdd + " 个。继续吗？（取消 = 什么都不动）\n\n" + lines.join("\n"))
                : lines.join("\n");
            if (!window.confirm(msg)) { setStatus("已取消导入，什么都没动", C_WARN); return; }
        }

        /* 落盘合并 */
        groups.forEach(function (g) {
            if (!g.incoming.length) return;
            g.incoming.forEach(function (incoming) {
                const nm = String(incoming[g.key]).trim();
                const found = g.list.find(function (p) { return String(p[g.key] || "").trim() === nm; });
                if (found) {
                    g.fields.forEach(function (f) { found[f] = incoming[f]; });
                } else {
                    const item = { id: newId() };
                    item[g.key] = nm;
                    g.fields.forEach(function (f) { item[f] = incoming[f]; });
                    g.list.push(item);
                }
            });
            saveCritical(g.jsonKey, JSON.stringify(g.list));
        });
        /* 刷新界面：画风/规则/锚点走预设行；系统提示重建下拉 */
        ["style", "rules", "anchors"].forEach(function (k) { try { refreshPresetUI(k); } catch (e) {} });
        try {
            const sysSel = q("#sdg-sys-select"), sysVal = q("#sdg-sys-value");
            if (sysSel) {
                const curId = cfg().extActiveSystemPrompt;
                sysSel.innerHTML = getSystemPrompts().map(function (p) {
                    return '<option value="' + esc(p.id) + '"' + (p.id === curId ? " selected" : "") + '>' + esc(p.name || "未命名") + '</option>';
                }).join("");
                if (sysVal) { const p = getSystemPrompts().find(function (x) { return x.id === sysSel.value; }); sysVal.value = p ? p.value : ""; }
            }
        } catch (e) {}
        const summary = groups.filter(function (g) { return g.incoming.length; }).map(function (g) {
            return g.label + " 新增" + g.add + "/覆盖" + g.rep;
        }).join("，");
        setStatus("导入完成 ✓ " + summary, C_OK);
        toast("✅ 导入完成：" + summary, true);
    }

    /* 兼容旧名 */
    function getStyles() { return getPresets("style"); }
    function activeStyle() { return activePreset("style"); }
    function refreshStyleUI() { refreshPresetUI("style"); }

    const C_OK = "var(--sdg-ok)", C_ERR = "var(--sdg-err)", C_WARN = "var(--sdg-warn)", C_DIM = "var(--sdg-dim)";    function setStatus(t, color) {
        const e = q("#sdg-status");
        if (e) { e.textContent = t; e.style.color = color || ""; }
    }
    function setPreview(t) {
        const e = q("#sdg-preview");
        if (e) e.value = String(t || "");
        currentDesc = String(t || "");
    }

    /* ============================================================
       分层提取核心
       ============================================================ */
    function layerBoxValues() {
        const out = {};
        LAYERS.forEach(function (l) {
            const el = q("#sdg-layer-" + l);
            out[l] = el ? String(el.value || "").trim() : "";
        });
        return out;
    }
    function anyLayer(layers) {
        if (!layers) return false;
        for (const l of LAYERS) if (String(layers[l] || "").trim()) return true;
        return false;
    }
    function setLayerBoxes(layers) {
        LAYERS.forEach(function (l) {
            const el = q("#sdg-layer-" + l);
            if (el) el.value = String((layers && layers[l]) || "");
        });
    }
    function cleanLayers(layers) {
        const out = {};
        LAYERS.forEach(function (l) { out[l] = String((layers && layers[l]) || "").trim(); });
        return out;
    }
    function layerLocks() {
        const lk = cfg().layerLocks;
        return (lk && typeof lk === "object") ? lk : {};
    }
    /* 上一楼的层：优先当前五框（用户可能手改过），否则从 idx 往前找楼层记录 */
    function prevLayers(idx) {
        const boxes = layerBoxValues();
        if (anyLayer(boxes)) return boxes;
        try {
            const chat = ctx().chat || [];
            let start = typeof idx === "number" && idx >= 0 ? idx : chat.length - 1;
            for (let k = start; k >= 0; k--) {
                const m = chat[k];
                if (m && m.extra && m.extra.sdg_layers && anyLayer(m.extra.sdg_layers)) return cleanLayers(m.extra.sdg_layers);
            }
        } catch (e) {}
        return null;
    }
    /* 给副AI的分层合同：五个标签 + 锁定层 + 可沿用层 */
    function layerContract(prev, locks) {
        const lines = [
            "任务：把正文拆成六层英文生图描述，按下面六个标签分节输出。标签外不要写任何东西；不要解释；不要标题；不要代码块；不要中文。",
            "<camera>景别、机位高度、视角、构图、景深。一到两句。</camera>",
            "<env>只写物理空间：地点、室内外、时间段、天气、关键背景与道具、背景人物的数量与动态。不写光线质感和情绪。两到三句。</env>",
            "<mood>这一楼的画面感觉，用画面载体写而不是堆形容词：光的方向与质地、色温、明暗对比、空气感（清透 / 潮湿 / 尘光）、天气细节、整体基调。一到三句。</mood>",
            "<chars>只写本楼实际出场且入镜的角色：按角色锚点校准外貌，再写此刻的表情与情绪状态。</chars>",
            "<outfit>只写服装与发型的当前状态：每位出场角色此刻穿什么、发型如何；基础着装按角色锚点校准。两三句以内。</outfit>",
            "<pose>动作与空间关系，写成明确的空间句：谁在哪、面朝哪、视线落在哪、手放在哪、身体接触点、相对位置与距离。</pose>"
        ];
        const lockLines = [];
        LAYERS.forEach(function (l) {
            if (locks && locks[l] && prev && String(prev[l] || "").trim()) lockLines.push("<" + l + ">" + prev[l] + "</" + l + ">");
        });
        if (lockLines.length) {
            lines.push("");
            lines.push("【已锁定的层 · 原样沿用，不要重写】");
            lines.push(lockLines.join("\n"));
            lines.push("锁定层只输出 " + NOCHANGE + " 即可；其余层必须与锁定层保持一致（同一空间、同一光线、同一批人）。");
        }
        if (prev && String(prev.env || "").trim() && !(locks && locks.env)) {
            lines.push("");
            lines.push("【上一楼的环境层】");
            lines.push(prev.env);
            lines.push("本楼地点、时间段、天气、道具都没变时，<env> 里只写 " + NOCHANGE + "，其余层照常输出。换了场景才重写环境。");
        }
    if (prev && String(prev.mood || "").trim() && !(locks && locks.mood)) {
        lines.push("");
        lines.push("【上一楼的氛围层】");
        lines.push(prev.mood);
        lines.push("本楼光线、色温、情绪基调都没变时，<mood> 里只写 " + NOCHANGE + "。情绪转折、光线变化就重写。");
    }
    if (prev && String(prev.outfit || "").trim() && !(locks && locks.outfit)) {
        lines.push("");
        lines.push("【上一楼的服装层】");
        lines.push(prev.outfit);
        lines.push("本楼没人换装、发型没变时，<outfit> 里只写 " + NOCHANGE + "，其余层照常输出。有换装或发型变化才重写。");
    }
    return lines.join("\n");
    }
    /* 副AI回复 → 各层；一个标签都没有就返回 null（整段兜底） */
    function parseLayers(txt) {
        txt = String(txt || "");
        const out = {}; let n = 0;
        LAYERS.forEach(function (l) {
            const m = txt.match(new RegExp("<" + l + "\\s*>([\\s\\S]*?)<\\/" + l + "\\s*>", "i"));
            if (m) { out[l] = String(m[1] || "").trim(); n++; }
        });
        return n ? out : null;
    }
    function isNoChange(v) {
        return /^\W*NO[_ \-]?CHANGE\W*$/i.test(String(v || "").trim());
    }
    /* 合账：锁住的层用旧值；NO_CHANGE 沿用旧值；其余用新值 */
    function mergeLayers(parsed, prev, locks) {
        const out = {};
        LAYERS.forEach(function (l) {
            const p = prev ? String(prev[l] || "").trim() : "";
            const v = parsed && parsed[l] != null ? String(parsed[l]).trim() : "";
            if (locks && locks[l] && p) { out[l] = p; return; }
            if (isNoChange(v)) { out[l] = p; return; }
            out[l] = v;
        });
        return out;
    }
    function joinLayers(layers, skip) {
        return LAYERS
            .filter(function (l) { return !(skip && skip[l]); })
            .map(function (l) { return String((layers && layers[l]) || "").trim(); })
            .filter(Boolean)
            .join(" ");
    }
    /* 注入/重注入时该用哪套层：开了分层且框有效才用 */
    function activeLayersForInject() {
        if (!cfg().layered || !layersFresh) return null;
        const b = layerBoxValues();
        return anyLayer(b) ? b : null;
    }

    /* ============================================================
       模板与注入
       ============================================================ */
    function getTemplateValue() {
        return String(cfg().template || "").trim() || DEFAULT_TEMPLATE;
    }
    function templateEnvelope(t) {
        const m = String(t || "").match(/^\s*<([A-Za-z][\w-]*)\s*>[\s\S]*<\/\1\s*>\s*$/);
        return m ? m[1] : "";
    }
    /* 填模板：多行模板里某行占位符全空则整行省略；单行不收行 */
    function fillTemplate(tpl, vals) {
        const lines = String(tpl == null ? "" : tpl).split("\n");
        const multi = lines.length > 1;
        const out = [];
        for (const line of lines) {
            let hadPh = false, allEmpty = true;
            const filled = line.replace(TPL_PH_RE, function (m) {
                if (!Object.prototype.hasOwnProperty.call(vals, m)) return m;
                hadPh = true;
                const v = String(vals[m] == null ? "" : vals[m]);
                if (v.trim()) allEmpty = false;
                return v;
            });
            if (multi && hadPh && allEmpty) continue;
            out.push(filled);
        }
        return out.join("\n");
    }
    function templateVals(tpl, desc, layers) {
        const vals = {};
        if (layers && anyLayer(layers)) {
            const placed = {};
            LAYERS.forEach(function (l) {
                if (tpl.indexOf(LAYER_PH[l]) >= 0) { vals[LAYER_PH[l]] = String(layers[l] || "").trim(); placed[l] = true; }
            });
            vals["{Description}"] = joinLayers(layers, placed);
        } else {
            vals["{Description}"] = String(desc == null ? "" : desc);
            LAYERS.forEach(function (l) { vals[LAYER_PH[l]] = ""; });
        }
        return vals;
    }
    function buildInjectTag(desc, layers) {
        const tpl = getTemplateValue();
        desc = String(desc == null ? "" : desc);
        TPL_PH_RE.lastIndex = 0;
        const has = TPL_PH_RE.test(tpl);
        TPL_PH_RE.lastIndex = 0;
        if (!has) return tpl + desc;
        return fillTemplate(tpl, templateVals(tpl, desc, layers));
    }
    /* 按用户模板 + 内置模板剥掉楼里注入的生图块 */
    function stripImageTag(text) {
        let out = String(text || "");
        const tpls = [getTemplateValue(), DEFAULT_TEMPLATE, ALT_TEMPLATE];
        const stripTail = function (str, marker) {
            const k = str.lastIndexOf(marker);
            if (k < 0) return str;
            return str.slice(0, k).replace(/\s+$/, "");
        };
        const seen = {};
        for (const t of tpls) {
            if (!t || seen[t]) continue;
            seen[t] = true;
            const phs = [];
            TPL_PH_RE.lastIndex = 0;
            let m;
            while ((m = TPL_PH_RE.exec(t)) !== null) phs.push({ i: m.index, e: m.index + m[0].length });
            TPL_PH_RE.lastIndex = 0;
            if (!phs.length) {
                if (t.trim()) out = stripTail(out, t);
                continue;
            }
            const envTag = templateEnvelope(t);
            if (envTag) {
                try { out = out.replace(new RegExp("\\s*<" + escRe(envTag) + "\\s*>[\\s\\S]*?<\\/" + escRe(envTag) + "\\s*>", "g"), ""); } catch (e) {}
                continue;
            }
            const pre = t.slice(0, phs[0].i), suf = t.slice(phs[phs.length - 1].e);
            if (pre && suf) {
                try { out = out.replace(tagRegex({ pre: pre, suf: suf }, "gi"), ""); } catch (e) {}
            } else if (pre) {
                out = stripTail(out, pre);
            } else if (suf) {
                try { out = out.replace(new RegExp("\\n\\n(?:(?!\\n\\n)[\\s\\S])*?" + escRe(suf) + "\\s*$"), ""); } catch (e) {}
            }
        }
        return out;
    }
    function stripEnvelope(text, name) {
        const e2 = escRe(name);
        if (!e2) return String(text || "");
        try { return String(text || "").replace(new RegExp("\\s*<" + e2 + "\\s*>[\\s\\S]*?<\\/" + e2 + "\\s*>", "g"), ""); } catch (e) { return String(text || ""); }
    }

    function rememberInject(msg, tag, desc, layers) {
        try {
            if (!msg.extra || typeof msg.extra !== "object") msg.extra = {};
            const envName = templateEnvelope(tag);
            msg.extra.sdg_env = envName || "";
            if (envName) delete msg.extra.sdg_tag; else msg.extra.sdg_tag = String(tag || "");
            msg.extra.sdg_desc = String(desc || "");
            if (layers && anyLayer(layers)) msg.extra.sdg_layers = cleanLayers(layers);
            else delete msg.extra.sdg_layers;
        } catch (e) {}
    }
    function injectRecord(msg) {
        try {
            const ex = msg && msg.extra;
            if (!ex || !String(ex.sdg_desc || "").trim()) return null;
            return { desc: String(ex.sdg_desc), layers: ex.sdg_layers && anyLayer(ex.sdg_layers) ? cleanLayers(ex.sdg_layers) : null };
        } catch (e) { return null; }
    }
    function syncSwipe(msg) {
        try {
            if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipe_id >= 0 && msg.swipe_id < msg.swipes.length) {
                msg.swipes[msg.swipe_id] = msg.mes;
            }
        } catch (e) {}
        syncSwipeExtra(msg);
    }

    /* 酒馆每个 swipe 的 extra 另存在 msg.swipe_info[swipe_id].extra，切 swipe 时酒馆会用它
       整个覆盖 msg.extra。我们写进 extra 的 sdg_* 必须同步过去，否则切走再切回来，
       注入记录和图库会被一起抹掉（正文里的标记还在，但记录和图没了）。 */
    const SDG_EXTRA_KEYS = ["sdg_desc", "sdg_tag", "sdg_env", "sdg_layers", "sdg_gal", "sdg_images", "sdg_image"];
    function swipeInfoSlot(msg, make, forceId) {
        if (!msg || !Array.isArray(msg.swipe_info)) return null;
        const id = forceId != null ? Number(forceId) : (Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0);
        if (id < 0 || id >= msg.swipe_info.length) return null;
        let slot = msg.swipe_info[id];
        if (!slot || typeof slot !== "object") { if (!make) return null; slot = msg.swipe_info[id] = {}; }
        if (!slot.extra || typeof slot.extra !== "object") { if (!make) return null; slot.extra = {}; }
        return slot;
    }
    function syncSwipeExtra(msg) { syncSwipeExtraFor(msg, null); }
    function syncSwipeExtraFor(msg, forceId) {
        try {
            const slot = swipeInfoSlot(msg, true, forceId);
            if (!slot) return;
            const ex = (msg && msg.extra) || {};
            /* 异步生图回来时可能已切回复：只同步目标回复的图库，不能把当前回复
               的描述/分层记录覆盖到它身上，其他回复的图库快照也原样保留。 */
            if (forceId != null && String(forceId) !== swipeKey(msg)) {
                const sk = String(forceId), gal = ex.sdg_gal;
                if (gal && gal[sk]) {
                    if (!slot.extra.sdg_gal || typeof slot.extra.sdg_gal !== "object") slot.extra.sdg_gal = {};
                    slot.extra.sdg_gal[sk] = gal[sk];
                }
                return;
            }
            SDG_EXTRA_KEYS.forEach(function (k) {
                if (ex[k] === undefined) delete slot.extra[k];
                else slot.extra[k] = ex[k];
            });
        } catch (e) {}
    }
    /* 反向兜底：酒馆切 swipe 后 extra 被覆盖，swipe_info 里存着的补回来（只补不盖）；
       图库按 swipe 分键，两边合并，免得在别的 swipe 生的图被旧快照挤掉 */
    function restoreSwipeExtra(msg) {
        try {
            const slot = swipeInfoSlot(msg, false);
            const src = slot && slot.extra;
            if (!src) return false;
            if (!msg.extra || typeof msg.extra !== "object") msg.extra = {};
            let changed = false;
            SDG_EXTRA_KEYS.forEach(function (k) {
                if (src[k] === undefined) return;
                if (k === "sdg_gal" && msg.extra.sdg_gal && typeof msg.extra.sdg_gal === "object") {
                    const dst = msg.extra.sdg_gal, add = src.sdg_gal;
                    if (add && typeof add === "object") {
                        for (const sk in add) {
                            if (!dst[sk]) { dst[sk] = add[sk]; changed = true; continue; }
                            for (const sl in add[sk]) if (!dst[sk][sl]) { dst[sk][sl] = add[sk][sl]; changed = true; }
                        }
                    }
                    return;
                }
                if (msg.extra[k] === undefined) { msg.extra[k] = src[k]; changed = true; }
            });
            return changed;
        } catch (e) { return false; }
    }

    /* 落盘：酒馆的 saveChat 是 async，之前到处裸调且空 catch，失败和竞态都看不见。
       统一走这里：同一帧内多次改动只落一次，失败明确提示（图/注入丢了得让她知道）。 */
    let chatSaveTimer = null, chatSaveWaiters = [];
    function persistChat(why, stillValid) {
        const c = ctx();
        if (!c || typeof c.saveChat !== "function") return Promise.resolve(false);
        if (chatSaveTimer) clearTimeout(chatSaveTimer);
        return new Promise(function (resolve) {
            chatSaveWaiters.push({ resolve: resolve, why: why || "", stillValid: stillValid });
            chatSaveTimer = setTimeout(function () {
                chatSaveTimer = null;
                const pending = chatSaveWaiters; chatSaveWaiters = [];
                const waiters = pending.filter(function (w) {
                    if (!w.stillValid || w.stillValid()) return true;
                    w.resolve(false); return false;
                });
                if (!waiters.length) return;
                const n = waiters.length;
                const saveWhy = waiters.length ? waiters[waiters.length - 1].why : (why || "");
                const finish = function (ok) { waiters.forEach(function (w) { w.resolve(ok); }); };
                let r;
                try { r = c.saveChat(); } catch (e) {
                    log("落盘失败(" + saveWhy + "):", e && e.message || e);
                    toast("落盘失败，刷新前这些改动可能丢：" + (e && e.message || e), false);
                    return finish(false);
                }
                if (r && typeof r.then === "function") {
                    r.then(function () { log("已落盘 ×" + n + " (" + saveWhy + ")"); finish(true); },
                           function (e) {
                               log("落盘失败(" + saveWhy + "):", e && e.message || e);
                               toast("落盘失败，刷新前这些改动可能丢：" + (e && e.message || e), false);
                               finish(false);
                           });
                } else finish(true);
            }, 40);
        });
    }

    function injectDescToMessage(desc, targetIdx, layers) {
        const idx = typeof targetIdx === "number" ? targetIdx : currentIdx;
        if (idx < 0) throw new Error("消息不存在");
        desc = String(desc || "").trim();
        if (!desc) throw new Error("没有内容");

        const c = ctx();
        const msg = c.chat[idx];
        if (!msg) throw new Error("消息不存在");

        const tag = buildInjectTag(desc, layers);
        if (String(msg.mes || "").indexOf(tag) >= 0) return { injected: false, reason: "duplicate", tag: tag };

        msg.mes = String(msg.mes || "").trimEnd() + "\n\n" + tag;
        rememberInject(msg, tag, desc, layers);
        syncSwipe(msg);
        persistChat("注入");
        rerenderFloor(idx);
        return { injected: true, tag: tag, slot: findAllTags(msg.mes).length - 1 };
    }

    /* 换画风重注入：剥掉旧块，按当前模板重拼 */
    function reinjectDescToMessage(targetIdx, opts) {
        opts = opts || {};
        const c = ctx();
        const chat = c.chat || [];
        let idx = typeof targetIdx === "number" ? targetIdx : currentIdx;
        if (idx < 0) {
            for (let k = chat.length - 1; k >= 0; k--) {
                const m0 = chat[k];
                if (m0 && !m0.is_user && m0.is_system !== true && String(m0.mes || "").trim()) { idx = k; break; }
            }
        }
        if (idx < 0 || !chat[idx]) throw new Error("找不到要注入的楼层");
        const msg = chat[idx];

        let p = { desc: "", layers: null };
        const previewFirst = !opts.preferRecord && (idx === currentIdx || currentIdx < 0);
        if (previewFirst) {
            const pv = q("#sdg-preview");
            p.desc = (pv && pv.value) || currentDesc;
            p.layers = activeLayersForInject();
        }
        if (!p.desc) {
            const rec = injectRecord(msg);
            if (rec) p = { desc: rec.desc, layers: rec.layers };
        }
        if (!p.desc) throw new Error(previewFirst ? "预览框是空的，先提取一次" : "这层没有提取记录，先提取一次");

        const before = String(msg.mes || "");
        let stripped = before, prevTag = "", prevEnv = "";
        try {
            prevTag = String((msg.extra && msg.extra.sdg_tag) || "");
            prevEnv = String((msg.extra && msg.extra.sdg_env) || "");
            if (prevTag) { const kp = stripped.lastIndexOf(prevTag); if (kp >= 0) stripped = stripped.slice(0, kp) + stripped.slice(kp + prevTag.length); }
            if (prevEnv) stripped = stripEnvelope(stripped, prevEnv);
        } catch (ePT) {}
        stripped = stripImageTag(stripped);

        const tag = buildInjectTag(p.desc, p.layers);
        const next = stripped.replace(/\s+$/, "") + "\n\n" + tag;
        if (next === before) return { injected: false, reason: "same", tag: tag, idx: idx, replaced: false };

        msg.mes = next;
        rememberInject(msg, tag, p.desc, p.layers);
        syncSwipe(msg);
        persistChat("重注入");
        rerenderFloor(idx);
        return { injected: true, tag: tag, idx: idx, replaced: stripped !== before };
    }

    /* 楼层正文变了之后只同步我们自己的槽，绝不整楼重绘——
       updateMessageBlock / messageFormatting 会把美化插件渲染好的前端卡打回源码
       （那些美化只在它们自己的事件里渲染，被别人重绘后不会重跑），得重启页面才恢复。
       这里只动 .sdg-slot、孤儿图和标记文本节点，楼里其他节点一概不碰。 */
    function rerenderFloor(idx) {
        try {
            const c = ctx();
            const msg = (c.chat || [])[idx];
            if (!msg) return;
            const el = q('#chat .mes[mesid="' + idx + '"] .mes_text');
            if (!el) return;
            const tags = findAllTags(msg.mes);
            /* 1. 摘掉我们的旧槽和孤儿图（标记文本在渲染时已被换进槽里，摘槽即摘标记） */
            Array.prototype.slice.call(el.querySelectorAll(".sdg-slot")).forEach(function (s) { s.remove(); });
            const orphan = el.querySelector("img.sdg-img.sdg-orphan"); if (orphan) orphan.remove();
            /* 2. 楼里已有的标记文本原地转成槽（只碰文本节点，美化插件的 HTML 原样不动） */
            replaceMarkersInDom(el);
            if (el.querySelectorAll(".sdg-slot").length < tags.length) replaceMarkersAcrossNodes(el);
            /* 3. 还缺的标记（刚注入到楼尾的那条）补一个文本节点再转一次 */
            const made = el.querySelectorAll(".sdg-slot").length;
            for (let k = made; k < tags.length; k++) {
                el.appendChild(document.createTextNode("\n\n" + tags[k].full));
            }
            if (tags.length > made) replaceMarkersInDom(el);
        } catch (e) { log("rerenderFloor:", e.message); }
        setTimeout(function () { try { renderFloorImage(idx, { domRetry: 2 }); installMesButtons(); } catch (e) {} }, 60);
    }

    /* ============================================================
       楼层按钮：🎨 重注入 / 🖼 重新生图
       ============================================================ */
    const MES_BTN_REINJECT = "sdg-mes-reinject";
    const MES_BTN_REGEN = "sdg-mes-regen";
    function installMesButtons() {
        const chatEl = q("#chat"); if (!chatEl) return 0;
        /* 编辑楼层时酒馆会暂时替换正文节点；此时不往编辑器所在楼层插按钮。 */
        if (chatEl.querySelector(".edit_textarea")) return 0;
        let chat = [];
        try { chat = (ctx() && ctx().chat) || []; } catch (e) {}
        Array.prototype.slice.call(chatEl.querySelectorAll(".mes")).forEach(function (m) {
            const idx = Number(m.getAttribute("mesid"));
            if (!Number.isFinite(idx)) return;
            const msg = chat[idx];
            const hasR = m.querySelector("." + MES_BTN_REINJECT);
            const hasG = m.querySelector("." + MES_BTN_REGEN);
            const hint = m.querySelector(".mes_buttons .extraMesButtonsHint");
            const bar = m.querySelector(".mes_buttons") || m.querySelector(".extraMesButtons");
            const put = function (html) {
                if (hint) hint.insertAdjacentHTML("beforebegin", html);
                else if (bar) bar.insertAdjacentHTML("afterbegin", html);
            };
            const want = !!(msg && !msg.is_user && injectRecord(msg));
            if (want && !hasR) put('<div title="生图工坊：按当前模板重新注入这层" class="mes_button ' + MES_BTN_REINJECT + ' fa-solid fa-palette interactable" tabindex="0"></div>');
            else if (!want && hasR) { try { hasR.remove(); } catch (e) {} }
            const wantG = !!(msg && !msg.is_user && (hasAnyImage(msg) || mayHaveMarkers(msg.mes)));
            if (wantG && !hasG) put('<div title="生图工坊：这层的标记全部重新生图" class="mes_button ' + MES_BTN_REGEN + ' fa-solid fa-image interactable" tabindex="0"></div>');
            else if (!wantG && hasG) { try { hasG.remove(); } catch (e) {} }
        });
        return 0;
    }
    function installMesButtonsObserver() {
        try {
            const chatEl = q("#chat");
            if (!chatEl) {
                /* #chat 还没挂出来：稍后重试安装楼层按钮和观察器。 */
                if ((installMesButtonsObserver.tries || 0) < 60) {
                    installMesButtonsObserver.tries = (installMesButtonsObserver.tries || 0) + 1;
                    setTimeout(installMesButtonsObserver, 1000);
                }
                return;
            }
            if (window.__sdgMesBtnObs || typeof MutationObserver === "undefined") return;
            let t = null;
            window.__sdgMesBtnObs = new MutationObserver(function () {
                if (t) clearTimeout(t);
                t = setTimeout(function () {
                    t = null;
                    /* 编辑时 SillyTavern 会反复替换楼层 DOM。不要在编辑器打开期间重绘图片，
                       否则图片槽的插入/移除会改变楼层高度，让滚动位置看起来被吸回图片处。 */
                    if (chatEl.querySelector(".edit_textarea")) return;
                    try { installMesButtons(); renderAllImages(); } catch (e) {}
                }, 250);
            });
            window.__sdgMesBtnObs.observe(chatEl, { childList: true, subtree: true });
            if (!window.__sdgMesBtnClick) {
                window.__sdgMesBtnClick = true;
                /* 只处理插件按钮 / 折叠条 / 翻页；图片预览独立安装，不依赖观察器。 */
                window.addEventListener("click", function (ev) {
                    const tg = ev.target;
                    if (!tg || !tg.closest) return;
                    /* 楼里：生成图片 / 折叠条 / ↻ 重画 / 翻页（点图由 bindImagePreview 安装的监听处理） */
                    const slot = tg.closest(".sdg-slot");
                    if (slot) {
                        const m0 = slot.closest(".mes"); const idx0 = m0 ? Number(m0.getAttribute("mesid")) : NaN;
                        const si = Number(slot.getAttribute("data-i"));
                        if (tg.closest(".sdg-slot-regen")) {
                            ev.preventDefault(); ev.stopPropagation();
                            if (Number.isFinite(idx0)) onGenSlot(idx0, si, true);
                            return;
                        }
                        if (tg.closest(".sdg-genbtn")) {
                            ev.preventDefault(); ev.stopPropagation();
                            if (Number.isFinite(idx0)) onGenSlot(idx0, si, false);
                            return;
                        }
                        const pg = tg.closest(".sdg-pg");
                        if (pg) {
                            ev.preventDefault(); ev.stopPropagation();
                            const msgP = (ctx().chat || [])[idx0];
                            if (msgP) {
                                stepImage(msgP, si, Number(pg.getAttribute("data-d")) || 1);
                                syncSwipeExtra(msgP);
                                persistChat("翻图");
                                slot.removeAttribute("data-sig");
                                renderFloorImage(idx0);
                            }
                            return;
                        }
                        if (tg.closest(".sdg-bar")) {
                            ev.preventDefault(); ev.stopPropagation();
                            const k = idx0 + ":" + si;
                            collapsed[k] = !collapsed[k];
                            slot.removeAttribute("data-sig");
                            renderFloorImage(idx0);
                            return;
                        }
                        return;
                    }
                    const b1 = tg.closest("." + MES_BTN_REINJECT);
                    if (b1) {
                        ev.preventDefault(); ev.stopPropagation();
                        const m = b1.closest(".mes"); const idx = m ? Number(m.getAttribute("mesid")) : NaN;
                        if (Number.isFinite(idx)) onReinjectFloor(idx);
                        return;
                    }
                    const b2 = tg.closest("." + MES_BTN_REGEN);
                    if (b2) {
                        ev.preventDefault(); ev.stopPropagation();
                        const m = b2.closest(".mes"); const idx = m ? Number(m.getAttribute("mesid")) : NaN;
                        if (Number.isFinite(idx)) onRegenFloor(idx);
                    }
                }, true);
            }
        } catch (e) {}
    }
    function onReinjectFloor(idx) {
        try {
            const r = reinjectDescToMessage(idx, { preferRecord: true });
            if (r.injected) setStatus("已重新注入第 " + (r.idx + 1) + " 层 ✓", C_OK);
            else setStatus("第 " + (r.idx + 1) + " 层没有变化", C_OK);
        } catch (e) {
            toast("重新注入失败：" + (e && e.message || e), false);
        }
    }

    /* ============================================================
       副AI提取
       ============================================================ */
    function fetchWithTimeout(url, options, timeoutMs) {
        timeoutMs = Number(timeoutMs || 0);
        if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") return fetch(url, options);
        if (timeoutMs < 5000) timeoutMs = 5000;
        options = options || {};
        const originalSignal = options.signal;
        const controller = new AbortController();
        if (originalSignal) {
            if (originalSignal.aborted) { try { controller.abort(); } catch (e) {} }
            else {
                try { originalSignal.addEventListener("abort", function () { try { controller.abort(); } catch (e) {} }, { once: true }); } catch (e) {}
            }
        }
        const timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs);
        options.signal = controller.signal;
        /* 故意不在 fetch resolve 时 clearTimeout：headers 到了不等于 body 读完了，
           之前在这儿清掉，读 body 阶段就没有超时保护，站点半途不发了就永久挂着。
           请求早完成的话这个 timer 到点 abort 一个已完成的控制器，没有副作用。 */
        return fetch(url, options);
    }

    function normalizeApiBase(base) {
        let url = (base || "").trim();
        if (!url) return "";
        while (url.length > 1 && url.charAt(url.length - 1) === "/") url = url.slice(0, -1);
        if (url.indexOf("/chat/completions") >= 0) url = url.replace(/\/chat\/completions\/?$/, "");
        if (url.indexOf("/models") >= 0) url = url.replace(/\/models\/?$/, "");
        if (!url.endsWith("/v1")) url += "/v1";
        return url;
    }
    function buildChatUrl(base) {
        const root = normalizeApiBase(base);
        return root ? root + "/chat/completions" : "";
    }

    function extractContentText(text) {
        text = String(text || "");
        const parts = [];
        const re = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[1] && String(m[1]).trim()) parts.push(String(m[1]).trim());
        }
        if (parts.length > 0) return parts.join("\n\n");
        return text;
    }
    function trimSourceText(text) {
        text = extractContentText(text);
        /* 只把正文送给提取模型：剥掉本插件自己注入的生图块（image###…### / 模板块 / <draw>…</draw>，
           那是上一轮的产物不是剧情）和内嵌 base64 图（动辄几万字符，白烧 prefill 还拖慢首字） */
        text = stripImageTag(text);
        text = text.replace(/!\[[^\]]*\]\(\s*data:image\/[^)]*\)/gi, "");
        text = text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, "");
        /* 取末尾片段，留下的始终是最新剧情 */
        const maxLen = 9000;
        if (text.length > maxLen) {
            text = text.slice(text.length - maxLen);
            text = "【注意：以下为正文末尾片段，前文已省略】\n" + text;
        }
        return text;
    }

    function buildVisionUserPrompt(text, supplement, layerOpts) {
        const c = cfg();
        let user = "";
        const anchors = String(c.extAnchors || "").trim();
        if (anchors) {
            if (c.anchorGuideOn !== false) user += "【角色锚点使用规则】\n" + DEFAULT_ANCHOR_GUIDE + "\n\n";
            user += "【角色外貌锚点】\n" + anchors + "\n\n";
        }
        const rules = String(c.extRules || "").trim();
        if (rules) user += "【提取规则】\n" + rules + "\n\n";
        user += "【正文内容】\n" + trimSourceText(text);
        if (supplement) user += "\n\n【补充指令】\n" + supplement;
        if (layerOpts) {
            user += "\n\n" + layerContract(layerOpts.prev, layerOpts.locks);
        } else {
            user += "\n\n任务：把正文转成英文生图 Description。\n";
            user += "要求：只输出最终英文 Description；不要解释；不要标题；不要代码块；不要中文；不要复述任务。\n";
            user += "优先写可见画面：人物数量、姿态、表情、服装、环境、光线、氛围、镜头距离。";
        }
        return user;
    }

    function parseChatResponse(data) {
        if (!data) return "";
        if (data.choices && data.choices[0]) {
            const ch = data.choices[0];
            if (ch.message) {
                const msg = ch.message;
                if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
                if (msg.content && Array.isArray(msg.content)) {
                    const parts = [];
                    msg.content.forEach(function (part) {
                        if (!part) return;
                        if (typeof part === "string") parts.push(part);
                        else if (part.text) parts.push(part.text);
                        else if (part.content) parts.push(part.content);
                    });
                    if (parts.join("").trim()) return parts.join("\n").trim();
                }
                if (msg.text) return String(msg.text).trim();
            }
            if (ch.text) return String(ch.text).trim();
            if (ch.delta && ch.delta.content) return String(ch.delta.content).trim();
        }
        if (data.content && Array.isArray(data.content) && data.content[0]) {
            if (data.content[0].text) return String(data.content[0].text).trim();
            if (typeof data.content[0] === "string") return String(data.content[0]).trim();
        }
        if (data.response) return String(data.response).trim();
        if (data.text) return String(data.text).trim();
        if (data.output_text) return String(data.output_text).trim();
        return "";
    }

    async function callSubAI(text, supplement, layerOpts) {
        const c = cfg();
        if (!c.extEndpoint) throw new Error("请先配置提取 API 地址");
        if (!c.extModel) throw new Error("请先选择提取模型");

        const abortReq = {
            controller: typeof AbortController !== "undefined" ? new AbortController() : null,
            userAborted: false
        };

        const systemPrompt = (activeSystemPrompt() || {}).value || DEFAULT_SYS_EMO;
        const body = {
            model: c.extModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: buildVisionUserPrompt(text, supplement || "", layerOpts) }
            ],
            temperature: 0.4,
            stream: false
            /* 不要在这里加 max_tokens：thinking 系模型光思考就能吃满额度，
               正文一个字也挤不出来 —— 表现是「没按分层输出，已整段兜底」
               （退去读 reasoning_content 当提示词）或直接「无法解析响应」。 */
        };

        let url, headers, reqBody;
        if (c.extProxy && ctx() && typeof ctx().getRequestHeaders === "function") {
            url = "/api/backends/chat-completions/generate";
            headers = ctx().getRequestHeaders();
            reqBody = {
                chat_completion_source: "custom",
                custom_url: normalizeApiBase(c.extEndpoint),
                custom_include_headers: "Authorization: \"Bearer " + (c.extKey || "") + "\"",
                model: c.extModel,
                messages: body.messages,
                temperature: body.temperature,
                stream: false
            };
        } else {
            url = buildChatUrl(c.extEndpoint);
            headers = { "Content-Type": "application/json" };
            if (c.extKey) headers["Authorization"] = "Bearer " + c.extKey;
            reqBody = body;
        }

        const fetchOptions = { method: "POST", headers: headers, body: JSON.stringify(reqBody) };
        extAborts.add(abortReq);
        if (abortReq.controller) fetchOptions.signal = abortReq.controller.signal;

        let res, raw;
        try {
            res = await fetchWithTimeout(url, fetchOptions, Number(c.requestTimeout || 0) * 1000);
            raw = await res.text();
        } catch (e) {
            if (abortReq.userAborted) {
                const aborted = new Error("请求已被打断");
                aborted.name = "AbortError";
                aborted.sdgUserAbort = true;
                throw aborted;
            }
            throw e;
        } finally {
            extAborts.delete(abortReq);
        }

        if (!res.ok) throw new Error("API " + res.status + "：" + raw.slice(0, 220));

        const data = safeJson(raw, null);
        if (!data) throw new Error("API 返回不是 JSON：" + raw.slice(0, 180));

        const out = parseChatResponse(data);
        if (out) return out;

        let finish = "", hadReasoning = false;
        try {
            const ch0 = data.choices && data.choices[0];
            if (ch0 && ch0.finish_reason) finish = ch0.finish_reason;
            const m0 = ch0 && ch0.message;
            hadReasoning = !!(m0 && ((m0.reasoning_content && String(m0.reasoning_content).trim()) ||
                                     (m0.reasoning && String(m0.reasoning).trim())));
        } catch (e) {}
        if (finish === "length") throw new Error("模型只顾着思考，正文被截断了（finish_reason=length）。换个不思考的模型，或把站点的输出上限调高。原始返回：" + raw.slice(0, 160));
        if (hadReasoning) throw new Error("模型只输出了思考内容、没给正文。换个不思考的模型试试。原始返回：" + raw.slice(0, 160));
        throw new Error("无法解析响应：" + raw.slice(0, 220));
    }

    /* ============================================================
       生图接口
       ============================================================ */
    function directHeaders(contentType, auth) {
        const headers = { "Accept": "*/*" };
        if (contentType) headers["Content-Type"] = contentType;
        if (auth) headers["Authorization"] = auth;
        return headers;
    }

    async function readOpenAIResponse(response) {
        const text = await response.text();
        const trimmed = text.trimStart();
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        const isSSE = contentType.includes("text/event-stream") || trimmed.startsWith("data:") || /\n\s*data:\s*/.test(text);
        if (!isSSE) {
            try { return JSON.parse(text); } catch (e) {
                throw new Error("无法解析响应 JSON: " + e.message + "; 原始响应: " + text.slice(0, 500));
            }
        }
        log("检测到 SSE 流式响应，开始聚合 chunk");
        let aggregatedContentText = "";
        const aggregatedContentParts = [];
        let aggregatedReasoningText = "";
        const aggregatedImages = [];
        let finishReason = null, usage = null, model = null, id = null;
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(":")) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk;
            try { chunk = JSON.parse(payload); } catch (e) { continue; }
            if (chunk.id && !id) id = chunk.id;
            if (chunk.model && !model) model = chunk.model;
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices && chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta || choice.message || {};
            if (typeof delta.content === "string") aggregatedContentText += delta.content;
            else if (Array.isArray(delta.content)) {
                for (const item of delta.content) {
                    if (item && item.type === "text" && typeof item.text === "string") aggregatedContentText += item.text;
                    else aggregatedContentParts.push(item);
                }
            }
            if (typeof delta.reasoning_content === "string") aggregatedReasoningText += delta.reasoning_content;
            const rd = delta.reasoning_details;
            if (rd && Array.isArray(rd.images)) { for (const img of rd.images) aggregatedImages.push(img); }
            if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        let messageContent;
        if (aggregatedContentParts.length > 0) {
            messageContent = [...aggregatedContentParts];
            if (aggregatedContentText) messageContent.unshift({ type: "text", text: aggregatedContentText });
        } else {
            messageContent = aggregatedContentText;
        }
        const message = { role: "assistant", content: messageContent };
        if (aggregatedReasoningText) message.reasoning_content = aggregatedReasoningText;
        if (aggregatedImages.length > 0) message.reasoning_details = { images: aggregatedImages };
        return { id, object: "chat.completion", model, choices: [{ index: 0, message, finish_reason: finishReason || "stop" }], usage: usage || undefined };
    }

    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    async function dataUrlFromUrl(url, signal, proxy) {
        /* 带上生图的 signal 和一个独立超时：这一步之前裸 fetch，站点返回 url 而 CDN 卡住时
           整条生图永久悬挂，那一槽一直转圈，点「停止」也掐不断（它不接 abort） */
        const headers = { Accept: "image/*" };
        /* 代理会把部分请求头转发给图片站，只允许 CSRF 头；绝不传 API 密钥或登录凭据。 */
        if (proxy && ctx() && typeof ctx().getRequestHeaders === "function") {
            const local = ctx().getRequestHeaders();
            Object.keys(local || {}).forEach(function (key) { if (key.toLowerCase() === "x-csrf-token") headers[key] = local[key]; });
        }
        const resp = await fetchWithTimeout(proxy ? "/proxy/" + encodeURIComponent(url) : url,
            { headers: headers, signal: signal, credentials: proxy ? "same-origin" : "omit" }, 120000);
        if (!resp.ok) throw new Error("下载图片失败: " + resp.status);
        const blob = await resp.blob();
        const head = await new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = () => resolve(new Uint8Array(reader.result));
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.readAsArrayBuffer(blob.slice(0, 16));
        });
        const ascii = (start, end) => String.fromCharCode.apply(null, head.slice(start, end));
        const mime = head.length >= 8 && head[0] === 137 && ascii(1, 4) === "PNG" && head[4] === 13 && head[5] === 10 && head[6] === 26 && head[7] === 10 ? "image/png"
            : head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255 ? "image/jpeg"
            : /^GIF8[79]a$/.test(ascii(0, 6)) ? "image/gif"
            : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp"
            : ascii(0, 2) === "BM" ? "image/bmp" : "";
        if (!mime) throw new Error("下载内容不是有效的图片，可能是过期链接或站点错误页面");
        if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
        const data = await blobToDataURL(new Blob([blob], { type: mime }));
        if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
        return data;
    }

    async function convertImageToJpeg(input) {
        const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("图片加载失败"));
            im.src = input;
        });
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (typeof OffscreenCanvas !== "undefined") {
            const canvas = new OffscreenCanvas(w, h);
            canvas.getContext("2d").drawImage(img, 0, 0);
            const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
            return blobToDataURL(blob);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0);
        return canvas.toDataURL("image/jpeg", 0.95);
    }

    /* —— 编辑接口：/images/edits（各站形状不一：new-api 只认 multipart、别家只认 JSON——四种形状全试，报错全汇总）—— */
    async function genEdits(finalPrompt, faceRef) {
        const c = cfg();
        let base = String(c.genEndpoint || "").trim().replace(/\/+$/, "");
        if (!base) throw new Error("请先填写生图 API 地址");
        if (/\/edits$/.test(base)) base = base.replace(/\/edits$/, "");
        if (/\/generations$/.test(base)) base = base.replace(/\/generations$/, "");
        if (/\/chat\/completions$/.test(base)) base = base.replace(/\/chat\/completions$/, "");
        const url = base + "/images/edits";
        const prompt = finalPrompt + "\n\n（输入图是人物面部参考：只把与参考图相貌对应的角色按参考脸生成，严格保持其脸部特征、发型与身份，不要改变长相或性别；其余角色严格按正文各自描述生成。）";
        const rawB64 = String(faceRef).replace(/^data:[^,]+,/, "");
        const size = normalizeGenSize(c.grokSize);
        const quality = String(c.genQuality || "").trim();
        const ctl = createGenController();
        const signal = ctl.signal;
        const errs = [];
        async function parseResp(resp, tag) {
            const text = await resp.text();
            if (!resp.ok) throw new Error(tag + " " + siteErrorBrief(resp.status, text));
            let result;
            try { result = JSON.parse(text); } catch (e) { throw new Error(tag + " 响应不是 JSON: " + text.slice(0, 120)); }
            const item = result && result.data && result.data[0];
            /* 200 回来就意味着这一发已经计费了，解析不出图也不能再试下一种形状，
               否则锁脸最坏四种形状各扣一次 */
            if (!item) { const e = new Error(tag + " 响应缺少 data[0]: " + text.slice(0, 150)); e.sdgCharged = true; throw e; }
            if (item.b64_json) return "data:image/png;base64," + item.b64_json;
            if (item.url) return await normalizeImageToDataUrl(item.url, signal);
            const e2 = new Error(tag + " 响应未包含图片"); e2.sdgCharged = true; throw e2;
        }
        function multipartBody(pngDataUrl, mime, filename) {
            const bin = atob(pngDataUrl.split(",")[1]);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const file = new File([buf], filename, { type: mime });
            const fd = new FormData();
            fd.append("model", c.genModel);
            fd.append("prompt", prompt);
            fd.append("image", file);
            fd.append("n", "1");
            fd.append("size", size);
            if (quality) fd.append("quality", quality);
            return fd;
        }
        const toPng = function (dataUrl) {
            return new Promise(function (res) {
                const im = new Image();
                im.onload = function () {
                    const cv = document.createElement("canvas");
                    cv.width = im.width; cv.height = im.height;
                    cv.getContext("2d").drawImage(im, 0, 0);
                    res(cv.toDataURL("image/png"));
                };
                im.onerror = function () { res(dataUrl); };
                im.src = dataUrl;
            });
        };
        const pngRef = await toPng(faceRef);
        const jsonExtra = quality ? { quality: quality } : {};
        const attempts = [
            ["multipart-PNG", { method: "POST", headers: { "Authorization": "Bearer " + (c.genKey || "") }, body: multipartBody(pngRef, "image/png", "face.png"), signal }],
            ["multipart-JPEG", { method: "POST", headers: { "Authorization": "Bearer " + (c.genKey || "") }, body: multipartBody(faceRef, "image/jpeg", "face.jpg"), signal }],
            ["JSON/dataURL", { method: "POST", headers: directHeaders("application/json", "Bearer " + (c.genKey || "")), body: JSON.stringify(Object.assign({ model: c.genModel, prompt: prompt, image: faceRef, n: 1, size: size }, jsonExtra)), signal }],
            ["JSON/base64", { method: "POST", headers: directHeaders("application/json", "Bearer " + (c.genKey || "")), body: JSON.stringify(Object.assign({ model: c.genModel, prompt: prompt, image: rawB64, n: 1, size: size }, jsonExtra)), signal }]
        ];
        try {
            for (let i = 0; i < attempts.length; i++) {
                const tag = attempts[i][0];
                try {
                    return await parseResp(await fetch(url, attempts[i][1]), tag);
                } catch (e) {
                    const ae = genAbortError(ctl); if (ae) throw ae;
                    if (e && e.sdgImageDownload) throw e;
                    errs.push("[" + tag + "] " + String(e.message || e).slice(0, 110));
                    log("编辑接口形状 " + tag + " 失败:", String(e.message || e).slice(0, 200));
                    if (e && e.sdgCharged) throw new Error("编辑接口已返回 200 但没给出图片，为免重复扣费没再试其它形状 → " + errs.join(" ｜ "));
                }
            }
            throw new Error("编辑接口四种形状均失败 → " + errs.join(" ｜ "));
        } finally {
            ctl.dispose();
        }
    }

    /* —— 生图统一请求（与 Tavo 生图工坊 v1.18.16 对齐） ——
       ① 主路径 chat/completions 多模态（尺寸 / 画质原样传）；地址直指 /images/generations 时跳过；
       ② 兜底 images/generations（b64_json，站点只认 url 即 400 提 response_format 时自动改发 url 重试一次）；
       ③ 尺寸全角 × 归一化为半角 x（fate 等站点拒收全角）；
       ④ genTimeout 超时与「停止」按钮真正能掐断；超时/取消后不再补发，避免重复计费；
       ⑤ 失败错误带 HTTP 状态码 + 站点返回的原话。
       酒馆后端代理（genProxy）只走 chat 通道，没有 images 兜底。 */
    function normalizeGenSize(v) { return String(v == null ? "" : v).trim().replace(/×/g, "x") || "1024x1024"; }

    /* 组合「停止」按钮信号与超时信号为一个 AbortController */
    function createGenController() {
        let timedOut = false, userAborted = false;
        const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        const timeoutMs = Math.max(30, Number(cfg().genTimeout) || 300) * 1000;
        const timer = ctrl ? setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;
        const rec = { markUser: function () { userAborted = true; try { if (ctrl) ctrl.abort(); } catch (e) {} } };
        genAborts.add(rec);
        return {
            signal: ctrl ? ctrl.signal : undefined,
            timeoutSec: Math.round(timeoutMs / 1000),
            isTimedOut: function () { return timedOut; },
            isUserAborted: function () { return userAborted; },
            dispose: function () { if (timer) clearTimeout(timer); genAborts.delete(rec); }
        };
    }
    function genAbortError(ctl) {
        if (ctl.isTimedOut()) return new Error("生图请求超时（" + ctl.timeoutSec + " 秒），已停止（不自动重试，以免重复扣费）");
        if (ctl.isUserAborted()) return new Error("已取消生图");
        return null;
    }

    /* 从站点错误体里抠出 {error:{message,code}} 一类原话；错误体可能被拼在长串中间，先抠第一个完整 {…} */
    function pickJsonBlock(text) {
        const t = String(text == null ? "" : text);
        const i = t.indexOf("{");
        if (i < 0) return null;
        let depth = 0, inStr = false, esc = false;
        for (let k = i; k < t.length; k++) {
            const ch = t.charAt(k);
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(i, k + 1)); } catch (e) { return null; } } }
        }
        return null;
    }
    function siteErrorBrief(status, body) {
        const d = (function () { try { return JSON.parse(String(body || "")); } catch (e) { return pickJsonBlock(body); } })();
        let detail = "";
        if (d) {
            const err = d.error || d;
            const msg = err.message || err.msg || err.detail || d.message;
            const code = err.code || err.type;
            detail = [msg, (code && String(code) !== String(msg)) ? "(" + code + ")" : ""].filter(Boolean).join(" ");
        }
        if (!detail) detail = String(body == null ? "" : body).replace(/\s+/g, " ").trim();
        return "HTTP " + status + "：" + (String(detail || "").slice(0, 140) || "站点未返回原因");
    }
    /* 内容被站点审核拒了：GPT 系回的就是 400 + moderation_blocked / content_policy_violation /
       「safety system」，中转站也有直接写中文的。这类 400 不是「chat 接口不通」，
       拿同一个提示词退去 images 兜底只会再被拒一次 —— 白等一轮，她还会看到两遍 safe。 */
    function isModerationBlock(body) {
        const raw = String(body == null ? "" : body);
        if (/moderation_blocked|content[\s_-]?policy|content[\s_-]?filter|safety[\s_-]?system|safety[\s_-]?violation|flagged|not allowed by our safety/i.test(raw)) return true;
        return /违规|违反|敏感|审核不通过/.test(raw);
    }
    /* 统一出口：超时/取消原样，HTTP 错误转「状态码 +（通道）+ 站点原话」，其余保留。
       状态码和通道排在最前面：手机 toast 会截断，套话写在前面等于没写。 */
    const GEN_VIA_RE = "代理 chat|chat|images";
    function formatGenError(e) {
        const raw = String((e && e.message) || e || "");
        if (/超时/.test(raw)) return raw;
        if (/已取消/.test(raw) || (e && e.name === "AbortError")) return "已取消生图";
        const m = raw.match(new RegExp("(?:(" + GEN_VIA_RE + ")\\s*接口\\s*)?HTTP\\s*(\\d{3})\\s*[:：]?\\s*([\\s\\S]*)"));
        if (m) {
            /* 错误串可能是两段拼起来的（images 接口 … / chat 接口 …）：诊断只看第一段 =
               最后真正走的那个通道，后面那段连同它的括号说明一起截掉 */
            let body = String(m[3] || "");
            const cut = body.search(new RegExp("\\s*/\\s*(?:" + GEN_VIA_RE + ")\\s*接口"));
            if (cut >= 0) body = body.slice(0, cut);
            const d = (function () { try { return JSON.parse(body); } catch (e2) { return pickJsonBlock(body); } })();
            let detail = "";
            if (d) {
                const err = d.error || d;
                const msg = err.message || err.msg || err.detail || d.message;
                const code = err.code || err.type;
                detail = [msg, (code && String(code) !== String(msg)) ? "(" + code + ")" : ""].filter(Boolean).join(" ");
            }
            if (!detail) detail = String(body || "").replace(/\s+/g, " ").trim();
            return "生图失败 " + m[2] + (m[1] ? "（" + m[1] + "）" : "") + "：" + (String(detail || "").slice(0, 140) || "站点未返回原因");
        }
        return raw;
    }

    /* 纯解析：从 chat/completions 响应里取图片 URL / dataURL（不下载） */
    function imgUrlFromChat(result) {
        const ch = result && result.choices && result.choices[0];
        const m2 = ch && ch.message;
        if (!m2) return "";
        const rd = m2.reasoning_details;
        if (rd && Array.isArray(rd.images) && rd.images[0] && rd.images[0].image_url) {
            const iu = rd.images[0].image_url;
            return typeof iu === "string" ? iu : (iu.url || "");
        }
        if (Array.isArray(m2.content)) {
            for (const it of m2.content) {
                if (it && it.type === "image_url" && it.image_url) return typeof it.image_url === "string" ? it.image_url : (it.image_url.url || "");
            }
        }
        if (typeof m2.content === "string") {
            const mm = m2.content.match(/!\[.*?\]\(((?:https?:\/\/|data:image\/[^;]+;base64,)[^\s\)]+)\)/);
            if (mm) return mm[1];
        }
        return "";
    }
    function imgUrlFromGen(result) {
        const item = result && result.data && result.data[0];
        if (!item) return "";
        if (item.b64_json) return "data:image/png;base64," + item.b64_json;
        if (item.url) return String(item.url);
        return "";
    }

    async function genImageUnified(finalPrompt) {
        const c = cfg();
        if (!c.genModel) throw new Error("请先填写生图模型");
        let base = String(c.genEndpoint || "").trim().replace(/\/+$/, "");
        if (!base) throw new Error("请先填写生图 API 地址");
        const imagesOnly = /\/images\/generations$/.test(base);   /* 地址直指 images 接口：直连，不再先白打一次 chat */
        base = base.replace(/\/(images\/generations|chat\/completions)$/, "");
        const size = normalizeGenSize(c.grokSize);
        const quality = String(c.genQuality || "").trim();       /* GPT 2.5 low~max；Grok low/medium/auto；留空不发送 */
        log("生图请求：", base.replace(/^https?:\/\//, ""), "model=" + c.genModel, "size=" + size, "q=" + (quality || "-"));

        const faceRef = (c.faceRefOn && String(c.faceRef || "")) ? String(c.faceRef) : "";
        const ctl = createGenController();

        /* ① 主路径：chat/completions */
        let lastErr = "";
        /* 兜底只在「这个站的 chat 通道根本不通」时才走：接口不存在(404/405/501)、
           参数不被接受(400)、网络层错误。鉴权(401/403)、限流(429)、服务端错(5xx)一律不退——
           退了也是再吃一次同样的错，还白添一次请求；200 但解析不出图更是已经计费了，
           再发一次等于同一张图扣两回。内容被审核拒的 400 同理（见 isModerationBlock）。 */
        let canFallback = false, charged = false, moderated = false;
        if (imagesOnly) {
            lastErr = "按地址直连 images 接口";
            canFallback = true;
        } else if (c.genProxy && ctx() && typeof ctx().getRequestHeaders === "function") {
            /* 酒馆后端代理通道：仅 chat，无 images 兜底；请求体保持后端约定原样 */
            const parts = [];
            if (faceRef) parts.push({ type: "image_url", image_url: { url: faceRef } });
            parts.push({ type: "text", text: faceRef
                ? finalPrompt + "\n\n（第一张图是人物面部参考：只把与参考图相貌对应的角色按参考脸生成，严格保持其脸部特征、发型与身份，不要改变长相或性别；其余角色严格按正文各自描述生成。）"
                : finalPrompt });
            const messages = [{ role: "user", content: parts }];
            try {
                const resp = await fetch("/api/backends/chat-completions/generate", {
                    method: "POST", headers: ctx().getRequestHeaders(), signal: ctl.signal,
                    body: JSON.stringify({
                        chat_completion_source: "custom",
                        custom_url: base,
                        custom_include_headers: "Authorization: \"Bearer " + (c.genKey || "") + "\"",
                        model: c.genModel,
                        messages: messages,
                        stream: false
                    })
                });
                if (resp.ok) {
                    const result = await readOpenAIResponse(resp);
                    const u = imgUrlFromChat(result);
                    if (u) { const img = await normalizeImageToDataUrl(u, ctl.signal); ctl.dispose(); return { image: img, prompt: finalPrompt, via: "proxy" }; }
                    lastErr = "代理 chat 接口响应中没有图片";
                } else {
                    const t = await resp.text();
                    lastErr = "代理 chat 接口 " + siteErrorBrief(resp.status, t);
                }
            } catch (e) {
                const ae = genAbortError(ctl); if (ae) { ctl.dispose(); throw ae; }
                if (e && e.sdgImageDownload) { ctl.dispose(); throw e; }
                lastErr = "代理 chat 接口网络错误: " + (e && e.message || e);
            }
        } else try {
            const headers = { "Content-Type": "application/json", "Accept": "*/*" };
            if (c.genKey) headers["Authorization"] = "Bearer " + c.genKey;
            const parts = [];
            if (faceRef) parts.push({ type: "image_url", image_url: { url: faceRef } });
            parts.push({ type: "text", text: faceRef
                ? finalPrompt + "\n\n（第一张图是人物面部参考：只把与参考图相貌对应的角色按参考脸生成，严格保持其脸部特征、发型与身份，不要改变长相或性别；其余角色严格按正文各自描述生成。）"
                : finalPrompt });
            const resp = await fetch(base + "/chat/completions", {
                method: "POST", headers: headers, signal: ctl.signal,
                body: JSON.stringify({ model: c.genModel, messages: [{ role: "user", content: parts }], size: size, quality: quality || undefined })
            });
            if (resp.ok) {
                /* 200 可能已经计费；解析或读 body 失败也不能再请求 images 兜底。 */
                charged = true;
                const result = await readOpenAIResponse(resp);
                const u = imgUrlFromChat(result);
                if (u) { const img = await normalizeImageToDataUrl(u, ctl.signal); ctl.dispose(); return { image: img, prompt: finalPrompt, via: "chat" }; }
                lastErr = "chat 接口响应中没有图片";
            } else {
                const t = await resp.text();
                lastErr = "chat 接口 " + siteErrorBrief(resp.status, t);
                moderated = (resp.status === 400 || resp.status === 403) && isModerationBlock(t);
                canFallback = !moderated && (resp.status === 404 || resp.status === 405 || resp.status === 501 || resp.status === 400);
            }
        } catch (e) {
            const ae = genAbortError(ctl); if (ae) { ctl.dispose(); throw ae; }
            if (e && e.sdgImageDownload) { ctl.dispose(); throw e; }
            lastErr = "chat 接口网络错误: " + (e && e.message || e);
            canFallback = !charged;
        }

        /* ② 兜底：images/generations（后端代理通道没有这一兜底） */
        if (!imagesOnly && c.genProxy && ctx() && typeof ctx().getRequestHeaders === "function") {
            ctl.dispose();
            throw new Error(lastErr || "chat 接口生图失败");
        }
        if (!canFallback) {
            ctl.dispose();
            throw new Error(lastErr + (charged
                ? "（站点已返回 200，可能已计费，没有再试 images 接口以免重复扣费）"
                : moderated
                    ? "（内容被站点审核拒了，没再试 images 接口：同一个提示词退过去也是一样被拒）"
                    : "（没再试 images 接口：这类错误退了也是同样结果）"));
        }
        try {
            const headers = { "Content-Type": "application/json", "Accept": "*/*" };
            if (c.genKey) headers["Authorization"] = "Bearer " + c.genKey;
            let resp2 = await fetch(base + "/images/generations", {
                method: "POST", headers: headers, signal: ctl.signal,
                body: JSON.stringify({ model: c.genModel, prompt: finalPrompt, n: 1, size: size, quality: quality || undefined, response_format: "b64_json" })
            });
            let why2 = "";
            if (!resp2.ok) why2 = await resp2.text();
            /* fate 类站点：b64_json 一律 400「仅支持 url」（未计费）→ 改发 url 重试一次 */
            if (resp2.status === 400 && /response_format/i.test(why2)) {
                log("站点要求 response_format=url，改用 url 重试");
                resp2 = await fetch(base + "/images/generations", {
                    method: "POST", headers: headers, signal: ctl.signal,
                    body: JSON.stringify({ model: c.genModel, prompt: finalPrompt, n: 1, size: size, quality: quality || undefined, response_format: "url" })
                });
                why2 = resp2.ok ? "" : await resp2.text();   /* body 只能读一次，重试后立刻读走 */
            }
            if (resp2.ok) {
                const result2 = await readOpenAIResponse(resp2);
                const u2 = imgUrlFromGen(result2);
                if (u2) { const img2 = await normalizeImageToDataUrl(u2, ctl.signal); ctl.dispose(); return { image: img2, prompt: finalPrompt, via: "generations" }; }
                ctl.dispose();
                throw new Error("images 接口响应未包含图片 / " + lastErr);
            }
            ctl.dispose();
            throw new Error("images 接口 " + siteErrorBrief(resp2.status, why2) + " / " + lastErr);
        } catch (e) {
            ctl.dispose();
            const ae = genAbortError(ctl); if (ae) throw ae;
            throw e;
        }
    }

    async function extractImageFromChatResponse(result) {
        const u = imgUrlFromChat(result);
        if (u) return await normalizeImageToDataUrl(u);
        log("响应中没有图片");
        throw new Error("API 响应中没有找到图片");
    }
    async function normalizeImageToDataUrl(u, signal) {
        if (!u) return "";
        if (String(u).startsWith("data:image/")) return u;
        const url = new URL(String(u), window.location.href);
        if (!/^https?:$/.test(url.protocol)) throw new Error("不支持的图片地址");
        let reason = "";
        const canProxy = url.origin !== window.location.origin && ctx() && typeof ctx().getRequestHeaders === "function";
        for (const proxy of (canProxy ? [false, true] : [false])) {
            try { return await dataUrlFromUrl(String(u), signal, proxy); }
            catch (e) {
                if (signal && signal.aborted) throw e;
                /* 单次下载的 120 秒超时不等于用户取消；保留原地址供代理或重试保存。 */
                reason = e && e.name === "AbortError" ? "下载图片超时" : String(e && e.message || e);
            }
        }
        const e = new Error("图片已生成，但下载保存失败（" + reason + "）。请重试保存；若跨域下载被拦截，需要酒馆启用 CORS 代理。不会重新生图。");
        e.sdgImageDownload = true;
        e.sdgImageUrl = String(u);
        throw e;
    }
    function isRemoteImage(src) {
        try {
            if (!/^(https?:)?\/\//i.test(String(src || "").trim())) return false;
            const url = new URL(String(src || ""), window.location.href);
            return /^https?:$/.test(url.protocol) && url.origin !== window.location.origin;
        } catch (e) { return false; }
    }

    /* 把生成的图（dataURL）上传到酒馆服务器存成文件，聊天记录里只留链接。
       不上传的话整张图的 base64 会写进聊天文件，几十次生图后聊天文件上百 MB，
       手机端 Node 读进内存直接 OOM 崩溃。上传失败则原样返回（老行为兜底）。 */
    async function persistGenImage(imageUrl) {
        let ctl = null;
        try {
            if (isRemoteImage(imageUrl)) {
                ctl = createGenController();
                imageUrl = await normalizeImageToDataUrl(imageUrl, ctl.signal);
            }
            if (!String(imageUrl).startsWith("data:image/")) return imageUrl;
            const cont = ctx();
            if (!cont || typeof cont.getRequestHeaders !== "function") return imageUrl;
            const s = String(imageUrl);
            const meta = s.slice(0, s.indexOf(","));
            const b64 = s.slice(s.indexOf(",") + 1);
            const format = /image\/jpe?g/.test(meta) ? "jpeg" : (/image\/webp/.test(meta) ? "webp" : (/image\/gif/.test(meta) ? "gif" : (/image\/bmp/.test(meta) ? "bmp" : "png")));
            const chName = (cont.characterId !== undefined && cont.characters && cont.characters[cont.characterId]) ? String(cont.characters[cont.characterId].name || "") : "";
            const filename = "sdg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            /* 生图接口已返回后仍在保存中；这段也要能被「停止」和生图超时掐断。 */
            if (!ctl) ctl = createGenController();
            const res = await fetch("/api/images/upload", {
                method: "POST",
                headers: cont.getRequestHeaders(),
                body: JSON.stringify({ image: b64, format: format, ch_name: chName, filename: filename }),
                signal: ctl.signal
            });
            if (!res.ok) { log("图片上传服务器失败，保留内嵌存储:", res.status); return imageUrl; }
            const j = await res.json();
            if (j && /^\/?images\/[^?#]+$/.test(String(j.path)) && !String(j.path).split("/").includes("..")) {
                log("图片已存服务器:", j.path); return String(j.path).replace(/^\/+/, "");
            }
            log("上传响应缺少 path，保留内嵌存储");
            return imageUrl;
        } catch (e) {
            const ae = ctl && genAbortError(ctl);
            if (ae) throw ae;
            if (e && (e.sdgImageDownload || e.name === "AbortError")) throw e;
            if (!String(imageUrl).startsWith("data:image/")) throw e;
            log("图片上传异常，保留内嵌存储:", e && e.message); return imageUrl;
        } finally { if (ctl) ctl.dispose(); }
    }

    /* 只访问插件自己的图库；每次重新遍历，兼容切 swipe 时酒馆替换 msg.extra。 */
    function visitImageRefs(chat, visit) {
        const seen = new Set();
        const extra = function (ex) {
            if (!ex || typeof ex !== "object" || seen.has(ex)) return;
            seen.add(ex);
            const gal = ex.sdg_gal;
            if (gal && typeof gal === "object") Object.values(gal).forEach(function (sw) {
                if (!sw || typeof sw !== "object") return;
                Object.values(sw).forEach(function (rec) {
                    if (rec && Array.isArray(rec.list)) rec.list.forEach(function (url, i) { visit(rec.list, i, url); });
                });
            });
            if (ex.sdg_images && typeof ex.sdg_images === "object") Object.keys(ex.sdg_images).forEach(function (key) { visit(ex.sdg_images, key, ex.sdg_images[key]); });
            if (typeof ex.sdg_image === "string") visit(ex, "sdg_image", ex.sdg_image);
        };
        chat.forEach(function (msg) {
            if (!msg) return;
            extra(msg.extra);
            if (Array.isArray(msg.swipe_info)) msg.swipe_info.forEach(function (slot) { if (slot) extra(slot.extra); });
        });
    }
    let imageBackupBusy = false, imageBackupCancelled = false;
    async function backupChatImages(onlyUrl) {
        const report = { saved: 0, failed: 0, stopped: false };
        if (imageBackupBusy) { report.stopped = true; return report; }
        const cont = ctx(), chat = (cont && cont.chat) || [], originalMessages = chat.slice();
        const sameChat = () => ctx().chat === chat && originalMessages.every(msg => chat.indexOf(msg) >= 0);
        const urls = new Set();
        visitImageRefs(chat, function (_obj, _key, url) {
            if (typeof url !== "string" || (onlyUrl && url !== onlyUrl)) return;
            if (isRemoteImage(url) || (url.startsWith("data:image/") && typeof cont.getRequestHeaders === "function")) urls.add(url);
        });
        imageBackupBusy = true;
        imageBackupCancelled = false;
        const buttons = qa("#sdg-backup-images, .sdg-save-image");
        buttons.forEach(button => { button.disabled = true; });
        try {
            let n = 0;
            for (const url of urls) {
                if (!sameChat() || imageBackupCancelled) { report.stopped = true; break; }
                setStatus("正在补存图片 " + (++n) + "/" + urls.size + "（不会重新生图）", C_OK);
                try {
                    const saved = await persistGenImage(url);
                    if (!sameChat() || imageBackupCancelled) { report.stopped = true; break; }
                    if (!saved || saved === url || isRemoteImage(saved)) { report.failed++; continue; }
                    const changed = [];
                    visitImageRefs(chat, function (obj, key, value) {
                        if (value === url) { changed.push({ obj: obj, key: key }); obj[key] = saved; }
                    });
                    if (!changed.length) continue;
                    const persisted = await persistChat("补存旧图", sameChat);
                    if (!persisted) {
                        changed.forEach(function (ref) { if (ref.obj[ref.key] === saved) ref.obj[ref.key] = url; });
                        /* 等待保存时切 swipe，新 extra 可能包含新链接，也需回滚。 */
                        if (sameChat()) visitImageRefs(chat, function (obj, key, value) { if (value === saved) obj[key] = url; });
                        report.failed++;
                    } else report.saved++;
                    if (!sameChat() || imageBackupCancelled) { report.stopped = true; break; }
                    qa("#chat .sdg-slot[data-sig]").forEach(slot => slot.removeAttribute("data-sig"));
                    renderAllImages();
                } catch (e) {
                    if (!sameChat() || (e && e.name === "AbortError") || /已取消|超时/.test(String(e && e.message))) { report.stopped = true; break; }
                    report.failed++;
                    log("旧图补存失败，保留原记录:", e && e.message);
                }
            }
            const summary = report.stopped ? "补存已停止，已保存 " + report.saved + " 张"
                : urls.size ? "补存完成：已保存 " + report.saved + " 张，未成功 " + report.failed + " 张（失效链接需原站点或备份恢复）"
                : "当前聊天没有需要补存的图片";
            setStatus(summary, report.failed || report.stopped ? C_WARN : C_OK);
            toast(summary, report.failed || report.stopped ? null : true);
            return report;
        } finally {
            imageBackupBusy = false;
            buttons.concat(qa("#sdg-backup-images, .sdg-save-image")).forEach(button => { button.disabled = false; });
        }
    }

    /* ——— 旧图清理 ———
       生成的图存在酒馆服务器的 images 目录里（聊天只留路径），但删楼/删聊天/重画
       都不会删文件，磁盘会一直涨。这里按文件名里的时间戳清掉超期的图：
       文件和聊天里的引用一起摘，摘空的槽恢复成「生成图片」按钮，可以重新生成。
       只认插件自己生成的文件名（sdg_<毫秒时间戳>_…），别人的图一概不碰。 */
    function sdgFileTime(p) {
        const m = /sdg_(\d{10,})_/.exec(String(p || ""));
        if (!m) return 0;
        const t = Number(m[1]);
        return Number.isFinite(t) && t > 1000000000000 && t < 4000000000000 ? t : 0;
    }
    async function deleteServerImage(relPath) {
        const c = ctx();
        if (!c || typeof c.getRequestHeaders !== "function") return false;
        try {
            const res = await fetch("/api/images/delete", {
                method: "POST", headers: c.getRequestHeaders(),
                body: JSON.stringify({ path: String(relPath || "").replace(/^\/+/, "") })
            });
            /* 404 = 文件本来就没了，照样算清掉 */
            return res.ok || res.status === 404;
        } catch (e) { log("删图失败:", e && e.message); return false; }
    }
    function pruneExpiredGallery(g, cutoff, dropped) {
        if (!g || typeof g !== "object") return false;
        let touched = false;
        for (const sk in g) {
            const sw = g[sk];
            if (!sw || typeof sw !== "object") continue;
            for (const slot in sw) {
                const r = sw[slot];
                if (!r || !Array.isArray(r.list)) continue;
                const keep = r.list.filter(function (u) {
                    const t = sdgFileTime(u);
                    if (t && t < cutoff) { if (dropped.indexOf(u) < 0) dropped.push(u); return false; }
                    return true;
                });
                if (keep.length === r.list.length) continue;
                touched = true;
                if (keep.length) {
                    r.list = keep;
                    r.cur = Math.min(Math.max(Number(r.cur) || 0, 0), keep.length - 1);
                } else delete sw[slot];
            }
            if (!Object.keys(sw).length) delete g[sk];
        }
        return touched;
    }
    /* 摘掉当前聊天里指向超期图的引用，返回摘掉的路径。
       swipe_info 各条回复也保存过图库快照，必须同时清理，避免切 swipe 时把旧引用合并回来。 */
    function dropExpiredRefs(cutoff) {
        const dropped = [];
        try {
            (ctx().chat || []).forEach(function (msg) {
                if (!msg) return;
                const g = msg.extra && msg.extra.sdg_gal;
                let currentTouched = pruneExpiredGallery(g, cutoff, dropped);
                if (Array.isArray(msg.swipe_info)) msg.swipe_info.forEach(function (slot) {
                    const snapGal = slot && slot.extra && slot.extra.sdg_gal;
                    if (pruneExpiredGallery(snapGal, cutoff, dropped) && slot === swipeInfoSlot(msg, false)) currentTouched = true;
                });
                if (currentTouched) syncSwipeExtra(msg);
            });
        } catch (e) { log("摘引用出错:", e && e.message); }
        return dropped;
    }
    async function cleanupOldImages(force) {
        const days = Number(cfg().imageKeepDays) || 0;
        if (days <= 0) return 0;
        const now = Date.now();
        const cutoff = now - days * 86400000;

        const dropped = dropExpiredRefs(cutoff);
        if (dropped.length) { persistChat("清理旧图"); try { renderAllImages(); } catch (e) {} }
        /* 本地聊天引用按每个新打开的聊天都清；只有服务器目录扫描需要半天节流。 */
        if (!force && now - (Number(cfg().imageCleanAt) || 0) < 12 * 3600 * 1000) return 0;
        save("imageCleanAt", now);

        /* 服务器文件：列出 images 下各子目录逐个筛。
           路径格式跟上传时存下来的一致（images/<目录>/<文件>），删除端点认这个。 */
        let killed = 0;
        try {
            const c = ctx();
            if (c && typeof c.getRequestHeaders === "function") {
                const fr = await fetch("/api/images/folders", { method: "POST", headers: c.getRequestHeaders(), body: "{}" });
                const folders = fr.ok ? await fr.json() : [];
                for (const folder of (Array.isArray(folders) ? folders : [])) {
                    const lr = await fetch("/api/images/list", {
                        method: "POST", headers: c.getRequestHeaders(),
                        body: JSON.stringify({ folder: folder, sortField: "name" })
                    });
                    if (!lr.ok) continue;
                    const files = await lr.json();
                    for (const f of (Array.isArray(files) ? files : [])) {
                        const name = String(typeof f === "string" ? f : (f && (f.name || f.path) || ""));
                        if (!name) continue;
                        const t = sdgFileTime(name);
                        if (!t || t >= cutoff) continue;
                        if (await deleteServerImage("images/" + folder + "/" + name.replace(/^.*\//, ""))) killed++;
                    }
                }
            }
        } catch (e) { log("清理文件出错:", e && e.message); }

        if (dropped.length || killed) {
            log("清理旧图：摘引用 " + dropped.length + " 条，删文件 " + killed + " 个（保留 " + days + " 天内）");
            setStatus("已清掉 " + killed + " 张超过 " + days + " 天的图", C_OK);
        }
        return killed;
    }

    /* 画风段处理：分层生图时把前缀脚手架里的 {Camera}/{Env}/{Mood}/{Chars}/{Outfit}/{Pose}
       填成当楼层的值（预设包导入的画风前缀就是这种结构）；非分层或仍有未填占位符时整段跳过，
       绝不把 {Camera} 之类的字面占位符发给站点。 */
    function styleSegment(seg, layers) {
        let t = String(seg == null ? "" : seg);
        if (!t) return "";
        if (layers && anyLayer(layers)) {
            const map = { "{Camera}": layers.camera, "{Env}": layers.env, "{Mood}": layers.mood, "{Chars}": layers.chars, "{Outfit}": layers.outfit, "{Pose}": layers.pose, "{Description}": "" };
            let hadPh = false;
            TPL_PH_RE.lastIndex = 0;
            t = t.replace(TPL_PH_RE, function (m) { hadPh = true; return String(map[m] == null ? "" : map[m]); });
            if (hadPh) {
                /* 空层值会留下 "Composition: | Setting: |" 空壳，清掉空段 */
                t = t.split(/[|\n]/).map(function (x) { return x.trim(); }).filter(function (x) {
                    const ci = x.indexOf(":");
                    return ci < 0 || x.slice(ci + 1).trim() !== "";
                }).join(" | ");
            }
        }
        TPL_PH_RE.lastIndex = 0;
        if (TPL_PH_RE.test(t)) return "";
        return t.trim();
    }

    async function generateImage(desc, layers) {
        const c = cfg();
        if (!c.genModel) throw new Error("请先填写生图模型");
        const finalPrompt = [styleSegment(c.genFixedPrompt, layers), String(desc || "").trim(), styleSegment(c.genPostfixPrompt, layers)].filter(Boolean).join(", ");
        if (!finalPrompt) throw new Error("没有可用的生图提示词");
        log("生图最终提示词:", finalPrompt.slice(0, 200));

        try {
            const faceRef = (cfg().faceRefOn && String(cfg().faceRef || "")) ? String(cfg().faceRef) : "";
            let imageUrl = (faceRef && String(cfg().faceRefMode) === "edits") ? await genEdits(finalPrompt, faceRef) : (await genImageUnified(finalPrompt)).image;
            if ((c.convertToJpeg === true || String(c.convertToJpeg) === "true") && String(imageUrl).startsWith("data:image/")) {
                try { imageUrl = await convertImageToJpeg(imageUrl); } catch (eJ) { log("转 JPEG 失败，保留原图:", eJ.message); }
            }
            imageUrl = await persistGenImage(imageUrl);
            return { image: imageUrl, prompt: finalPrompt, saved: true };
        } catch (e) {
            /* 保留已计费的临时地址供重试下载，但每次显示都明确标注未保存。 */
            if (e && e.sdgImageDownload) return { image: e.sdgImageUrl, prompt: finalPrompt, saved: false, warning: e.message };
            throw e;
        }
    }

    /* ============================================================
       显示：标记原位换图
       ============================================================ */

    /* —— 楼层图片存储 ——
       extra.sdg_gal = { "<swipe_id>": { "<槽位>": { list: [url,...], cur: 下标 } } }
       按 swipe 分开：左右滑到别的回复，图各是各的，不会串。
       每槽保留历史，重画不覆盖，折叠条上 ‹ n/N › 翻页看。
       老数据 sdg_images{槽:url} / sdg_image 自动并进当前 swipe。 —— */
    function swipeKey(msg) {
        const id = msg && Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
        return String(id);
    }
    function galRead(msg) {
        const ex = msg && msg.extra;
        if (!ex || typeof ex !== "object") return {};
        if (ex.sdg_gal && typeof ex.sdg_gal === "object") return ex.sdg_gal;
        return {};
    }
    function galWrite(msg) {
        if (!msg.extra || typeof msg.extra !== "object") msg.extra = {};
        if (!msg.extra.sdg_gal || typeof msg.extra.sdg_gal !== "object") {
            msg.extra.sdg_gal = {};
            /* 迁移老数据 */
            const legacy = (msg.extra.sdg_images && typeof msg.extra.sdg_images === "object") ? msg.extra.sdg_images
                         : (msg.extra.sdg_image ? { "0": String(msg.extra.sdg_image) } : null);
            if (legacy) {
                const sk = swipeKey(msg);
                msg.extra.sdg_gal[sk] = {};
                for (const k in legacy) if (legacy[k]) msg.extra.sdg_gal[sk][k] = { list: [String(legacy[k])], cur: 0 };
                delete msg.extra.sdg_images; delete msg.extra.sdg_image;
            }
        }
        return msg.extra.sdg_gal;
    }
    function slotRec(msg, slot) {
        const g = galRead(msg);
        const legacyTop = (msg && msg.extra && (msg.extra.sdg_images || msg.extra.sdg_image)) ? galWrite(msg) : g;
        const sw = legacyTop[swipeKey(msg)];
        const r = sw && sw[String(slot)];
        if (!r || !Array.isArray(r.list) || !r.list.length) return null;
        return r;
    }
    function getImage(msg, slot) {
        const r = slotRec(msg, slot);
        if (!r) return "";
        const i = Math.min(Math.max(Number(r.cur) || 0, 0), r.list.length - 1);
        return String(r.list[i] || "");
    }
    function getImageCount(msg, slot) { const r = slotRec(msg, slot); return r ? r.list.length : 0; }
    function getImageCur(msg, slot) { const r = slotRec(msg, slot); return r ? Math.min(Math.max(Number(r.cur) || 0, 0), r.list.length - 1) : 0; }
    /* 新图追加进历史并成为当前 */
    function setImage(msg, slot, url, swipeOverride) {
        /* swipeOverride：生图是异步的，等图回来时她可能已经左右滑到别的回复了。
           不指定的话 swipeKey 读到的是「现在」那条，图就归错了人。 */
        const g = galWrite(msg), sk = swipeOverride || swipeKey(msg);
        if (sk !== swipeKey(msg)) {
            const origin = swipeInfoSlot(msg, false, sk);
            const saved = origin && origin.extra.sdg_gal && origin.extra.sdg_gal[sk];
            if (saved) g[sk] = saved;
        }
        if (!g[sk] || typeof g[sk] !== "object") g[sk] = {};
        let r = g[sk][String(slot)];
        if (!r || !Array.isArray(r.list)) r = g[sk][String(slot)] = { list: [], cur: 0 };
        r.list.push(String(url || ""));
        if (r.list.length > 20) r.list.shift();
        r.cur = r.list.length - 1;
    }
    function stepImage(msg, slot, delta) {
        const r = slotRec(msg, slot); if (!r) return;
        const n = r.list.length;
        r.cur = ((getImageCur(msg, slot) + delta) % n + n) % n;
    }
    function hasAnyImage(msg) {
        const g = galRead(msg);
        const sw = g[swipeKey(msg)];
        if (sw) for (const k in sw) if (sw[k] && Array.isArray(sw[k].list) && sw[k].list.length) return true;
        /* 老数据 */
        const ex = msg && msg.extra;
        if (ex && ex.sdg_images) for (const k in ex.sdg_images) if (ex.sdg_images[k]) return true;
        if (ex && ex.sdg_image) return true;
        return false;
    }
    /* 标记被删 → 图跟着删：摘掉这楼当前 swipe 的整份图库记录。
       只摘聊天里的引用、不碰服务器上的文件 —— 文件由「存图天数」到期统一清，
       这样万一这里判错了，拿聊天备份就能把图全找回来。 */
    function dropFloorImages(msg, why) {
        const g = galRead(msg), sk = swipeKey(msg), sw = g[sk];
        if (!sw) return false;
        let n = 0;
        for (const k in sw) { const r = sw[k]; if (r && Array.isArray(r.list)) n += r.list.length; }
        delete g[sk];
        if (msg.extra) { delete msg.extra.sdg_images; delete msg.extra.sdg_image; }
        syncSwipeExtra(msg);
        persistChat(why || "标记被删，清图");
        log((why || "清图") + "：摘掉 " + n + " 张引用（文件没动）");
        return true;
    }

    /* 上一次重绘时这楼正文里有几个标记（纯内存，不写进聊天记录）。
       「她把标记删了」只能靠前后对比判断：**亲眼看到从有变没**才算删。
       本来就没标记的楼（图贴在楼尾那种）值一直是 0，永远不会被判成删；
       刷新后这张表是空的，没观察到转变就什么都不做。 */
    const tagsSeen = {};
    function tagsSeenKey(idx, msg) { return idx + ":" + swipeKey(msg); }
    /* 她编辑完这一楼：标记从有变没 → 这楼的图跟着清（只清这一楼） */
    function dropIfMarkersGone(idx, msg) {
        if (!msg || msg.is_user) return false;
        const body = String(msg.mes || "").trim();
        if (!body) return false;                       /* 流式刚开始 / 切 swipe 那一瞬间正文是空的 */
        const k = tagsSeenKey(idx, msg);
        if (!(Number(tagsSeen[k]) > 0)) return false;  /* 上次重绘时就没有标记 → 不是她删的 */
        if (findAllTags(msg.mes).length) return false;
        if (!hasAnyImage(msg)) { tagsSeen[k] = 0; return false; }
        tagsSeen[k] = 0;
        return dropFloorImages(msg, "标记被删，清图");
    }

    function escHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    /* 楼层 innerHTML 里把标记换成槽；标记文字在 HTML 里可能是原样也可能被转义过，两种都认 */
    function htmlMarkerRegexes() {
        const out = [];
        markerPairs().forEach(function (p) {
            out.push(tagRegex(p));
            /* <draw> 这类在 HTML 里会是实体形式，另备一条 */
            const ep = escHtml(p.pre), es = escHtml(p.suf);
            if (ep !== p.pre || es !== p.suf) out.push(tagRegex({ pre: ep, suf: es }));
        });
        return out;
    }
    function slotHTML(innerHtml) {
        return '<div class="sdg-slot"><div class="sdg-slot-body"></div><div class="sdg-tag">' + innerHtml + '</div></div>';
    }
    /* 无工具栏的孤立图限高 = 「键盘未弹出时」视口高的 70%，定格成固定像素。
       vh/dvh 这类视口单位在手机上会被键盘挤压：点输入框弹出键盘 → 视口变矮 → 限高跟着缩水
       → 图按比例连宽带窄。固定 px 后键盘不再影响；视口变大（刷新/转屏）只往大更新，不往小缩 */
    let SDG_CAP_H = 0;
    function maxImgH() {
        const h = document.documentElement.clientHeight || window.innerHeight || 0;
        if (h && Math.round(h * 0.7) > SDG_CAP_H) SDG_CAP_H = Math.round(h * 0.7);
        return SDG_CAP_H ? SDG_CAP_H + "px" : "70vh";
    }
    let closeImagePreview = null;
    let imagePreviewEventsBound = false;
    function openImagePreview(src, trigger) {
        if (!src) return;
        if (closeImagePreview) closeImagePreview();
        const box = document.createElement("dialog");
        box.id = "sdg-image-preview";
        box.dataset.mode = "fit";
        box.setAttribute("aria-label", "生成图片预览");
        box.setAttribute("aria-modal", "true");
        box.setAttribute("role", "dialog");
        box.innerHTML = '<button type="button" class="sdg-preview-close" aria-label="关闭图片预览" title="关闭（Esc）" autofocus>×</button>' +
            '<div class="sdg-preview-viewport"><div class="sdg-preview-canvas">' +
            '<img class="sdg-preview-image" alt="生成图片预览" draggable="false">' +
            '<p class="sdg-preview-error" role="status" hidden>图片加载失败，请关闭后重试；远程图片链接可能已过期。</p></div></div>';
        const image = box.querySelector("img");
        const button = box.querySelector(".sdg-preview-close");
        const viewport = box.querySelector(".sdg-preview-viewport");
        const canvas = box.querySelector(".sdg-preview-canvas");
        // 每次打开都先适屏；用户缩放只影响当前预览，不改变楼层图片或页面比例。
        let mode = "fit", scale = 0, closed = false, drag = null, pinch = null, dragged = false;
        const pointers = new Map();
        const ready = () => !closed && !image.hidden && image.naturalWidth > 0 && image.naturalHeight > 0;
        const fitScale = () => Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
        const minScale = () => Math.min(0.1, fitScale());
        const localPoint = function (x, y) {
            const rect = viewport.getBoundingClientRect();
            return { x: x - rect.left - viewport.clientLeft, y: y - rect.top - viewport.clientTop };
        };
        const imagePoint = function (at) {
            const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
            return {
                x: (viewport.scrollLeft + at.x - Math.max(0, (viewport.clientWidth - w) / 2)) / w,
                y: (viewport.scrollTop + at.y - Math.max(0, (viewport.clientHeight - h) / 2)) / h,
            };
        };
        const render = function (next, at, point) {
            if (!ready() || !(next > 0) || !Number.isFinite(next)) return;
            scale = next;
            const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
            image.style.setProperty("width", w + "px", "important");
            image.style.setProperty("height", h + "px", "important");
            // 首次加载在算好适屏尺寸后才显示，避免闪现超大原图。
            image.style.visibility = "visible";
            box.dataset.mode = mode;
            // 缩放以双指中点为锚，保持正在查看的位置。
            const left = point ? point.x * w + Math.max(0, (viewport.clientWidth - w) / 2) - at.x : (w - viewport.clientWidth) / 2;
            const top = point ? point.y * h + Math.max(0, (viewport.clientHeight - h) / 2) - at.y : (h - viewport.clientHeight) / 2;
            viewport.scrollLeft = Math.max(0, Math.min(Math.max(0, w - viewport.clientWidth), left));
            viewport.scrollTop = Math.max(0, Math.min(Math.max(0, h - viewport.clientHeight), top));
        };
        const layout = function () {
            if (ready()) render(mode === "fit" ? fitScale() : scale);
        };
        const zoomTo = function (next, at, point) {
            if (!ready() || !scale) return;
            point = point || imagePoint(at);
            mode = "custom";
            render(Math.min(4, Math.max(minScale(), next)), at, point);
        };
        const close = function () {
            if (closed) return;
            closed = true;
            pointers.clear(); drag = pinch = null;
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("resize", layout);
            document.documentElement.classList.remove("sdg-preview-open");
            box.remove();
            if (closeImagePreview === close) closeImagePreview = null;
            if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
        };
        const onKey = function (ev) {
            if (ev.key === "Escape") {
                ev.preventDefault(); ev.stopPropagation(); close();
            } else if (ev.key === "Tab") {
                const buttons = Array.from(box.querySelectorAll("button:not(:disabled)"));
                const index = buttons.indexOf(document.activeElement);
                const next = index < 0 ? (ev.shiftKey ? buttons.length - 1 : 0) :
                    (index + (ev.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
                ev.preventDefault(); ev.stopPropagation(); buttons[next].focus();
            }
        };
        button.addEventListener("click", close);
        box.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (dragged) { dragged = false; return; }
            if (ev.target === box || ev.target === viewport || ev.target === canvas) close();
        });
        const capture = function (id) {
            try { viewport.setPointerCapture(id); } catch (e) {}
        };
        const pair = function () {
            const [a, b] = Array.from(pointers.values());
            return { distance: Math.hypot(b.x - a.x, b.y - a.y), at: localPoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
        };
        const startGesture = function () {
            drag = pinch = null;
            if (pointers.size >= 2) {
                const p = pair();
                pinch = { distance: Math.max(1, p.distance), scale, point: imagePoint(p.at) };
                dragged = true;
                pointers.forEach((p, id) => capture(id));
            } else if (pointers.size === 1) {
                const [id, p] = pointers.entries().next().value;
                drag = { id, x: p.x, y: p.y, left: viewport.scrollLeft, top: viewport.scrollTop };
            }
        };
        viewport.addEventListener("pointerdown", function (ev) {
            if (!ready() || !scale || ev.pointerType !== "touch" || ev.button !== 0) return;
            if (!pointers.size) dragged = false;
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            startGesture();
        });
        viewport.addEventListener("pointermove", function (ev) {
            if (!pointers.has(ev.pointerId)) return;
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (pinch && pointers.size >= 2) {
                const p = pair();
                ev.preventDefault();
                zoomTo(pinch.scale * p.distance / pinch.distance, p.at, pinch.point);
            } else if (drag) {
                const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
                if (!dragged && Math.abs(dx) + Math.abs(dy) < 4) return;
                capture(ev.pointerId);
                dragged = true;
                viewport.classList.add("sdg-preview-dragging");
                ev.preventDefault();
                viewport.scrollLeft = Math.max(0, Math.min(Math.max(0, viewport.scrollWidth - viewport.clientWidth), drag.left - dx));
                viewport.scrollTop = Math.max(0, Math.min(Math.max(0, viewport.scrollHeight - viewport.clientHeight), drag.top - dy));
            }
        });
        const endGesture = function (ev) {
            if (!pointers.delete(ev.pointerId)) return;
            viewport.classList.remove("sdg-preview-dragging");
            startGesture();
            try { viewport.releasePointerCapture(ev.pointerId); } catch (e) {}
        };
        viewport.addEventListener("pointerup", endGesture);
        viewport.addEventListener("pointercancel", endGesture);
        viewport.addEventListener("lostpointercapture", function (ev) {
            // 子图片的隐式触摸捕获转交给视口时，不要中断仍在进行的手势。
            if (ev.target === viewport) endGesture(ev);
        });
        box.addEventListener("cancel", function (ev) { ev.preventDefault(); close(); });
        box.addEventListener("close", close);
        image.addEventListener("load", layout);
        image.addEventListener("error", function () {
            image.hidden = true;
            box.querySelector(".sdg-preview-error").hidden = false;
        });
        document.documentElement.classList.add("sdg-preview-open");
        document.body.appendChild(box);
        closeImagePreview = close;
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", layout);
        try { box.showModal(); }
        catch (e) { box.setAttribute("open", ""); }
        image.src = src;
        if (image.complete) layout();
        button.focus({ preventScroll: true });
    }
    function bindImagePreview(image) {
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", "点击放大生成图片");
        image.title = "点击放大预览";
        if (imagePreviewEventsBound) return;
        imagePreviewEventsBound = true;
        const activate = function (ev) {
            if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
            const target = ev.target;
            const im = target && target.closest && target.closest("#chat .mes .mes_text img.sdg-img");
            if (!im) return;
            // src 属性随历史翻页立即更新；currentSrc 在新图片加载前可能仍指向旧图。
            const src = im.getAttribute("src") || im.currentSrc;
            if (!src) return;
            ev.preventDefault(); ev.stopPropagation();
            openImagePreview(src, im);
        };
        // 仅匹配本插件楼层图；捕获阶段避开主题的冒泡拦截，重绘/克隆后也有效。
        // 只用 click，不另绑 touchend，避免一次触摸打开两次或误把滚动当点击。
        window.addEventListener("click", activate, true);
        window.addEventListener("keydown", activate, true);
    }

    let imageStorageEventsBound = false;
    function updateImageStorageNotice(body, src) {
        let note = Array.from(body.children).find(el => el.classList.contains("sdg-storage-note"));
        if (!isRemoteImage(src)) { if (note) note.remove(); return; }
        if (!note) {
            note = document.createElement("div");
            note.className = "sdg-storage-note";
            note.innerHTML = '<span>仅临时链接，尚未保存；站点删图后会失效。</span><button type="button" class="sdg-save-image">重试保存</button>';
            body.appendChild(note);
        }
        note.dataset.src = src;
        note.querySelector("button").disabled = imageBackupBusy;
        if (!imageStorageEventsBound) {
            imageStorageEventsBound = true;
            window.addEventListener("click", function (ev) {
                const target = ev.target && ev.target.closest && ev.target.closest("#chat .sdg-storage-note .sdg-save-image");
                if (!target || target.disabled) return;
                ev.preventDefault(); ev.stopPropagation();
                backupChatImages(target.closest(".sdg-storage-note").dataset.src);
            }, true);
        }
    }

    /* 一个槽三种样子：生成图片按钮 / 生成中 / 折叠条+图 */
    function fillSlot(body, state, src, open, cur, total) {
        if (state === "busy") {
            body.innerHTML = '<button type="button" class="sdg-genbtn" disabled><span class="sdg-spin"></span> 生成中…</button>';
            return;
        }
        if (state !== "img") {
            body.innerHTML = '<button type="button" class="sdg-genbtn">生成图片</button>';
            return;
        }
        const barHTML =
            '<div class="sdg-bar' + (open ? "" : " closed") + '">' +
                '<span class="sdg-bar-l"><span class="sdg-bar-ico">📷</span><span class="sdg-bar-txt">点击查看图片</span></span>' +
                '<span class="sdg-bar-r">' +
                    (total > 1
                        ? '<span class="sdg-pager"><button type="button" class="sdg-pg" data-d="-1" title="上一张">‹</button><span class="sdg-pgn">' + (cur + 1) + '/' + total + '</span><button type="button" class="sdg-pg" data-d="1" title="下一张">›</button></span>'
                        : '') +
                    '<button type="button" class="sdg-slot-regen" title="重新生成一张（旧图保留可翻看）">↻ 重画</button>' +
                '</span>' +
            '</div>';
        /* 原位更新：已渲染过的槽只换折叠条和 src，不重建 <img>。
           重建会把图片区域高度打回 0、新图加载完再弹回限高，楼层内容整体上下跳，
           往上翻的时候像被弹回图片那里（style.css 的 overflow-anchor 反制管不了这个）。 */
        const prevImg = body.querySelector(".sdg-imgbox .sdg-img");
        if (prevImg) {
            const tmp = document.createElement("div");
            tmp.innerHTML = barHTML;
            const oldBar = body.querySelector(".sdg-bar");
            if (oldBar) oldBar.replaceWith(tmp.firstChild);
            else body.insertBefore(tmp.firstChild, body.firstChild);
            const box = prevImg.parentNode;
            if (box && box.classList.contains("sdg-imgbox")) box.style.display = open ? "" : "none";
            if (prevImg.getAttribute("src") !== src) {
                /* 换图前先按当前渲染高度垫底，新图加载完成再撤，加载间隙楼层不塌陷 */
                const h = prevImg.offsetHeight || prevImg.clientHeight;
                if (h) prevImg.style.minHeight = h + "px";
                prevImg.onload = function () { prevImg.style.minHeight = ""; };
                prevImg.onerror = function () { prevImg.style.minHeight = ""; };
                prevImg.setAttribute("src", src);
            }
            updateImageStorageNotice(body, src);
            return;
        }
        body.innerHTML = barHTML +
            '<div class="sdg-imgbox"' + (open ? "" : ' style="display:none"') + '>' +
                '<img class="sdg-img" alt="生成图片">' +
            '</div>';
        const im = body.querySelector("img");
        if (im) {
            /* 与上方工具栏同宽，按原比例展开；限高会让竖图等比缩窄而与栏错位。 */
            im.style.maxWidth = "100%";
            im.style.width = "100%";
            im.style.height = "auto";
            im.style.maxHeight = "none";
            im.style.objectFit = "contain";
            im.setAttribute("src", src);
            bindImagePreview(im);
        }
        updateImageStorageNotice(body, src);
    }

    /* 在 mes_text 里只找「文本节点」里的标记，切成槽，其余节点（别的美化插件渲染的 HTML）原样不动。
       跳过 script/style/pre/code 和我们自己的槽。 */
    function replaceMarkersInDom(root) {
        const regs = htmlMarkerRegexes();
        const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) {
            let p = n.parentNode, skip = false;
            while (p && p !== root) {
                const tag = p.nodeName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "PRE" || tag === "CODE" || tag === "TEXTAREA" ||
                    (p.classList && p.classList.contains("sdg-slot"))) { skip = true; break; }
                p = p.parentNode;
            }
            if (!skip && n.nodeValue && (n.nodeValue.indexOf("#") >= 0 || n.nodeValue.indexOf("<") >= 0)) nodes.push(n);
        }
        let made = 0;
        nodes.forEach(function (tn) {
            const text = tn.nodeValue;
            for (const re of regs) {
                re.lastIndex = 0;
                if (!re.test(text)) continue;
                re.lastIndex = 0;
                const frag = document.createDocumentFragment();
                let last = 0, m;
                while ((m = re.exec(text)) !== null) {
                    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                    const slot = document.createElement("div");
                    slot.className = "sdg-slot";
                    slot.innerHTML = '<div class="sdg-slot-body"></div><div class="sdg-tag"></div>';
                    slot.querySelector(".sdg-tag").textContent = String(m[2] || "").trim();
                    frag.appendChild(slot);
                    last = m.index + m[0].length;
                    made++;
                }
                if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
                tn.parentNode.replaceChild(frag, tn);
                break;
            }
        });
        return made;
    }

    /* 酒馆会把正文里的换行/空行渲染成 <br> 或多个段落，于是一条跨多段的长标记
       被拆进好几个文本节点，逐节点跑正则就匹配不到完整标记 —— 表现就是
       findAllTags 认得出（它读的是 msg.mes 字符串），但 DOM 里一个槽都建不出来，
       标记文字一直留在楼里、生成好的图也没地方显示。
       这里把容器里的文本节点拼成一条虚拟全文，在上面定位标记，再用 Range 跨节点替换。 */
    function replaceMarkersAcrossNodes(root) {
        let made = 0;
        for (let guard = 0; guard < 40; guard++) {
            const regs = htmlMarkerRegexes();
            const map = [];
            let full = "";
            const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
            let n;
            while ((n = walker.nextNode())) {
                let par = n.parentNode, skip = false;
                while (par && par !== root) {
                    const tag = par.nodeName;
                    if (tag === "SCRIPT" || tag === "STYLE" || tag === "PRE" || tag === "CODE" || tag === "TEXTAREA" ||
                        (par.classList && par.classList.contains("sdg-slot"))) { skip = true; break; }
                    par = par.parentNode;
                }
                if (skip) continue;
                const v = n.nodeValue || "";
                map.push({ node: n, start: full.length, len: v.length });
                full += v;
            }
            if (!full || !map.length) break;

            let hit = null;
            for (const re of regs) {
                re.lastIndex = 0;
                const m = re.exec(full);
                if (m) { hit = { s: m.index, e: m.index + m[0].length, inner: String(m[2] || "").trim() }; break; }
            }
            if (!hit || !hit.inner) break;

            const locate = function (pos) {
                for (const it of map) {
                    if (pos >= it.start && pos <= it.start + it.len) return { node: it.node, off: pos - it.start };
                }
                const last = map[map.length - 1];
                return { node: last.node, off: last.len };
            };
            const a = locate(hit.s), b = locate(hit.e);
            try {
                const range = document.createRange();
                range.setStart(a.node, a.off);
                range.setEnd(b.node, b.off);
                range.deleteContents();
                const slot = document.createElement("div");
                slot.className = "sdg-slot";
                slot.innerHTML = '<div class="sdg-slot-body"></div><div class="sdg-tag"></div>';
                slot.querySelector(".sdg-tag").textContent = hit.inner;
                range.insertNode(slot);
                made++;
            } catch (e) { log("跨节点替换失败:", e && e.message); break; }
        }
        if (made) log("跨节点补建了 " + made + " 个槽");
        return made;
    }

    /* 槽建不出来时的兜底：至少把图挂在楼尾，别让她只看到一屏提示词文字 */
    function showOrphanImage(el, src) {
        let img = el.querySelector("img.sdg-img.sdg-orphan");
        if (!src) { if (img) img.remove(); updateImageStorageNotice(el, ""); return false; }
        if (!img) {
            img = document.createElement("img");
            img.className = "sdg-img sdg-orphan";
            img.alt = "生成图片";
            img.style.maxWidth = "100%";
            img.style.width = "auto";
            img.style.height = "auto";
            img.style.maxHeight = maxImgH();
            img.style.objectFit = "contain";
            el.appendChild(img);
        }
        if (img.getAttribute("src") !== src) img.setAttribute("src", src);
        bindImagePreview(img);
        updateImageStorageNotice(el, src);
        return true;
    }

    function renderFloorImage(idx, opts) {
        let msg = null;
        try { msg = (ctx().chat || [])[idx]; } catch (e) { return false; }
        if (!msg) return false;
        const mesEl = q('#chat .mes[mesid="' + idx + '"]');
        /* 编辑器代替 .mes_text 的这段时间保持 DOM 原样；保存/取消后由酒馆事件重绘。 */
        if (mesEl && mesEl.querySelector(".edit_textarea")) return false;
        const el = mesEl && mesEl.querySelector(".mes_text");
        if (!el) {
            /* 楼层 DOM 还没建出来：非流式时酒馆先发 MESSAGE_RECEIVED、后 addOneMessage。
               直接返回的话标记和「生成中」要等生图结束才显示，调用方带 domRetry 时稍等重试 */
            const left = (opts && opts.domRetry) || 0;
            if (left > 0) setTimeout(function () { try { renderFloorImage(idx, { domRetry: left - 1 }); } catch (e) {} }, 200);
            return false;
        }
        const tags = findAllTags(msg.mes);
        tagsSeen[tagsSeenKey(idx, msg)] = tags.length;
        const hide = cfg().hideTagText !== false;

        /* swipe 变了：这楼的槽全部作废重来（否则旧回复的图挂在新回复上） */
        const sk = swipeKey(msg);
        if (mesEl.getAttribute("data-sdg-swipe") !== sk) {
            qa('#chat .mes[mesid="' + idx + '"] .sdg-slot').forEach(function (x) { x.remove(); });
            const orphan0 = el.querySelector("img.sdg-img.sdg-orphan"); if (orphan0) orphan0.remove();
            mesEl.setAttribute("data-sdg-swipe", sk);
        }

        /* 正文里没标记：图贴在楼尾（她很多楼本来就是这样的——正文里没有标记、图在图库里）。
           这里绝不能动数据：重绘会在启动、切聊天、每次 DOM 变动后把所有楼跑一遍，
           在这儿删东西等于拿显示状态去改她的聊天记录。清图只认 tagsSeen 的前后对比。 */
        if (!tags.length) {
            qa('#chat .mes[mesid="' + idx + '"] .sdg-slot').forEach(function (x) { x.remove(); });
            return showOrphanImage(el, hasAnyImage(msg) ? getImage(msg, 0) : "");
        }
        updateImageStorageNotice(el, "");

        /* 第一遍：文本节点里的标记 → 槽（只碰文本，别的插件的 HTML 原样留着） */
        const have = el.querySelectorAll(".sdg-slot").length;
        if (have < tags.length) {
            replaceMarkersInDom(el);
            /* 还缺 → 标记大概率被酒馆的换行渲染拆到了多个节点里，跨节点再来一遍 */
            if (el.querySelectorAll(".sdg-slot").length < tags.length) replaceMarkersAcrossNodes(el);
            const orphan = el.querySelector("img.sdg-img.sdg-orphan"); if (orphan) orphan.remove();
        }
        /* 标记文本不在 DOM 里（swipe/重绘竞态把文本节点吞过）：补回文本节点再转一遍，
           否则这层的槽只能永远退到楼尾显示。
           但 re-roll 进行中不算（swipe_id 已前移、swipes[new] 还是空洞，msg.mes 仍是旧回复）——
           这时补回的会是旧标记，重roll出来的楼层凭空多出旧框 */
        const swipesArr = Array.isArray(msg.swipes) ? msg.swipes : null;
        const swipeSettled = !swipesArr || !Number.isInteger(msg.swipe_id) ||
            (swipesArr[msg.swipe_id] != null && swipesArr[msg.swipe_id] === msg.mes);
        const made = el.querySelectorAll(".sdg-slot").length;
        if (swipeSettled && made < tags.length) {
            for (let k = made; k < tags.length; k++) el.appendChild(document.createTextNode("\n\n" + tags[k].full));
            replaceMarkersInDom(el);
            replaceMarkersAcrossNodes(el);
        }
        /* 第二遍：按文档顺序给槽编号，按状态填内容 */
        const slots = Array.prototype.slice.call(el.querySelectorAll(".sdg-slot"));
        if (!slots.length) {
            /* 两种替换都没建出槽（楼被别的插件改造过等）：图退到楼尾显示 */
            const src0 = hasAnyImage(msg) ? getImage(msg, 0) : "";
            if (src0) { log("槽建不出来，图退到楼尾"); return showOrphanImage(el, src0); }
            return false;
        }
        slots.forEach(function (slot, i) {
            slot.setAttribute("data-i", String(i));
            const body = slot.querySelector(".sdg-slot-body");
            const tagEl = slot.querySelector(".sdg-tag");
            if (tagEl) tagEl.style.display = hide ? "none" : "";
            const src = getImage(msg, i);
            const total = getImageCount(msg, i), cur = getImageCur(msg, i);
            const busy = !!genBusy[idx + ":" + i];
            const open = !collapsed[idx + ":" + i];
            const state = busy ? "busy" : (src ? "img" : "empty");
            const sig = state + "|" + (state === "img" ? (open ? "o" : "c") + "|" + cur + "/" + total + "|" + src.length : "");
            if (slot.getAttribute("data-sig") === sig) return;
            slot.setAttribute("data-sig", sig);
            fillSlot(body, state, src, open, cur, total);
        });
        return true;
    }
    function renderAllImages() {
        let chat = [];
        try { chat = (ctx() && ctx().chat) || []; } catch (e) { return; }
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_user) continue;
            if (!hasAnyImage(m) && !mayHaveMarkers(m.mes)) continue;
            try { renderFloorImage(i); } catch (e) {}
        }
    }

    /* ============================================================
       提取 / 生图流程
       ============================================================ */
    function clearRetry() {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }
    function isConfigError(e) {
        const m = String(e && e.message || e || "");
        return m.indexOf("请先配置") >= 0 || m.indexOf("请先选择") >= 0 || m.indexOf("请先填写") >= 0;
    }
    function scheduleRetry(text, supplement, targetIdx, msg) {
        clearRetry();
        if (!cfg().retryOnce) { toast("提取失败：" + msg, false); return; }
        setStatus("提取失败，10 秒后自动重试一次…", C_ERR);
        retryTimer = setTimeout(function () {
            retryTimer = null;
            try {
                if (!cfg().enabled) { setStatus("自动重试已取消：插件已关闭", C_DIM); return; }
                if (processing) { setStatus("自动重试已取消：已有新请求进行中", C_DIM); return; }
                const target = (ctx().chat || [])[targetIdx];
                if (target && String(target.mes || "") !== String(text || "")) {
                    setStatus("自动重试已取消：这一层内容已变化", C_DIM);
                    return;
                }
                setStatus("正在自动重试提取…", C_OK);
                runExtract(text, supplement || "", { auto: true, targetIdx: targetIdx, attempt: 1 });
            } catch (e) {
                setStatus("自动重试启动失败：" + e.message, C_ERR);
            }
        }, 10000);
    }

    function waitForUiPaint() {
        return new Promise(function (resolve) {
            if (typeof window.requestAnimationFrame === "function") {
                window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { resolve(); }); });
            }
            else setTimeout(resolve, 0);
        });
    }

    function floorTarget(idx) {
        const msg = (ctx().chat || [])[idx];
        return { idx: idx, msg: msg, swipe: swipeKey(msg), text: String(msg && msg.mes || "") };
    }
    function floorTargetMatches(target) {
        const msg = (ctx().chat || [])[target.idx];
        return msg === target.msg && swipeKey(msg) === target.swipe && String(msg && msg.mes || "") === target.text;
    }

    async function runExtract(text, supplement, opts) {
        opts = opts || {};
        const targetIdx = typeof opts.targetIdx === "number" ? opts.targetIdx : currentIdx;
        const target = floorTarget(targetIdx);
        const attempt = Number(opts.attempt || 0);
        if (processing) return;
        processing = true;
        const runId = ++extractEpoch;
        /* 看门狗：万一请求既不返回也不抛错（中转站吞连接），finally 永不执行，
           processing 会一直是 true —— 之后每次自动提取都在上面那行被静默吞掉、
           提取按钮永久变灰。这里兜住，到点强制解锁并说清原因。 */
        /* 超时填了就按它 +30 秒；填 0（不限）按 10 分钟兜底 —— 只为了防死锁，
           不是给请求设时限（看门狗只解锁和提示，不中断在跑的请求） */
        const rt = Number(cfg().requestTimeout) || 0;
        const guardMs = (rt > 0 ? rt + 30 : 600) * 1000;
        let guard = setTimeout(function () {
            guard = null;
            if (runId !== extractEpoch) return;
            /* 放开锁的同时让迟到的结果失效；底层请求仍按用户超时设置继续或自行结束。 */
            extractEpoch++;
            processing = false;
            const bg = q("#sdg-btn-extract"); if (bg) bg.disabled = false;
            setStatus("提取没有响应，已解锁（可以再点提取）", C_ERR);
            log("提取看门狗触发，强制解锁");
        }, guardMs);
        let pendingGen = null;
        const layered = !!cfg().layered;
        setStatus(attempt > 0 ? "正在自动重试提取…" : (layered ? "正在分层提取…" : "正在提取…"), C_OK);
        const btn = q("#sdg-btn-extract"); if (btn) btn.disabled = true;
        try {
            let layerOpts = null;
            if (layered) {
                const locks = opts.locks || layerLocks();
                layerOpts = { prev: prevLayers(targetIdx), locks: locks };
            }
            const raw = await callSubAI(text, supplement || "", layerOpts);
            if (runId !== extractEpoch) return;
            if (!floorTargetMatches(target)) {
                setStatus("提取期间回复已切换或修改，已跳过旧结果，请在目标回复重新提取", C_WARN);
                return;
            }
            currentIdx = targetIdx;

            let desc = raw, layers = null;
            if (layered) {
                const parsed = parseLayers(raw);
                if (parsed) {
                    layers = mergeLayers(parsed, layerOpts.prev, layerOpts.locks);
                    setLayerBoxes(layers);
                    layersFresh = true;
                    desc = joinLayers(layers);
                    /* 模型说「沿用」但其实没有旧值可沿用时，那层会是空的 —— 别静默丢掉 */
                    const wiped = LAYERS.filter(function (l) {
                        return isNoChange(parsed[l]) && !String(layers[l] || "").trim();
                    });
                    if (wiped.length) {
                        setStatus("分层提取完成（" + wiped.map(function (l) { return LAYER_LABEL[l] || l; }).join("/") + " 没内容）", C_WARN);
                        log("这些层模型回了 NO_CHANGE 但没有旧值可沿用:", wiped.join(","));
                    } else setStatus("分层提取完成", C_OK);
                } else {
                    layersFresh = false;
                    setStatus("副AI没按分层输出，已整段兜底", C_WARN);
                }
            } else {
                layersFresh = false;
                setStatus("提取完成", C_OK);
            }
            setPreview(desc);

            if (opts.auto) {
                /* 自动生图前先把提示词写入楼层并让楼层更新落盘、绘制出来。
                   自动生图本身也依赖这条注入记录，因此即使单独关闭了「提取后自动注入」，
                   开启自动生图时仍先注入；这样不会出现图已经生成、提示词之后才出现的顺序竞态。 */
                const shouldInject = !!cfg().autoInject || (!!cfg().autoGenerate && !!cfg().enabled);
                let promptReady = !shouldInject;
                if (shouldInject) {
                    try {
                        const r = injectDescToMessage(desc, targetIdx, layers);
                        target.text = String(target.msg && target.msg.mes || "");
                        promptReady = !!(r.injected || r.reason === "duplicate");
                        if (r.injected) setStatus("已注入 ✓", C_OK);
                        else if (r.reason === "duplicate") setStatus("这条已经在楼里了，没重复注入", C_WARN);
                        else setStatus("没注入（" + (r.reason || "未知") + "）", C_WARN);
                        if (promptReady) {
                            await persistChat("自动生图前保存注入提示词");
                            await waitForUiPaint();
                            if (runId !== extractEpoch) return;
                            if (!floorTargetMatches(target)) {
                                setStatus("提示词已保存到原回复；回复已切换或修改，已跳过自动生图", C_WARN);
                                return;
                            }
                        }
                    } catch (eInj) {
                        log("自动注入失败:", eInj.message);
                        setStatus("注入失败: " + eInj.message, C_ERR);
                    }
                }
                if (cfg().autoGenerate && cfg().enabled) {
                    if (promptReady) pendingGen = { idx: targetIdx, desc: desc, layers: layers };
                    else setStatus("提示词未能注入楼层，已跳过自动生图", C_ERR);
                }
            }
        } catch (e) {
            if (runId !== extractEpoch) return;
            if (!floorTargetMatches(target)) {
                setStatus("回复已切换或修改，已停止原回复的提取及重试", C_WARN);
                return;
            }
            console.error(LOG, e);
            const userAbort = !!(e && e.sdgUserAbort);
            const msg = userAbort ? "请求已被打断" : (e && e.message || String(e));
            setStatus("提取失败: " + msg, C_ERR);
            if (!userAbort && !isConfigError(e) && attempt === 0 && opts.auto) {
                scheduleRetry(text, supplement || "", targetIdx, msg);
            } else {
                toast("提取失败：" + msg, false);
            }
        } finally {
            if (guard) { clearTimeout(guard); guard = null; }
            if (runId === extractEpoch) {
                const btn2 = q("#sdg-btn-extract"); if (btn2) btn2.disabled = false;
                processing = false;
            }
        }

        /* 生图在提取锁外面跑。之前它被圈在锁内到 finally 才解锁，下一楼的提取得干等
           这张图生完（几十秒）；而且生图失败会落进上面的 catch 去触发「提取重试」，
           白烧一次提取。两件事都在这儿一并解决。 */
        if (pendingGen) {
            try { await generateForFloor(pendingGen.idx, pendingGen.desc, undefined, pendingGen.layers); }
            catch (eGen) { /* generateForFloor 内部已经提示过了 */ }
        }
    }

    /* 给某楼的某个标记槽生图；slot 缺省 = 最后一个标记；正文没标记时 desc 必填，图挂在楼尾 */
    async function generateForFloor(idx, desc, slot, layers) {
        const msg = (ctx().chat || [])[idx];
        const tags = msg ? findAllTags(msg.mes) : [];
        if (typeof slot !== "number" || slot < 0) slot = tags.length ? tags.length - 1 : 0;
        desc = String(desc || "").trim();
        const explicitDesc = !!desc;
        const rec = msg ? injectRecord(msg) : null;
        if (!desc && tags[slot]) desc = tags[slot].inner;
        if (!desc && rec) desc = rec.desc;
        /* 一楼可有多个标记，旧版本也可能留下别条 swipe 的记录。
           只有描述或保存的标记与本槽相符时，才用记录里的分层填画风模板。 */
        const samePrompt = (a, b) => String(a || "").trim().replace(/\s+/g, " ") === String(b || "").trim().replace(/\s+/g, " ");
        /* 旧 XML 模板只保存 sdg_env，没有 sdg_tag；按当前模板重建后仍须完整匹配。 */
        const savedTag = (msg && msg.extra && msg.extra.sdg_tag) || (rec ? buildInjectTag(rec.desc, rec.layers) : "");
        const recordMatches = rec && (samePrompt(desc, rec.desc) || (!explicitDesc && tags[slot] && savedTag &&
            findAllTags(savedTag).some(function (tag) { return samePrompt(tag.full, tags[slot].full); })));
        if (!layers && recordMatches) layers = rec.layers;
        if (!desc) throw new Error("没有可用的生图描述");
        if (idx >= 0) currentIdx = idx;

        const key = idx + ":" + slot;
        if (genBusy[key]) { setStatus("这张正在生图中", C_WARN); return ""; }
        genBusy[key] = true;
        const swipeAtStart = msg ? swipeKey(msg) : null;
        if (msg) renderFloorImage(idx, { domRetry: 2 });
        setStatus("正在生图…", C_OK);
        const t0 = Date.now();
        try {
            const result = await generateImage(desc, layers);
            const image = result.image;
            let chatSaved = false;
            if (msg) {
                /* 这楼还在不在？删楼后索引会整体左移，msg 可能已经被移出 chat，
                   往孤儿对象上写再 saveChat 等于白存 */
                const alive = (ctx().chat || [])[idx] === msg || (ctx().chat || []).indexOf(msg) >= 0;
                if (!alive) {
                    setStatus("这楼已经没了，图没入库", C_WARN);
                    return image;
                }
                setImage(msg, slot, image, swipeAtStart);
                const movedSwipe = swipeAtStart && swipeKey(msg) !== swipeAtStart;
                const origin = movedSwipe ? swipeInfoSlot(msg, true, swipeAtStart) : null;
                const recordTarget = movedSwipe ? (origin ? { extra: origin.extra } : null) : msg;
                if (recordTarget && !injectRecord(recordTarget)) {
                    rememberInject(recordTarget, tags[slot] ? tags[slot].full : buildInjectTag(desc, layers), desc, layers || null);
                }
                if (movedSwipe) syncSwipeExtraFor(msg, swipeAtStart);
                else syncSwipeExtra(msg);
                chatSaved = await persistChat("生图入库");
                if (movedSwipe) setStatus("生图完成（期间切了回复，图在原来那条里）✓", C_WARN);
            }
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            if (result.saved === false) {
                setStatus(result.warning, C_WARN);
                toast("图片已生成，但尚未保存到酒馆；请点图片下方「重试保存」，不会重新生图", null);
            } else if (!chatSaved) {
                setStatus("图片已生成，但聊天记录未保存成功，刷新前请重试保存聊天", C_WARN);
            } else {
                const stored = String(image).startsWith("data:image/") ? "已保存聊天内嵌副本（文件上传未完成）" : "已保存到酒馆";
                setStatus("生图完成，" + stored + "，耗时 " + dur + " 秒 ✓", C_OK);
                toast("✅ " + stored, true);
            }
            return image;
        } catch (e) {
            console.error(LOG, e);
            const m = formatGenError(e);
            setStatus(m, C_ERR);
            toast(m, false);
            throw e;
        } finally {
            delete genBusy[key];
            if (msg) { try { renderFloorImage(idx, { domRetry: 2 }); installMesButtons(); } catch (e) {} }
        }
    }
    async function onGenSlot(idx, slot, force) {
        try {
            const msg = (ctx().chat || [])[idx]; if (!msg) return;
            if (!force && getImage(msg, slot)) return;
            await generateForFloor(idx, "", slot);
        } catch (e) { /* 已提示 */ }
    }

    /* —— 标记识别：模板的前缀/后缀 + 内置 image###…### + <draw>…</draw> —— */
    /* 标记正则：模型写法常有偏差，放宽两处，否则一偏就整楼认不出
         ① 井号数量不限且容忍全角（image##… / image####… / image＃＃＃…）
         ② 前缀里含后缀时（image### 含 ###），内层禁止再出现前缀——
            不然「image###甲 …漏了闭合… image###乙###」会被匹配成一个错标记并把乙吞掉 */
    const HASH = "[#＃]";
    function tagRegex(p, flags) {
        const mPre = /^([\s\S]*?)([#＃]{2,})$/.exec(p.pre);
        const mSuf = /^([#＃]{2,})$/.exec(p.suf);
        if (mPre && mSuf) {
            const head = escRe(mPre[1]);
            const open = head + HASH + "{2,}";
            /* 捕获开头那串井号，结尾用反向引用要求同一串：正文里出现 ## 或 ###
               （markdown 标题之类）就不会把标记提前截断。内层另外禁止再出现前缀，
               漏写闭合时不至于把后面那个完好的标记吞掉。 */
            return new RegExp(head + "(" + HASH + "{2,})((?:(?!" + open + ")[\\s\\S])*?)\\1", flags || "gi");
        }
        const pre = escRe(p.pre), suf = escRe(p.suf);
        const inner = p.pre.indexOf(p.suf) >= 0
            ? "((?:(?!" + pre + ")[\\s\\S])*?)"
            : "([\\s\\S]*?)";
        /* 空捕获组占位，让正文内容在两个分支里都落在 m[2] */
        return new RegExp(pre + "()" + inner + suf, flags || "gi");
    }

    let mpCache = null, mpCacheKey = "";
    function markerPairs() {
        const ck = getTemplateValue();
        if (mpCache && mpCacheKey === ck) return mpCache;
        const out = [], seen = {};
        const push = function (pre, suf) {
            pre = String(pre || ""); suf = String(suf || "");
            if (!pre.trim() || !suf.trim()) return;
            const k = pre + "|" + suf; if (seen[k]) return; seen[k] = true;
            out.push({ pre: pre, suf: suf });
        };
        const tpl = getTemplateValue();
        const single = tpl.indexOf("\n") < 0;
        if (single) {
            const phs = []; let m;
            TPL_PH_RE.lastIndex = 0;
            while ((m = TPL_PH_RE.exec(tpl)) !== null) phs.push({ i: m.index, e: m.index + m[0].length });
            TPL_PH_RE.lastIndex = 0;
            if (phs.length) push(tpl.slice(0, phs[0].i).trim(), tpl.slice(phs[phs.length - 1].e).trim());
        }
        push("image###", "###");
        push("<draw>", "</draw>");
        mpCache = out; mpCacheKey = ck;
        return out;
    }
    /* 便宜预检：正文里有没有可能出现标记。聊天观察器每次变动都要扫全部楼层，
       手机上流式期间每 250ms 一轮，全量正则太贵；先 indexOf 挡掉大多数楼层再走 findAllTags */
    function mayHaveMarkers(text) {
        const t = String(text || "");
        if (!t) return false;
        const pairs = markerPairs();
        for (let k = 0; k < pairs.length; k++) {
            if (t.indexOf(pairs[k].pre) >= 0 || t.indexOf(pairs[k].suf) >= 0) return true;
        }
        return false;
    }
    /* 楼层正文里所有标记，按出现顺序 → [{full, inner, pre, suf}] */
    function findAllTags(text) {
        const t = String(text || "");
        const found = [];
        markerPairs().forEach(function (p) {
            const re = tagRegex(p);
            let m;
            while ((m = re.exec(t)) !== null) {
                const inner = String(m[2] || "").trim();
                if (!inner) continue;
                found.push({ start: m.index, full: m[0], inner: inner, pre: p.pre, suf: p.suf });
            }
        });
        found.sort(function (a, b) { return a.start - b.start; });
        /* 去掉互相套着的重复命中（<draw>image###x###</draw> 这种） */
        const out = []; let lastEnd = -1;
        found.forEach(function (f) {
            if (f.start < lastEnd) return;
            out.push(f); lastEnd = f.start + f.full.length;
        });
        return out;
    }
    function findTagInText(text) {
        const all = findAllTags(text);
        return all.length ? all[all.length - 1].full : "";
    }
    function tagInner(tag) {
        const t = String(tag || "").trim();
        /* 先按宽松正则整串对一遍，井号写多写少都能剥干净；再退字面比较 */
        for (const p of markerPairs()) {
            try {
                const m = tagRegex(p, "i").exec(t);
                if (m && m.index === 0 && m[0].length === t.length) return String(m[2] || "").trim();
            } catch (e) {}
        }
        for (const p of markerPairs()) {
            if (t.startsWith(p.pre) && t.endsWith(p.suf)) return t.slice(p.pre.length, t.length - p.suf.length).trim();
        }
        return t.replace(/^\s*<[A-Za-z][\w-]*\s*>/, "").replace(/<\/[A-Za-z][\w-]*\s*>\s*$/, "")
                .replace(/^image[#＃]{2,}/i, "").replace(/[#＃]{2,}$/, "").trim();
    }

    function onMsgReceived(idx) {
        if (!cfg().enabled) return;
        try {
            const chat = ctx().chat || [];
            let i = Number(idx);
            let msg = (Number.isFinite(i) && i >= 0) ? chat[i] : null;
            if (msg && msg.is_user) return;
            if (!msg) {
                i = -1;
                for (let k = chat.length - 1; k >= 0; k--) {
                    const m = chat[k];
                    if (m && !m.is_user && m.is_system !== true && String(m.mes || "").trim()) { i = k; msg = m; break; }
                }
                if (i < 0 || !msg) return;
            }

            /* 主模型自己写了标记（它看历史楼层都以标记结尾，照猫画虎带了一个）。
               自动提取开着时按她要的流程走：剥掉模型自带的标记，回到「副AI提取 → 注入出框 → 生图」，
               不然重roll出来的新楼自己带着框、还跳过提取直接生图。
               自动提取关着、或剥不干净时保留老行为：模型写的标记直接逐个生图。 */
            const tags = findAllTags(msg.mes);
            if (tags.length) {
                const stripped = cfg().autoExtract ? stripImageTag(msg.mes) : msg.mes;
                if (cfg().autoExtract && String(stripped).trim() !== String(msg.mes).trim() && !findAllTags(stripped).length) {
                    msg.mes = String(stripped);
                    syncSwipe(msg);
                    persistChat("剥掉模型自己写的生图标记");
                    setStatus("已剥掉模型自带的生图标记，走正常提取流程", C_WARN);
                    rerenderFloor(i);
                } else {
                    currentIdx = i;
                    layersFresh = false;
                    setPreview(tags[tags.length - 1].inner);
                    /* 非流式时此刻楼层 DOM 可能还没建（酒馆先发事件后 addOneMessage），
                       带 domRetry 让标记立刻变成槽位，而不是等生图结束才出现 */
                    renderFloorImage(i, { domRetry: 3 });
                    if (!cfg().autoGenerate) { setStatus("检测到 " + tags.length + " 个生图标记（自动生图已关闭）", C_WARN); return; }
                    setStatus("检测到 " + tags.length + " 个生图标记，直接生图…", C_OK);
                    (async function () {
                        const target = floorTarget(i);
                        for (let s = 0; s < tags.length; s++) {
                            if (!floorTargetMatches(target)) {
                                setStatus("回复已切换或修改，已停止原回复剩余标记的自动生图", C_WARN);
                                break;
                            }
                            if (getImage(msg, s)) continue;
                            try { await generateForFloor(i, tags[s].inner, s); } catch (e) {}
                        }
                    })();
                    return;
                }
            }

            if (!cfg().autoExtract) { currentIdx = i; return; }

            pendingAutoIdx = i;
            currentIdx = i;
            if (autoTimer) clearTimeout(autoTimer);
            let delay = Number(cfg().autoDelay || 800);
            if (delay < 100) delay = 100;
            autoTimer = setTimeout(runPendingAutoExtract, delay);
            setStatus("已捕捉新正文，等待自动提取…", C_OK);
        } catch (e) { console.error(LOG, e); }
    }

    function runPendingAutoExtract() {
        if (pendingAutoIdx < 0) return;
        if (processing) { setTimeout(runPendingAutoExtract, 300); return; }
        try {
            const idx = pendingAutoIdx;
            pendingAutoIdx = -1;
            const msg = ctx().chat[idx];
            if (!msg || msg.is_user) return;
            currentIdx = idx;
            runExtract(msg.mes, "", { auto: true, targetIdx: idx });
        } catch (e) {
            setStatus("自动提取失败：" + e.message, C_ERR);
        }
    }

    function lastAiIdx() {
        const chat = ctx().chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] && !chat[i].is_user && chat[i].is_system !== true) return i;
        }
        return -1;
    }

    async function onExtract() {
        if (processing) return;
        try {
            const chat = ctx().chat;
            if (!chat || !chat.length) { setStatus("无法读取聊天", C_ERR); return; }
            const i = lastAiIdx();
            if (i < 0) { setStatus("未找到 AI 消息", C_ERR); return; }
            currentIdx = i;
            await runExtract(chat[i].mes, "", { auto: false, targetIdx: i });
        } catch (e) { setStatus("错误: " + e.message, C_ERR); }
    }
    /* 只重摇某一层：其余四层临时按锁定处理 */
    async function onRerollLayer(layer) {
        if (processing) return;
        if (!cfg().layered) { setStatus("先勾上「分层提取」", C_WARN); return; }
        try {
            let idx = currentIdx >= 0 ? currentIdx : lastAiIdx();
            if (idx < 0) { setStatus("未找到 AI 消息", C_ERR); return; }
            const msg = ctx().chat[idx];
            if (!msg) { setStatus("消息不存在", C_ERR); return; }
            const tmp = {};
            LAYERS.forEach(function (l) { tmp[l] = (l !== layer); });
            currentIdx = idx;
            setStatus("只重摇「" + LAYER_LABEL[layer] + "」…", C_OK);
            await runExtract(msg.mes, "", { auto: false, targetIdx: idx, locks: tmp });
        } catch (e) { setStatus("错误: " + e.message, C_ERR); }
    }
    function onInject() {
        if (currentIdx < 0) { setStatus("没有目标楼层，先提取一次", C_ERR); return; }
        try {
            const pv = q("#sdg-preview");
            const desc = (pv && pv.value) || currentDesc;
            const result = injectDescToMessage(desc, currentIdx, activeLayersForInject());
            if (result && result.injected) setStatus("已注入 ✓", C_OK);
            else setStatus("已存在相同注入，跳过", C_OK);
        } catch (e) { console.error(LOG, e); setStatus("注入失败: " + e.message, C_ERR); }
    }
    async function onGenerate() {
        const pv = q("#sdg-preview");
        const desc = (pv && pv.value) || currentDesc;
        try {
            let idx = currentIdx;
            if (idx < 0) idx = lastAiIdx();
            await generateForFloor(idx, desc, undefined, activeLayersForInject());
        } catch (e) { /* 已提示 */ }
    }
    async function onRegenFloor(idx) {
        try {
            const msg = (ctx().chat || [])[idx];
            if (!msg) return;
            const tags = findAllTags(msg.mes);
            if (!tags.length) { const rec = injectRecord(msg); await generateForFloor(idx, rec ? rec.desc : "", 0); return; }
            const target = floorTarget(idx);
            for (let s = 0; s < tags.length; s++) {
                if (!floorTargetMatches(target)) {
                    setStatus("回复已切换或修改，已停止原回复剩余图片的重画", C_WARN);
                    break;
                }
                try { await generateForFloor(idx, "", s); } catch (e) {}
            }
        } catch (e) { /* 已提示 */ }
    }
    function onStop() {
        try {
            let n = 0;
            if (imageBackupBusy) { imageBackupCancelled = true; n++; }
            /* 排队的自动提取 / 失败重试也一并取消，不然停了当前请求一会儿又自己跑起来 */
            if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
            pendingAutoIdx = -1;
            clearRetry();
            n += extAborts.size;
            extAborts.forEach(function (r) {
                r.userAborted = true;
                try { if (r.controller) r.controller.abort(); } catch (e) {}
            });
            extAborts.clear();
            n += genAborts.size;
            genAborts.forEach(function (r) { try { r.markUser(); } catch (e) {} });
            genAborts.clear();
            /* 之前不管有没有在跑都报「已打断」，并发时还会漏掉先发的那个 */
            setStatus(n ? "已打断当前请求" : "现在没有在跑的请求", n ? C_ERR : C_WARN);
        } catch (e) {}
    }

    /* ============================================================
       界面：悬浮球
       ============================================================ */
    function createBall() {
        let ball = q("#sdg-ball");
        if (ball) return ball;
        ball = document.createElement("div");
        ball.id = "sdg-ball";
        ball.title = "生图工坊";
        ball.textContent = "🎨";
        document.body.appendChild(ball);

        const c = cfg();
        if (c.ballLeft) ball.style.left = c.ballLeft;
        if (c.ballTop) ball.style.top = c.ballTop;
        applyBallVisible();

        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
        ball.addEventListener("pointerdown", function (ev) {
            dragging = true; moved = false;
            sx = ev.clientX; sy = ev.clientY;
            const r = ball.getBoundingClientRect();
            ox = r.left; oy = r.top;
            try { ball.setPointerCapture(ev.pointerId); } catch (e) {}
        });
        ball.addEventListener("pointermove", function (ev) {
            if (!dragging) return;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
            if (moved) {
                ball.style.left = Math.max(0, ox + dx) + "px";
                ball.style.top = Math.max(0, oy + dy) + "px";
            }
        });
        ball.addEventListener("pointerup", function () {
            dragging = false;
            if (moved) { save("ballLeft", ball.style.left); save("ballTop", ball.style.top); }
            else togglePanel();
        });
        return ball;
    }
    function applyBallVisible() {
        const ball = q("#sdg-ball");
        if (ball) ball.style.display = cfg().showBall === false ? "none" : "";
    }

    /* ============================================================
       界面：主题
       ============================================================ */
    function applyTheme() {
        const t = cfg().theme === "day" ? "day" : "night";
        const panel = q("#sdg-panel");
        if (panel) panel.setAttribute("data-theme", t);
        const ball = q("#sdg-ball");
        if (ball) ball.setAttribute("data-theme", t);
        const btn = q("#sdg-theme");
        if (btn) { btn.textContent = t === "day" ? "🌞" : "🌙"; btn.title = t === "day" ? "日版（点击切夜版）" : "夜版（点击切日版）"; }
        const sel = q("#sdgd-theme");
        if (sel && sel.value !== t) sel.value = t;
    }
    function toggleTheme() {
        save("theme", cfg().theme === "day" ? "night" : "day");
        applyTheme();
    }

    /* ============================================================
       界面：面板 HTML
       ============================================================ */
    function chk(id, key, label) {
        return '<label class="sdg-chk"><input type="checkbox" id="' + id + '"' + (cfg()[key] ? " checked" : "") + '><span>' + label + '</span></label>';
    }
    function field(label, inner) {
        return '<div class="sdg-field"><label>' + label + '</label>' + inner + '</div>';
    }
    function textInput(id, key, ph, type) {
        return '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(cfg()[key]) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + '>';
    }
    function textArea(id, key, rows, ph) {
        return '<textarea id="' + id + '" rows="' + (rows || 2) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + '>' + esc(cfg()[key]) + '</textarea>';
    }
    /* 带“放大编辑”的多行字段：不打开时就是原来的小文本框，点右下角对角图标在大面板里编辑 */
    const SDG_GRIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M9 20H4v-5"/><path d="M15 20h5v-5"/></svg>';
    function bigField(id, key, rows, ph, label) {
        return '<div class="sdg-field sdg-bigfield">' +
            '<label>' + label + '</label>' +
            '<div class="sdg-bigwrap">' +
                textArea(id, key, rows, ph) +
                '<button type="button" class="sdg-grip" data-target="' + id + '" data-title="' + esc(label) + '" title="在大面板里编辑" tabindex="-1">' + SDG_GRIP_SVG + '</button>' +
            '</div>' +
        '</div>';
    }
    function fireChange(el) {   /* 写回后触发原有 input/change 保存逻辑，兼容老内核 */
        ["input", "change"].forEach(function (nm) {
            let ev = null;
            try { ev = new Event(nm, { bubbles: true }); }
            catch (e) { try { ev = document.createEvent("HTMLEvents"); ev.initEvent(nm, true, false); } catch (e2) {} }
            if (ev) el.dispatchEvent(ev);
        });
    }
    function sdgViewport() {   /* 可视视口（排除手机状态栏/地址栏/键盘），拿不到再退回布局视口 */
        const vv = window.visualViewport;
        const vw = (vv && vv.width) || document.documentElement.clientWidth || window.innerWidth || 0;
        const vh = (vv && vv.height) || document.documentElement.clientHeight || window.innerHeight || 0;
        return { vw: vw, vh: vh, ot: (vv && vv.offsetTop) || 0, ol: (vv && vv.offsetLeft) || 0 };
    }
    /* 通用大编辑面板：把小 textarea 放到大面板里编辑，保存即回填并走原保存逻辑。
       遮罩与卡片都按可视视口像素定位，手机上稳定居中、不被状态栏/地址栏裁掉 */
    function openBigEditor(target, title) {
        if (!target) return;
        let mask = q("#sdg-editor");
        if (!mask) {
            mask = document.createElement("div");
            mask.id = "sdg-editor";
            mask.innerHTML =
                '<div class="sdg-editor-card">' +
                    '<div class="sdg-editor-head"><span class="sdg-editor-title"></span>' +
                        '<button type="button" class="sdg-editor-x" title="关闭（Esc）">✕</button></div>' +
                    '<textarea class="sdg-editor-ta" spellcheck="false"></textarea>' +
                    '<div class="sdg-editor-foot"><span class="sdg-editor-hint">Ctrl+Enter 保存 · Esc 取消</span>' +
                        '<span class="sdg-editor-btns">' +
                            '<button type="button" class="sdg-editor-cancel">取消</button>' +
                            '<button type="button" class="sdg-editor-save">保存</button>' +
                        '</span></div>' +
                '</div>';
            document.body.appendChild(mask);
            const ta = mask.querySelector(".sdg-editor-ta");
            const card = mask.querySelector(".sdg-editor-card");
            const close = function () { mask.style.display = "none"; };
            const save = function () {
                const tg = mask.__target;
                if (tg) { tg.value = ta.value; fireChange(tg); }
                close();
            };
            /* 按可视视口像素定位遮罩和卡片：居中且永远收在可视区内 */
            const place = function () {
                try {
                    const vp = sdgViewport();
                    if (!(vp.vw > 0) || !(vp.vh > 0)) return;
                    mask.style.position = "fixed";
                    mask.style.left = vp.ol + "px";
                    mask.style.top = vp.ot + "px";
                    mask.style.width = vp.vw + "px";
                    mask.style.height = vp.vh + "px";
                    mask.style.right = "auto";
                    mask.style.bottom = "auto";
                    card.style.width = Math.min(860, Math.floor(vp.vw * 0.94)) + "px";
                    card.style.height = Math.min(720, Math.floor(vp.vh * 0.88)) + "px";
                    card.style.maxWidth = "94%";
                    card.style.maxHeight = "94%";
                } catch (e) {}
            };
            mask.__place = place;
            mask.querySelector(".sdg-editor-x").addEventListener("click", close);
            mask.querySelector(".sdg-editor-cancel").addEventListener("click", close);
            mask.querySelector(".sdg-editor-save").addEventListener("click", save);
            mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
            ta.addEventListener("keydown", function (e) {
                if (e.key === "Escape") { e.preventDefault(); close(); }
                else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); }
            });
            try {
                if (window.visualViewport) {
                    window.visualViewport.addEventListener("resize", place);
                    window.visualViewport.addEventListener("scroll", place);
                }
                window.addEventListener("resize", place);
            } catch (e) {}
            mask.__ta = ta;
        }
        mask.__target = target;
        mask.querySelector(".sdg-editor-title").textContent = title || "编辑";
        const pnl = q("#sdg-panel");
        mask.setAttribute("data-theme", (pnl && pnl.getAttribute("data-theme")) || "night");
        mask.__ta.value = target.value != null ? target.value : "";
        mask.style.display = "flex";
        if (mask.__place) mask.__place();
        setTimeout(function () { try { if (mask.__place) mask.__place(); mask.__ta.focus(); } catch (e) {} }, 30);
    }
    function layerRowsHTML() {
        const locks = layerLocks();
        return LAYERS.map(function (l) {
            return '<div class="sdg-layer" data-layer="' + l + '">' +
                '<div class="sdg-layer-h">' +
                    '<span class="sdg-layer-name">' + LAYER_ICON[l] + ' ' + LAYER_LABEL[l] + '</span>' +
                    '<label class="sdg-lock" title="锁住：下次提取原样沿用"><input type="checkbox" class="sdg-lock-chk" data-layer="' + l + '"' + (locks[l] ? " checked" : "") + '><span>锁</span></label>' +
                    '<button type="button" class="sdg-reroll" data-layer="' + l + '" title="只重摇这一层">↻</button>' +
                '</div>' +
                '<textarea id="sdg-layer-' + l + '" class="sdg-layer-box" rows="2"></textarea>' +
            '</div>';
        }).join("");
    }

    /* 站点行：下拉 + 新建 / 改名 / 删除 */
    function siteRowHTML(kind) {
        const pre = kind === "gen" ? "sdg-gen" : "sdg-ext";
        return field("站点", '<div class="sdg-siterow">' +
            '<select id="' + pre + '-site"></select>' +
            '<button type="button" id="' + pre + '-site-add" class="sdg-minibtn" title="新建站点">＋</button>' +
            '<button type="button" id="' + pre + '-site-ren" class="sdg-minibtn" title="改名">✎</button>' +
            '<button type="button" id="' + pre + '-site-del" class="sdg-minibtn" title="删除">🗑</button>' +
        '</div>');
    }
    /* 模型行：下拉选（拉取后有列表）+ ✎ 切手动输入 */
    function modelRowHTML(kind) {
        const pre = kind === "gen" ? "sdg-gen" : "sdg-ext";
        return field("模型", '<div class="sdg-modelrow">' +
            '<select id="' + pre + '-model-sel"></select>' +
            '<button type="button" id="' + pre + '-model-edit" class="sdg-minibtn" title="手动输入">✎</button>' +
        '</div>' +
        '<input id="' + pre + '-model" type="text" class="sdg-model-input" placeholder="手动填模型名" value="' + esc(cfg()[kind === "gen" ? "genModel" : "extModel"]) + '">') +
        '<div class="sdg-btns"><button type="button" id="' + pre + '-fetch-models">拉取模型</button><button type="button" id="' + pre + '-test">' + (kind === "gen" ? "测试生图" : "测试连接") + '</button></div>';
    }

    function panelHTML() {
        const sysList = getSystemPrompts();
        const sysOpts = sysList.map(p => '<option value="' + esc(p.id) + '"' + (p.id === cfg().extActiveSystemPrompt ? " selected" : "") + '>' + esc(p.name) + '</option>').join("");
        return '' +
        '<div id="sdg-panel-head">' +
            '<span class="sdg-title">🎨 生图工坊 <small>v' + VERSION + '</small></span>' +
            '<span class="sdg-head-r">' +
                '<button type="button" id="sdg-theme" class="sdg-iconbtn">🌙</button>' +
                '<button type="button" id="sdg-panel-close" class="sdg-iconbtn">✕</button>' +
            '</span>' +
        '</div>' +
        '<div id="sdg-panel-body">' +

            /* 状态条常驻，切页签也看得见 */
            '<div id="sdg-status">就绪</div>' +

            /* —— 两个页签卡片：点哪个展开哪个 —— */
            '<div class="sdg-tabs">' +
                '<button type="button" class="sdg-tab" data-tab="gen">🎨 生图</button>' +
                '<button type="button" class="sdg-tab" data-tab="ext">📝 提取</button>' +
            '</div>' +
            '<div class="sdg-panes">' +

                /* ========== 生图页 ========== */
                '<section class="sdg-pane" id="sdg-pane-gen">' +
                    siteRowHTML("gen") +
                    field("API 地址", textInput("sdg-gen-endpoint", "genEndpoint", "https://api.xxx.com/v1")) +
                    field("API Key", textInput("sdg-gen-key", "genKey", "", "password")) +
                    modelRowHTML("gen") +
                    field("尺寸", textInput("sdg-grok-size", "grokSize", "1024x1024")) +
                    field("画质 quality", '<select id="sdg-gen-quality">' +
                        '<option value=""' + (!cfg().genQuality ? " selected" : "") + '>（不发送，站点默认）</option>' +
                        '<option value="low"' + (cfg().genQuality === "low" ? " selected" : "") + '>low</option>' +
                        '<option value="medium"' + (cfg().genQuality === "medium" ? " selected" : "") + '>medium</option>' +
                        '<option value="high"' + (cfg().genQuality === "high" ? " selected" : "") + '>high</option>' +
                        '<option value="xhigh"' + (cfg().genQuality === "xhigh" ? " selected" : "") + '>xhigh</option>' +
                        '<option value="max"' + (cfg().genQuality === "max" ? " selected" : "") + '>max</option>' +
                        '<option value="auto"' + (cfg().genQuality === "auto" ? " selected" : "") + '>auto（Grok）</option>' +
                    '</select><div class="sdg-hint">GPT 2.5 系：low/medium/high/xhigh/max；Grok：low/medium/auto；随站点档案保存</div>') +
                    field("脸部参考图", '<button type="button" id="sdg-face-pick" class="sdg-minibtn" style="width:100%;padding:8px 0;font-size:13px">📁 选择 / 更换参考图</button>' +
                        '<input type="file" id="sdg-face-file" accept="image/*" style="position:absolute;left:-9999px;width:1px;height:1px">' +
                        '<img id="sdg-face-thumb" alt=""' + (cfg().faceRef ? ' src="' + cfg().faceRef + '" style="display:block !important;height:110px !important;width:auto !important;max-width:100% !important;margin:5px 0 0 0 !important;border-radius:6px !important"' : ' style="display:none !important"') + '>' +
                        '<button type="button" id="sdg-face-clear" class="sdg-minibtn" style="margin-top:5px' + (cfg().faceRef ? "" : ";display:none") + '">🗑 清除参考图</button>' +
                        '<div class="sdg-hint" id="sdg-face-note">' + (cfg().faceRef ? '已存参考图 ✓ 勾选下方「锁脸」后生效' : '未设置（可选）：点上面按钮选一张正脸清晰的图') + '</div>') +
                    chk("sdg-face-on", "faceRefOn", "锁脸：生成时附上参考图保持面部一致") +
                    field("锁脸发送方式", '<select id="sdg-face-mode">' +
                        '<option value="chat"' + (cfg().faceRefMode !== "edits" ? " selected" : "") + '>聊天多模态（默认，Gemini / GPT 系）</option>' +
                        '<option value="edits"' + (cfg().faceRefMode === "edits" ? " selected" : "") + '>编辑接口（/images/edits，Grok 编辑模型等）</option>' +
                    '</select>') +
                    chk("sdg-gen-proxy", "genProxy", "Gemini 走酒馆后端代理") +
                    chk("sdg-jpeg", "convertToJpeg", "入库前转 JPEG") +

                    '<h5>自动化</h5>' +
                    chk("sdg-auto-extract", "autoExtract", "收到回复后自动提取") +
                    chk("sdg-auto-inject", "autoInject", "提取后自动注入") +
                    chk("sdg-auto-generate", "autoGenerate", "注入后自动生图") +
                    chk("sdg-hide-tag", "hideTagText", "楼层里收起提示词文字") +
                    chk("sdg-show-img", "showImage", "楼层内显示图片") +
                    '<div class="sdg-grid2">' +
                        field("延迟（毫秒）", textInput("sdg-delay", "autoDelay", "", "number")) +
                        field("图片宽度（%）", textInput("sdg-imgw", "imageMaxWidth", "", "number")) +
                        field("生图超时（秒）", textInput("sdg-gen-timeout", "genTimeout", "300", "number")) +
                        field("存图天数", textInput("sdg-keepdays", "imageKeepDays", "0", "number")) +
                    '</div>' +
                    '<div class="sdg-hint">生图超时或点「停止」不会补发。存图天数：0 = 长期保留；正数会删除超期的本地图片文件。已有设置继续生效。</div>' +
                    '<h5>图片保存</h5>' +
                    '<div class="sdg-storage-actions"><button type="button" id="sdg-backup-images" class="sdg-minibtn">补存当前聊天旧图</button><button type="button" id="sdg-keep-forever" class="sdg-minibtn">设为长期保留</button></div>' +
                    '<div class="sdg-hint">新图自动下载并保存到酒馆。补存会处理本聊天全部回复的旧外链与内嵌图片，不会重新生图；已失效的外链需要原站点或备份恢复。</div>' +

                    '<h5>插件</h5>' +
                    chk("sdg-enabled", "enabled", "启用生图工坊") +
                    chk("sdg-show-ball", "showBall", "显示悬浮球") +
                '</section>' +

                /* ========== 提取页（工作区在这里） ========== */
                '<section class="sdg-pane" id="sdg-pane-ext">' +
                    '<div class="sdg-work">' +
                        '<textarea id="sdg-preview" placeholder="提取出的生图描述（可手改后注入 / 生图）"></textarea>' +
                        '<div class="sdg-btns sdg-main-btns">' +
                            '<button type="button" id="sdg-btn-extract" class="sdg-primary">提取</button>' +
                            '<button type="button" id="sdg-btn-inject">注入</button>' +
                            '<button type="button" id="sdg-btn-generate" class="sdg-primary">生图</button>' +
                            '<button type="button" id="sdg-btn-stop" class="sdg-danger">停止</button>' +
                        '</div>' +
                        '<label class="sdg-chk sdg-layered-bar" id="sdg-layered-bar"><span class="sdg-layered-txt">分层提取</span><input type="checkbox" id="sdg-layered"' + (cfg().layered ? " checked" : "") + '></label>' +
                        '<div id="sdg-layers"' + (cfg().layered ? "" : ' style="display:none"') + '>' +
                            '<div class="sdg-hint">锁住的层下次不重提；环境 / 氛围 / 服装没变化时自动沿用上一楼；↻ 只重摇这一层</div>' +
                            layerRowsHTML() +
                        '</div>' +
                    '</div>' +

                    /* —— 画风：跟提取规则分开的独立分区，可存多个 —— */
                    '<h5>🎨 画风（管生图风格）</h5>' +
                    presetRowHTML("style", "画风预设",
                        '<button type="button" id="sdg-style-import" class="sdg-minibtn" title="导入 JSON（画风包 / 预设包）">⬆</button>' +
                        '<button type="button" id="sdg-style-export" class="sdg-minibtn" title="导出画风 JSON">⬇</button>' +
                        '<input type="file" id="sdg-style-file" accept=".json,application/json" style="position:absolute;left:-9999px;width:1px;height:1px">') +
                    bigField("sdg-gen-fixed", "genFixedPrompt", 3, "例：Korean semi-realistic anime, ultra-detailed digital painting…", "风格词（拼在描述前）") +
                    bigField("sdg-gen-postfix", "genPostfixPrompt", 2, "例：masterpiece, best quality", "后缀词（拼在描述后）") +
                    '<div class="sdg-hint">画风只影响出图风格，不会发给副AI；跟下面的「提取规则」是两回事。预设行 ⬆ 导入 JSON（画风包 / 预设包）、⬇ 导出画风 JSON，可备份或分享画风（导出只含画风，不含 API 与密钥）</div>' +

                    '<h5>📝 提取规则（管副AI怎么写描述）</h5>' +
                    siteRowHTML("ext") +
                    field("API 地址", textInput("sdg-ext-endpoint", "extEndpoint", "https://api.xxx.com/v1")) +
                    field("API Key", textInput("sdg-ext-key", "extKey", "", "password")) +
                    modelRowHTML("ext") +
                    field("系统提示", '<select id="sdg-sys-select">' + sysOpts + '</select>') +
                    '<textarea id="sdg-sys-value" rows="4"></textarea>' +
                    '<div class="sdg-btns"><button type="button" id="sdg-sys-save">保存系统提示</button></div>' +
                    presetRowHTML("rules", "提取规则预设") +
                    bigField("sdg-rules", "extRules", 3, "给副AI的额外要求，例：只写可见画面、不要心理活动、镜头别太远……", "提取规则") +
                    presetRowHTML("anchors", "角色锚点预设") +
                    field("角色锚点", textArea("sdg-anchors", "extAnchors", 3, "角色名：外貌描述……")) +
                    field("注入模板", textArea("sdg-template", "template", 2, DEFAULT_TEMPLATE)) +
                    '<div class="sdg-hint">默认 image###{Description}###　分层可用 {Camera} {Env} {Mood} {Chars} {Outfit} {Pose}</div>' +
                    chk("sdg-ext-proxy", "extProxy", "走酒馆后端代理") +
                    chk("sdg-retry", "retryOnce", "自动提取失败 10 秒后重试一次") +
                    field("超时（秒，0 = 不限）", textInput("sdg-timeout", "requestTimeout", "0", "number")) +
                '</section>' +
            '</div>' +
        '</div>';
    }

    function createPanel() {
        let panel = q("#sdg-panel");
        if (panel) return panel;
        panel = document.createElement("div");
        panel.id = "sdg-panel";
        panel.innerHTML = panelHTML();
        document.body.appendChild(panel);

        const c = cfg();
        if (c.panelLeft) panel.style.left = c.panelLeft;
        if (c.panelTop) panel.style.top = c.panelTop;

        /* 面板拖动 */
        const head = q("#sdg-panel-head");
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        head.addEventListener("pointerdown", function (ev) {
            if (ev.target.closest && ev.target.closest("button")) return;
            dragging = true; sx = ev.clientX; sy = ev.clientY;
            const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
            try { head.setPointerCapture(ev.pointerId); } catch (e) {}
        });
        head.addEventListener("pointermove", function (ev) {
            if (!dragging) return;
            panel.style.left = Math.max(0, ox + ev.clientX - sx) + "px";
            panel.style.top = Math.max(0, oy + ev.clientY - sy) + "px";
        });
        head.addEventListener("pointerup", function () {
            if (!dragging) return;
            dragging = false;
            save("panelLeft", panel.style.left);
            save("panelTop", panel.style.top);
        });
        q("#sdg-panel-close").addEventListener("click", function () { showPanel(false); });
        q("#sdg-theme").addEventListener("click", toggleTheme);
        qa(".sdg-grip").forEach(function (b) {
            b.addEventListener("click", function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                const t = q("#" + b.getAttribute("data-target"));
                if (t) openBigEditor(t, b.getAttribute("data-title"));
            });
        });

        /* 页签 */
        qa(".sdg-tab").forEach(function (b) {
            b.addEventListener("click", function () { setTab(b.getAttribute("data-tab")); });
        });
        setTab(cfg().tab === "ext" ? "ext" : "gen");

        /* 主按钮 */
        q("#sdg-btn-extract").addEventListener("click", onExtract);
        q("#sdg-btn-inject").addEventListener("click", onInject);
        q("#sdg-btn-generate").addEventListener("click", onGenerate);
        q("#sdg-btn-stop").addEventListener("click", onStop);

        /* 分层工作区 */
        q("#sdg-layered").addEventListener("change", function (ev) {
            save("layered", ev.target.checked);
            const box = q("#sdg-layers"); if (box) box.style.display = ev.target.checked ? "" : "none";
            const bar = q("#sdg-layered-bar"); if (bar) bar.classList.toggle("sdg-on", !!ev.target.checked);
        });
        const sdgLBar = q("#sdg-layered-bar"); if (sdgLBar) sdgLBar.classList.toggle("sdg-on", !!cfg().layered);
        qa(".sdg-lock-chk").forEach(function (el) {
            el.addEventListener("change", function () {
                const lk = Object.assign({}, layerLocks());
                lk[el.getAttribute("data-layer")] = el.checked;
                save("layerLocks", lk);
            });
        });
        qa(".sdg-reroll").forEach(function (el) {
            el.addEventListener("click", function () { onRerollLayer(el.getAttribute("data-layer")); });
        });
        qa(".sdg-layer-box").forEach(function (el) {
            el.addEventListener("input", function () {
                layersFresh = true;
                setPreview(joinLayers(layerBoxValues()));
            });
        });

        const bindText = function (id, key) {
            const el = q(id); if (!el) return;
            el.addEventListener("change", function () { save(key, el.value); });
        };
        const bindChk = function (id, key, after) {
            const el = q(id); if (!el) return;
            el.addEventListener("change", function (ev) { save(key, ev.target.checked); if (after) after(ev.target.checked); });
        };

        /* 生图设置 */
        bindSite("gen");
        bindChk("#sdg-gen-proxy", "genProxy");
        bindChk("#sdg-jpeg", "convertToJpeg");
        bindChk("#sdg-face-on", "faceRefOn");
        const faceMode = q("#sdg-face-mode");
        if (faceMode) faceMode.addEventListener("change", function () { save("faceRefMode", faceMode.value); });
        const faceFile = q("#sdg-face-file");
        const facePick = q("#sdg-face-pick");
        if (facePick && faceFile) facePick.addEventListener("click", function () { faceFile.click(); });
        if (faceFile) faceFile.addEventListener("change", function () {
            const f = faceFile.files && faceFile.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = function () {
                const img = new Image();
                img.onload = function () {
                    const maxDim = 768;
                    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                    const cv = document.createElement("canvas");
                    cv.width = Math.round(img.width * scale);
                    cv.height = Math.round(img.height * scale);
                    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
                    const dataUrl = cv.toDataURL("image/jpeg", 0.85);
                    save("faceRef", dataUrl);
                    const th = q("#sdg-face-thumb"); if (th) { th.src = dataUrl; th.style.setProperty("display", "block", "important"); }
                    const fc = q("#sdg-face-clear"); if (fc) fc.style.display = "";
                    const note = q("#sdg-face-note"); if (note) note.textContent = "已存参考图 ✓（" + cv.width + "×" + cv.height + "）勾选下方「锁脸」后生效";
                };
                img.onerror = function () { setStatus("参考图读取失败", C_ERR); };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(f);
        });
        const faceClear = q("#sdg-face-clear");
        if (faceClear) faceClear.addEventListener("click", function () {
            save("faceRef", "");
            if (faceFile) faceFile.value = "";
            const th = q("#sdg-face-thumb"); if (th) { th.removeAttribute("src"); th.style.setProperty("display", "none", "important"); }
            faceClear.style.display = "none";
            const note = q("#sdg-face-note"); if (note) note.textContent = "未设置（可选）：点上面按钮选一张正脸清晰的图";
        });

        /* 自动化 */
        bindChk("#sdg-auto-extract", "autoExtract");
        bindChk("#sdg-auto-inject", "autoInject");
        bindChk("#sdg-auto-generate", "autoGenerate");
        bindChk("#sdg-hide-tag", "hideTagText", function () { renderAllImages(); });
        bindChk("#sdg-show-img", "showImage", function (v) { document.body.classList.toggle("sdg-hide-images", !v); });
        /* 清空或填 0 时别退回老默认（延迟曾会退成 1800、图片宽度退成 60），
           归一化后的值写回框里，让她看见真正生效的是多少 */
        const numField = function (sel, key, dflt, min, max, after) {
            const el = q(sel); if (!el) return;
            el.addEventListener("change", function (ev) {
                const raw = Number(ev.target.value);
                let v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
                if (typeof min === "number") v = Math.max(min, v);
                if (typeof max === "number") v = Math.min(max, v);
                save(key, v);
                if (String(v) !== String(ev.target.value)) ev.target.value = v;
                if (after) after();
            });
        };
        numField("#sdg-delay", "autoDelay", 800, 100, null, null);
        numField("#sdg-imgw", "imageMaxWidth", 100, 10, 100, applyImageWidth);
        /* 这格允许 0（= 不清理），跟超时那格一样不走「0 退回默认」 */
        q("#sdg-keepdays").addEventListener("change", function (ev) {
            const raw = Number(ev.target.value);
            const v = Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.round(raw)) : 0;
            save("imageKeepDays", v);
            if (String(v) !== String(ev.target.value)) ev.target.value = v;
        });
        q("#sdg-backup-images").addEventListener("click", function () { backupChatImages(); });
        q("#sdg-keep-forever").addEventListener("click", function () {
            save("imageKeepDays", 0);
            q("#sdg-keepdays").value = "0";
            setStatus("本地图片已设为长期保留，不再按天自动删除", C_OK);
        });
        numField("#sdg-gen-timeout", "genTimeout", 300, 30, null, null);
        bindChk("#sdg-enabled", "enabled", function () { syncDrawer(); });
        bindChk("#sdg-show-ball", "showBall", function () { applyBallVisible(); syncDrawer(); });

        /* 画风 / 提取规则 / 角色锚点 预设 */
        bindPresets();

        /* 提取设置 */
        bindSite("ext");
        bindText("#sdg-template", "template");
        bindChk("#sdg-ext-proxy", "extProxy");
        bindChk("#sdg-retry", "retryOnce");
        /* 这格允许 0（= 不限），所以不走 numField 的「0 退回默认」那套 */
        q("#sdg-timeout").addEventListener("change", function (ev) {
            const raw = Number(ev.target.value);
            const v = Number.isFinite(raw) && raw > 0 ? Math.max(10, raw) : 0;
            save("requestTimeout", v);
            if (String(v) !== String(ev.target.value)) ev.target.value = v;
        });

        const sysSel = q("#sdg-sys-select");
        const sysVal = q("#sdg-sys-value");
        const fillSysVal = function () {
            const p = getSystemPrompts().find(x => x.id === sysSel.value);
            sysVal.value = p ? p.value : "";
        };
        sysSel.addEventListener("change", function () { save("extActiveSystemPrompt", sysSel.value); fillSysVal(); });
        fillSysVal();
        q("#sdg-sys-save").addEventListener("click", function () {
            const list = getSystemPrompts();
            for (const p of list) if (p.id === sysSel.value) p.value = sysVal.value;
            saveCritical("extSystemPromptsJson", JSON.stringify(list));
            setStatus("系统提示已保存 ✓", C_OK);
        });

        applyTheme();
        return panel;
    }

    function setTab(t) {
        t = t === "ext" ? "ext" : "gen";
        qa(".sdg-tab").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === t); });
        qa(".sdg-pane").forEach(function (p) { p.classList.toggle("on", p.id === "sdg-pane-" + t); });
        if (cfg().tab !== t) save("tab", t);
    }

    function applyImageWidth() {
        const w = Number(cfg().imageMaxWidth) || 60;
        let st = q("#sdg-imgw-style");
        if (!st) {
            st = document.createElement("style");
            st.id = "sdg-imgw-style";
            document.head.appendChild(st);
        }
        st.textContent = ".sdg-slot,.sdg-img.sdg-orphan{max-width:" + w + "% !important;}";
    }

    /* ============================================================
       站点 / 模型 UI
       ============================================================ */
    function bindSite(kind) {
        const pre = kind === "gen" ? "#sdg-gen" : "#sdg-ext";
        const on = function (sel, ev, fn) { const el = q(sel); if (el) el.addEventListener(ev, fn); };

        on(pre + "-site", "change", function (e) { switchProfile(kind, e.target.value); });
        on(pre + "-site-add", "click", function () { addProfile(kind); });
        on(pre + "-site-ren", "click", function () { renameProfile(kind); });
        on(pre + "-site-del", "click", function () { delProfile(kind); });

        on(pre + "-endpoint", "change", function (e) { saveProfileField(kind, "endpoint", e.target.value); });
        on(pre + "-key", "change", function (e) { saveProfileField(kind, "key", e.target.value); });
        if (kind === "gen") {
            on("#sdg-grok-size", "change", function (e) { saveProfileField("gen", "size", e.target.value); });
            on("#sdg-gen-quality", "change", function (e) { saveProfileField("gen", "quality", e.target.value); });
        }

        /* 模型：下拉选中就存；✎ 切换手动输入框 */
        on(pre + "-model-sel", "change", function (e) {
            const v = e.target.value;
            if (v === "__manual__") { showModelInput(kind, true); return; }
            saveProfileField(kind, "model", v);
            const inp = q(pre + "-model"); if (inp) inp.value = v;
            setStatus("模型：" + v, C_OK);
        });
        on(pre + "-model", "change", function (e) {
            saveProfileField(kind, "model", e.target.value);
            renderModelSelect(kind);
        });
        on(pre + "-model-edit", "click", function () {
            const inp = q(pre + "-model");
            showModelInput(kind, !(inp && inp.classList.contains("on")));
        });
        on(pre + "-fetch-models", "click", function () { fetchModels(kind); });
        on(pre + "-test", "click", function () { kind === "gen" ? testGenConnection() : testExtConnection(); });

        refreshSiteUI(kind);
    }
    function showModelInput(kind, v) {
        const inp = q((kind === "gen" ? "#sdg-gen" : "#sdg-ext") + "-model");
        if (inp) { inp.classList.toggle("on", !!v); if (v) inp.focus(); }
    }
    /* 站点下拉 + 该站点的地址/Key/模型 一起刷新到界面 */
    function refreshSiteUI(kind) {
        const pre = kind === "gen" ? "#sdg-gen" : "#sdg-ext";
        const list = getProfiles(kind), cur = activeProfile(kind);
        const sel = q(pre + "-site");
        if (sel) {
            sel.innerHTML = list.map(function (p) {
                return '<option value="' + esc(p.id) + '"' + (p.id === cur.id ? " selected" : "") + '>' + esc(p.name || "未命名") + '</option>';
            }).join("");
        }
        const c = cfg();
        const ep = q(pre + "-endpoint"); if (ep) ep.value = c[kind === "gen" ? "genEndpoint" : "extEndpoint"] || "";
        const kk = q(pre + "-key"); if (kk) kk.value = c[kind === "gen" ? "genKey" : "extKey"] || "";
        const mi = q(pre + "-model"); if (mi) mi.value = c[kind === "gen" ? "genModel" : "extModel"] || "";
        if (kind === "gen") {
            const sz = q("#sdg-grok-size"); if (sz) sz.value = c.grokSize || "1024x1024";
            const ql = q("#sdg-gen-quality"); if (ql) ql.value = c.genQuality || "";
        }
        renderModelSelect(kind);
    }
    function renderModelSelect(kind) {
        const sel = q((kind === "gen" ? "#sdg-gen" : "#sdg-ext") + "-model-sel");
        if (!sel) return;
        const cur = String(cfg()[kind === "gen" ? "genModel" : "extModel"] || "");
        const models = (activeProfile(kind).models || []).slice();
        if (cur && models.indexOf(cur) < 0) models.unshift(cur);
        let html = "";
        if (!models.length) html += '<option value="">（点「拉取模型」或 ✎ 手填）</option>';
        html += models.map(function (m) {
            return '<option value="' + esc(m) + '"' + (m === cur ? " selected" : "") + '>' + esc(m) + '</option>';
        }).join("");
        html += '<option value="__manual__">✎ 手动输入…</option>';
        sel.innerHTML = html;
        if (cur) sel.value = cur;
    }
    async function fetchModels(kind) {
        const c = cfg();
        const endpoint = kind === "gen" ? c.genEndpoint : c.extEndpoint;
        const key = kind === "gen" ? c.genKey : c.extKey;
        if (!endpoint) { setStatus("请先填写 API 地址", C_ERR); return; }
        setStatus("正在拉取模型…", C_OK);
        try {
            const url = normalizeApiBase(endpoint) + "/models";
            const headers = {};
            if (key) headers["Authorization"] = "Bearer " + key;
            const res = await fetchWithTimeout(url, { method: "GET", headers }, Number(c.requestTimeout || 0) * 1000);
            const raw = await res.text();
            if (!res.ok) throw new Error("HTTP " + res.status + "：" + raw.slice(0, 180));
            const data = safeJson(raw, null);
            if (!data) throw new Error("返回不是 JSON");
            const models = extractModelsFromResponse(data);
            if (!models.length) throw new Error("没有识别到模型列表");
            setProfileModels(kind, models);
            const curKey = kind === "gen" ? "genModel" : "extModel";
            if (!c[curKey]) saveProfileField(kind, "model", models[0]);
            refreshSiteUI(kind);
            setStatus("已加载 " + models.length + " 个模型，下拉里选", C_OK);
        } catch (e) {
            setStatus("拉取模型失败：" + e.message, C_ERR);
        }
    }
    function extractModelsFromResponse(data) {
        const models = [];
        const push = function (m) {
            if (!m) return;
            if (typeof m === "string") { models.push(m); return; }
            if (m.id) models.push(m.id); else if (m.name) models.push(m.name); else if (m.model) models.push(m.model);
        };
        if (data && Array.isArray(data.data)) data.data.forEach(push);
        if (!models.length && data && Array.isArray(data.models)) data.models.forEach(push);
        if (!models.length && Array.isArray(data)) data.forEach(push);
        const clean = [];
        models.forEach(function (id) { id = String(id || "").trim(); if (id && clean.indexOf(id) < 0) clean.push(id); });
        return clean;
    }
    async function testExtConnection() {
        const c = cfg();
        if (!c.extEndpoint) { setStatus("请先填写 API 地址", C_ERR); return; }
        setStatus("正在测试连接…", C_OK);
        try {
            const res = await fetchWithTimeout(buildChatUrl(c.extEndpoint), {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, c.extKey ? { "Authorization": "Bearer " + c.extKey } : {}),
                body: JSON.stringify({ model: c.extModel || "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }], max_tokens: 5, stream: false })
            }, Number(c.requestTimeout || 0) * 1000);
            if (!res.ok) throw new Error("HTTP " + res.status);
            setStatus("连接成功 ✓", C_OK);
        } catch (e) {
            setStatus("连接失败：" + e.message, C_ERR);
        }
    }
    async function testGenConnection() {
        const c = cfg();
        try {
            if (!c.genEndpoint) throw new Error("请先填写生图 API 地址");
            setStatus("测试生图（会真实生成一张图）…", C_OK);
            await generateImage("a simple red apple on a white table");
            setStatus("生图连接成功 ✓（已成功生成一张测试图）", C_OK);
        } catch (e) {
            setStatus("生图连接失败：" + formatGenError(e), C_ERR);
        }
    }

    function showPanel(v) {
        const panel = q("#sdg-panel");
        if (!panel) return;
        panelVisible = !!v;
        panel.classList.toggle("show", panelVisible);
    }
    function togglePanel() { showPanel(!panelVisible); }

    /* ============================================================
       界面：酒馆扩展抽屉入口
       ============================================================ */
    function drawerHTML() {
        const c = cfg();
        return '' +
        '<div id="sdgd-root" class="extension_settings">' +
            '<div class="inline-drawer">' +
                '<div class="inline-drawer-toggle inline-drawer-header">' +
                    '<b>🎨 生图工坊 DrawGen</b>' +
                    '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
                '</div>' +
                '<div class="inline-drawer-content">' +
                    '<div class="sdgd-row">' +
                        '<select id="sdgd-theme">' +
                            '<option value="night"' + (c.theme !== "day" ? " selected" : "") + '>🌙 夜版</option>' +
                            '<option value="day"' + (c.theme === "day" ? " selected" : "") + '>🌞 日版</option>' +
                        '</select>' +
                    '</div>' +
                    '<small class="sdgd-note">v' + VERSION + ' · 点标题栏打开面板</small>' +
                '</div>' +
            '</div>' +
        '</div>';
    }
    function installDrawer(retry) {
        if (q("#sdgd-root")) return;
        const host = q("#extensions_settings2") || q("#extensions_settings");
        if (!host) {
            if ((retry || 0) < 60) setTimeout(function () { installDrawer((retry || 0) + 1); }, 1000);
            return;
        }
        host.insertAdjacentHTML("beforeend", drawerHTML());
        /* 点插件名标题栏直接弹出面板 */
        const dHead = q("#sdgd-root .inline-drawer-toggle");
        if (dHead) dHead.addEventListener("click", function () { showPanel(true); });
        q("#sdgd-theme").addEventListener("change", function (ev) { save("theme", ev.target.value); applyTheme(); });
    }
    function syncDrawer() {
        const a = q("#sdgd-enabled"); if (a) a.checked = !!cfg().enabled;
        const b = q("#sdgd-ball"); if (b) b.checked = cfg().showBall !== false;
    }

    /* ============================================================
       初始化
       ============================================================ */
    function bindEvents() {
        const c = ctx();
        if (c.eventSource && c.event_types) {
            c.eventSource.on(c.event_types.MESSAGE_RECEIVED, onMsgReceived);
            /* 酒馆在楼层 DOM 建好之后才发这个事件（非流式时 MESSAGE_RECEIVED 更早）：
               在这里补一次渲染，主模型自己写的标记能立刻变成槽位显示 */
            if (c.event_types.CHARACTER_MESSAGE_RENDERED) {
                c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, function (i) {
                    setTimeout(function () {
                        try {
                            const n = Number(i);
                            if (Number.isFinite(n)) renderFloorImage(n);
                            installMesButtons();
                        } catch (e) {}
                    }, 60);
                });
            }
            ["MESSAGE_SWIPED", "MESSAGE_UPDATED", "MESSAGE_EDITED"].forEach(function (evName) {
                if (c.event_types[evName]) {
                    c.eventSource.on(c.event_types[evName], function (i) {
                        /* 酒馆切 swipe 时会用 swipe_info[swipe_id].extra 覆盖 msg.extra，
                           先把我们的注入记录和图库补回来，再重绘，否则图会"消失" */
                        try {
                            const n0 = Number(i);
                            const m0 = Number.isFinite(n0) ? (ctx().chat || [])[n0] : null;
                            if (m0 && restoreSwipeExtra(m0)) persistChat("swipe 恢复");
                        } catch (e) {}
                        /* 她刚把这楼的标记删掉（上一次重绘时还在）→ 图跟着清。
                           编辑器打开时正文是临时态；先不清，保存后收到最终事件再判断。 */
                        if (evName !== "MESSAGE_SWIPED") {
                            try {
                                const n1 = Number(i);
                                const m1 = Number.isFinite(n1) ? (ctx().chat || [])[n1] : null;
                                const floor = Number.isFinite(n1) ? q('#chat .mes[mesid="' + n1 + '"]') : null;
                                if (m1 && !(floor && floor.querySelector(".edit_textarea"))) dropIfMarkersGone(n1, m1);
                            } catch (e) {}
                        }
                        setTimeout(function () {
                            try {
                                const n = Number(i);
                                if (Number.isFinite(n)) {
                                    renderFloorImage(n);
                                } else renderAllImages();
                                installMesButtons();
                            } catch (e) {}
                        }, 120);
                    });
                }
            });
            if (c.event_types.CHAT_CHANGED) {
                c.eventSource.on(c.event_types.CHAT_CHANGED, function () {
                    currentIdx = -1; layersFresh = false;
                    /* 排队的自动提取/重试指向旧聊天的楼层号，换了聊天必须作废 */
                    pendingAutoIdx = -1;
                    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
                    clearRetry();
                    /* 折叠状态按「楼号:槽位」记，tagsSeen 按楼号记 swipe——跨聊天都会串楼层，
                       tagsSeen 串了会让清图逻辑把新聊天同楼号的图当成「她删了标记」误清掉 */
                    for (const k in collapsed) delete collapsed[k];
                    for (const k in tagsSeen) delete tagsSeen[k];
                    /* 分层框还是旧聊天的内容，不清会把旧场景沿用到新聊天 */
                    setLayerBoxes({});
                    setTimeout(function () { renderAllImages(); installMesButtons(); }, 300);
                    setTimeout(function () { cleanupOldImages(false); }, 4000);
                });
            }
            if (c.event_types.APP_READY) {
                c.eventSource.on(c.event_types.APP_READY, function () {
                    setTimeout(function () { renderAllImages(); installMesButtons(); }, 500);
                    setTimeout(function () { cleanupOldImages(false); }, 8000);
                });
            }
        }
    }

    function init() {
        if (initialized) return;
        try {
            loadSettings();
            createBall();
            createPanel();
            installDrawer(0);
            applyImageWidth();
            applyTheme();
            if (cfg().showImage === false) document.body.classList.add("sdg-hide-images");
            bindEvents();
            installMesButtonsObserver();
            /* 视口变大（转屏等）时把限高上限往上抬，已渲染的图同步放大；
               只增不减——键盘弹出让视口变小不跟缩（点的就是图片不能缩） */
            window.addEventListener("resize", function () {
                try {
                    if (!SDG_CAP_H) return;
                    const before = SDG_CAP_H;
                    maxImgH();
                    if (SDG_CAP_H > before) qa("img.sdg-img.sdg-orphan").forEach(function (im) { im.style.maxHeight = SDG_CAP_H + "px"; });
                } catch (e) {}
            }, { passive: true });
            setTimeout(function () { renderAllImages(); installMesButtons(); }, 800);
            initialized = true;
            log("✓ 已加载 v" + VERSION);
        } catch (e) {
            console.error(LOG, "初始化失败:", e);
        }
    }
    function waitAndInit() {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) {
            setTimeout(waitAndInit, 300); return;
        }
        try {
            const c = SillyTavern.getContext();
            if (c.eventSource && c.event_types && c.event_types.APP_READY) {
                c.eventSource.on(c.event_types.APP_READY, function () { setTimeout(init, 100); });
                setTimeout(init, 4000);   // APP_READY 已经发过了就靠这个兜底
            } else {
                setTimeout(init, 500);
            }
        } catch (e) { setTimeout(init, 2000); }
    }
    waitAndInit();

    if (typeof window !== "undefined") {
        window.__sdgDebug = {
            buildInjectTag, fillTemplate, stripImageTag, findTagInText, findAllTags, tagInner, templateEnvelope, markerPairs,
            parseLayers, mergeLayers, joinLayers, layerContract, isNoChange,
            injectDescToMessage, reinjectDescToMessage, renderFloorImage, renderAllImages,
            getProfiles, activeProfile, refreshSiteUI, getPresets, activePreset, refreshPresetUI, getImage, getImageCount, getImageCur, setImage, stepImage, replaceMarkersInDom,
            normalizeGenSize, siteErrorBrief, formatGenError, pickJsonBlock, styleSegment,
            imgUrlFromChat, imgUrlFromGen, packPlan, packImportText, packTemplateSplit, packSixTagText, stylePackBuild, getSystemPrompts,
            trimSourceText, tagInner, tagRegex, syncSwipeExtra, restoreSwipeExtra, isNoChange, stripImageTag, injectRecord, markerPairs, replaceMarkersAcrossNodes, htmlMarkerRegexes, sdgFileTime, dropExpiredRefs, cleanupOldImages,
            genImageUnified, isModerationBlock, dropFloorImages, hasAnyImage, dropIfMarkersGone,
            parseChatResponse, callSubAI, runExtract, onStop, persistChat, persistGenImage, generateForFloor, onRegenFloor,
            normalizeImageToDataUrl, generateImage, backupChatImages
        };
    }

})();
