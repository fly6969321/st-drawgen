/*
 *  生图工坊 · DrawGen v1.6.34
 *  SillyTavern 第三方扩展 —— 独立生图插件
 *
 *  管线：AI 回复 → 副AI提取生图描述（整段 / 分层）→ 注入 image###…### 标记 → 中转站生图 → 标记原位换成图片
 *
 *  · 楼层正文里每一个 image###…### 标记原位换成图片，一楼几个标记几张图；
 *    没图的标记显示「生成图片」按钮，出图后是折叠条，重画保留历史可翻页
 *  · 面板两个页签卡片「🎨 生图」「📝 提取」；日版 / 夜版主题；酒馆扩展抽屉里有入口块
 *  · 生图 / 提取各自多站点；画风 / 提取规则 / 角色锚点各自多套预设
 *  · 分层提取：镜头/环境/氛围/人物/服装/动作（六层），各一框一锁，可只重摇一层，环境/氛围/服装跨楼沿用
 */
(function () {
    "use strict";

    const EXT_KEY = "st-drawgen";
    const VERSION = "1.6.35";
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
        autoDelay: 1800,
        hideTagText: true,          // 出图后标记文字不显示（标记原位换成图）
        // —— 生图 ——
        genEndpoint: "", genKey: "", genModel: "",
        genFixedPrompt: "", genPostfixPrompt: "",
        stylesJson: "", styleId: "",     // 画风预设（可存多个随时切）
        rulesJson: "", rulesId: "",      // 提取规则预设
        anchorsJson: "", anchorsId: "",  // 角色锚点预设
        grokSize: "1024x1024",
        faceRef: "", faceRefOn: false, faceRefMode: "chat",   // 脸部参考图（data URL）+ 锁脸开关 + 发送方式（chat=聊天多模态 / edits=/images/edits 编辑接口）
        genProxy: false,
        genTimeout: 300,
        convertToJpeg: false,
        showImage: true,
        imageMaxWidth: 100,
        // —— 界面 ——
        ballLeft: "", ballTop: "",
        panelLeft: "", panelTop: ""
    };

    let currentDesc = "", currentIdx = -1, processing = false, initialized = false;
    let extAbort = null, genAbort = null, extUserAbort = false;
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
        gen: { endpoint: "genEndpoint", key: "genKey", model: "genModel", size: "grokSize" }
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
        if (kind === "gen") { p.size = cfg().grokSize || "1024x1024"; }
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
    function presetRowHTML(kind, title) {
        const P = PRESETS[kind], id = P.selId.slice(1);
        return field(title, '<div class="sdg-siterow">' +
            '<select id="' + id + '"></select>' +
            '<button type="button" class="sdg-minibtn sdg-p-add" data-k="' + kind + '" title="新建">＋</button>' +
            '<button type="button" class="sdg-minibtn sdg-p-ren" data-k="' + kind + '" title="改名">✎</button>' +
            '<button type="button" class="sdg-minibtn sdg-p-del" data-k="' + kind + '" title="删除">🗑</button>' +
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
                try { out = out.replace(new RegExp("\\s*" + escRe(pre) + "[\\s\\S]*?" + escRe(suf), "g"), ""); } catch (e) {}
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
        if (typeof c.saveChat === "function") c.saveChat();
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
        if (typeof c.saveChat === "function") c.saveChat();
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
            /* 3. 还缺的标记（刚注入到楼尾的那条）补一个文本节点再转一次 */
            const made = el.querySelectorAll(".sdg-slot").length;
            for (let k = made; k < tags.length; k++) {
                el.appendChild(document.createTextNode("\n\n" + tags[k].full));
            }
            if (tags.length > made) replaceMarkersInDom(el);
        } catch (e) { log("rerenderFloor:", e.message); }
        setTimeout(function () { try { renderFloorImage(idx); installMesButtons(); } catch (e) {} }, 60);
    }

    /* ============================================================
       楼层按钮：🎨 重注入 / 🖼 重新生图
       ============================================================ */
    const MES_BTN_REINJECT = "sdg-mes-reinject";
    const MES_BTN_REGEN = "sdg-mes-regen";
    function installMesButtons() {
        const chatEl = q("#chat"); if (!chatEl) return 0;
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
            const wantG = !!(msg && !msg.is_user && (hasAnyImage(msg) || findAllTags(msg.mes).length));
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
                                try { if (typeof ctx().saveChat === "function") ctx().saveChat(); } catch (e) {}
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
        if (timeoutMs < 30000) timeoutMs = 30000;
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
        return fetch(url, options).finally(function () { clearTimeout(timer); });
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
                if (msg.reasoning_content && String(msg.reasoning_content).trim()) return String(msg.reasoning_content).trim();
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

        extUserAbort = false;
        if (typeof AbortController !== "undefined") extAbort = new AbortController();

        const systemPrompt = (activeSystemPrompt() || {}).value || DEFAULT_SYS_EMO;
        const body = {
            model: c.extModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: buildVisionUserPrompt(text, supplement || "", layerOpts) }
            ],
            temperature: 0.4,
            stream: false
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
        if (extAbort) fetchOptions.signal = extAbort.signal;

        let res;
        try {
            res = await fetchWithTimeout(url, fetchOptions, Number(c.requestTimeout || 0) * 1000);
        } catch (e) {
            extAbort = null;
            throw e;
        }

        const raw = await res.text();
        extAbort = null;
        if (!res.ok) throw new Error("API " + res.status + "：" + raw.slice(0, 220));

        const data = safeJson(raw, null);
        if (!data) throw new Error("API 返回不是 JSON：" + raw.slice(0, 180));

        const out = parseChatResponse(data);
        if (out) return out;

        let finish = "";
        try { if (data.choices && data.choices[0] && data.choices[0].finish_reason) finish = data.choices[0].finish_reason; } catch (e) {}
        if (finish === "length") throw new Error("模型返回为空，finish_reason=length，服务端截断了输出。原始返回：" + raw.slice(0, 180));
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
    async function dataUrlFromUrl(url) {
        const resp = await fetch(url, { headers: directHeaders() });
        if (!resp.ok) throw new Error("下载图片失败: " + resp.status);
        const blob = await resp.blob();
        return await blobToDataURL(blob);
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
        const size = String(c.grokSize || "1024x1024");
        const signal = genAbort ? genAbort.signal : undefined;
        const errs = [];
        async function parseResp(resp, tag) {
            const text = await resp.text();
            if (!resp.ok) throw new Error(tag + " " + resp.status + ": " + text.slice(0, 150));
            let result;
            try { result = JSON.parse(text); } catch (e) { throw new Error(tag + " 响应不是 JSON: " + text.slice(0, 120)); }
            const item = result && result.data && result.data[0];
            if (!item) throw new Error(tag + " 响应缺少 data[0]: " + text.slice(0, 150));
            if (item.b64_json) return "data:image/png;base64," + item.b64_json;
            if (item.url) return await dataUrlFromUrl(item.url);
            throw new Error(tag + " 响应未包含图片");
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
        const attempts = [
            ["multipart-PNG", { method: "POST", headers: { "Authorization": "Bearer " + (c.genKey || "") }, body: multipartBody(pngRef, "image/png", "face.png"), signal }],
            ["multipart-JPEG", { method: "POST", headers: { "Authorization": "Bearer " + (c.genKey || "") }, body: multipartBody(faceRef, "image/jpeg", "face.jpg"), signal }],
            ["JSON/dataURL", { method: "POST", headers: directHeaders("application/json", "Bearer " + (c.genKey || "")), body: JSON.stringify({ model: c.genModel, prompt: prompt, image: faceRef, n: 1, size: size }), signal }],
            ["JSON/base64", { method: "POST", headers: directHeaders("application/json", "Bearer " + (c.genKey || "")), body: JSON.stringify({ model: c.genModel, prompt: prompt, image: rawB64, n: 1, size: size }), signal }]
        ];
        for (let i = 0; i < attempts.length; i++) {
            const tag = attempts[i][0];
            try {
                return await parseResp(await fetch(url, attempts[i][1]), tag);
            } catch (e) {
                if (e.name === "AbortError") throw e;
                errs.push("[" + tag + "] " + String(e.message || e).slice(0, 110));
                log("编辑接口形状 " + tag + " 失败:", String(e.message || e).slice(0, 200));
            }
        }
        throw new Error("编辑接口四种形状均失败 → " + errs.join(" ｜ "));
    }

    /* —— 生图：中转站 chat/completions 多模态 —— */
    async function genGemini(finalPrompt) {
        const c = cfg();
        let base = String(c.genEndpoint || "").trim().replace(/\/+$/, "");
        if (!base) throw new Error("请先填写生图 API 地址");
        if (/\/chat\/completions$/.test(base)) base = base.replace(/\/chat\/completions$/, "");
        const url = base + "/chat/completions";
        const faceRef = (cfg().faceRefOn && String(cfg().faceRef || "")) ? String(cfg().faceRef) : "";
        const parts = [];
        if (faceRef) parts.push({ type: "image_url", image_url: { url: faceRef } });
        parts.push({ type: "text", text: faceRef
            ? finalPrompt + "\n\n（第一张图是人物面部参考：只把与参考图相貌对应的角色按参考脸生成，严格保持其脸部特征、发型与身份，不要改变长相或性别；其余角色严格按正文各自描述生成。）"
            : finalPrompt });
        const messages = [{ role: "user", content: parts }];
        const payload = { model: c.genModel, messages: messages, size: String(c.grokSize || "1024x1024") };
        log("Gemini 请求:", url);

        let requestUrl = url, requestHeaders, requestBody = payload;
        if (c.genProxy && ctx() && typeof ctx().getRequestHeaders === "function") {
            requestUrl = "/api/backends/chat-completions/generate";
            requestHeaders = ctx().getRequestHeaders();
            requestBody = {
                chat_completion_source: "custom",
                custom_url: base,
                custom_include_headers: "Authorization: \"Bearer " + (c.genKey || "") + "\"",
                model: c.genModel,
                messages: messages,
                stream: false
            };
        } else {
            requestHeaders = directHeaders("application/json", "Bearer " + (c.genKey || ""));
        }

        const signal = genAbort ? genAbort.signal : undefined;
        const resp = await fetch(requestUrl, { method: "POST", headers: requestHeaders, body: JSON.stringify(requestBody), signal });
        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error("API request failed with status " + resp.status + ": " + errorText);
        }
        const result = await readOpenAIResponse(resp);
        return await extractImageFromChatResponse(result);
    }

    async function extractImageFromChatResponse(result) {
        const choices = result && result.choices;
        if (choices && choices.length > 0) {
            const content = choices[0].message && choices[0].message.content;
            const reasoningDetails = choices[0].message && choices[0].message.reasoning_details;
            if (reasoningDetails && Array.isArray(reasoningDetails.images) && reasoningDetails.images.length > 0) {
                const firstImage = reasoningDetails.images[0];
                if (firstImage && firstImage.type === "image_url" && firstImage.image_url) {
                    const u = typeof firstImage.image_url === "string" ? firstImage.image_url : firstImage.image_url.url;
                    if (u) return await normalizeImageToDataUrl(u);
                }
            }
            if (Array.isArray(content)) {
                for (const item of content) {
                    if (item && item.type === "image_url" && item.image_url) {
                        const u = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
                        if (u) return await normalizeImageToDataUrl(u);
                    }
                }
            } else if (typeof content === "string") {
                const markdownImageRegex = /!\[.*?\]\(((?:https?:\/\/|data:image\/[^;]+;base64,)[^\s\)]+)\)/;
                const match = content.match(markdownImageRegex);
                if (match && match[1]) return await normalizeImageToDataUrl(match[1]);
                log("响应只有文本，没有图片");
            }
        }
        throw new Error("API 响应中没有找到图片");
    }
    async function normalizeImageToDataUrl(u) {
        if (!u) return "";
        if (String(u).startsWith("data:image/")) return u;
        try { return await dataUrlFromUrl(u); }
        catch (e) { log("下载失败，直接用 URL 兜底:", e.message); return u; }
    }

    /* 把生成的图（dataURL）上传到酒馆服务器存成文件，聊天记录里只留链接。
       不上传的话整张图的 base64 会写进聊天文件，几十次生图后聊天文件上百 MB，
       手机端 Node 读进内存直接 OOM 崩溃。上传失败则原样返回（老行为兜底）。 */
    async function persistGenImage(imageUrl) {
        try {
            if (!String(imageUrl).startsWith("data:image/")) return imageUrl;
            const cont = ctx();
            if (!cont || typeof cont.getRequestHeaders !== "function") return imageUrl;
            const s = String(imageUrl);
            const meta = s.slice(0, s.indexOf(","));
            const b64 = s.slice(s.indexOf(",") + 1);
            const format = /image\/jpe?g/.test(meta) ? "jpeg" : (/image\/webp/.test(meta) ? "webp" : (/image\/gif/.test(meta) ? "gif" : "png"));
            const chName = (cont.characterId !== undefined && cont.characters && cont.characters[cont.characterId]) ? String(cont.characters[cont.characterId].name || "") : "";
            const filename = "sdg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            const res = await fetch("/api/images/upload", {
                method: "POST",
                headers: cont.getRequestHeaders(),
                body: JSON.stringify({ image: b64, format: format, ch_name: chName, filename: filename })
            });
            if (!res.ok) { log("图片上传服务器失败，保留内嵌存储:", res.status); return imageUrl; }
            const j = await res.json();
            if (j && j.path) { log("图片已存服务器:", j.path); return String(j.path).replace(/^\/+/, ""); }
            log("上传响应缺少 path，保留内嵌存储");
            return imageUrl;
        } catch (e) { log("图片上传异常，保留内嵌存储:", e && e.message); return imageUrl; }
    }

    async function generateImage(desc) {
        const c = cfg();
        if (!c.genModel) throw new Error("请先填写生图模型");
        const finalPrompt = [c.genFixedPrompt, String(desc || "").trim(), c.genPostfixPrompt].filter(Boolean).join(", ");
        if (!finalPrompt) throw new Error("没有可用的生图提示词");
        log("生图最终提示词:", finalPrompt.slice(0, 200));

        if (typeof AbortController !== "undefined") genAbort = new AbortController();
        try {
            const faceRef = (cfg().faceRefOn && String(cfg().faceRef || "")) ? String(cfg().faceRef) : "";
            let imageUrl = (faceRef && String(cfg().faceRefMode) === "edits") ? await genEdits(finalPrompt, faceRef) : await genGemini(finalPrompt);
            if ((c.convertToJpeg === true || String(c.convertToJpeg) === "true") && String(imageUrl).startsWith("data:image/")) {
                try { imageUrl = await convertImageToJpeg(imageUrl); } catch (eJ) { log("转 JPEG 失败，保留原图:", eJ.message); }
            }
            imageUrl = await persistGenImage(imageUrl);
            return { image: imageUrl, prompt: finalPrompt };
        } finally {
            genAbort = null;
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
    function setImage(msg, slot, url) {
        const g = galWrite(msg), sk = swipeKey(msg);
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

    function escHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    /* 楼层 innerHTML 里把标记换成槽；标记文字在 HTML 里可能是原样也可能被转义过，两种都认 */
    function htmlMarkerRegexes() {
        return markerPairs().map(function (p) {
            const pre = "(?:" + escRe(p.pre) + "|" + escRe(escHtml(p.pre)) + ")";
            const suf = "(?:" + escRe(p.suf) + "|" + escRe(escHtml(p.suf)) + ")";
            return new RegExp(pre + "([\\s\\S]*?)" + suf, "gi");
        });
    }
    function slotHTML(innerHtml) {
        return '<div class="sdg-slot"><div class="sdg-slot-body"></div><div class="sdg-tag">' + innerHtml + '</div></div>';
    }
    /* 楼层图限高 = 「键盘未弹出时」视口高的 70%，定格成固定像素。
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
        body.innerHTML =
            '<div class="sdg-bar' + (open ? "" : " closed") + '">' +
                '<span class="sdg-bar-l"><span class="sdg-bar-ico">📷</span><span class="sdg-bar-txt">点击查看图片</span></span>' +
                '<span class="sdg-bar-r">' +
                    (total > 1
                        ? '<span class="sdg-pager"><button type="button" class="sdg-pg" data-d="-1" title="上一张">‹</button><span class="sdg-pgn">' + (cur + 1) + '/' + total + '</span><button type="button" class="sdg-pg" data-d="1" title="下一张">›</button></span>'
                        : '') +
                    '<button type="button" class="sdg-slot-regen" title="重新生成一张（旧图保留可翻看）">↻ 重画</button>' +
                '</span>' +
            '</div>' +
            '<div class="sdg-imgbox"' + (open ? "" : ' style="display:none"') + '>' +
                '<img class="sdg-img" alt="生成图片">' +
            '</div>';
        const im = body.querySelector("img");
        if (im) {
            /* 内联样式限制楼层里图片的高度：竖版长图折叠条展开后也尽量一屏内可见。
               限高用固定 px（maxImgH），不用 vh/dvh——那两个单位会被手机键盘挤压导致图缩 */
            im.style.maxWidth = "100%";
            im.style.width = "auto";
            im.style.height = "auto";
            im.style.maxHeight = maxImgH();
            im.style.objectFit = "contain";
            im.setAttribute("src", src);
            bindImagePreview(im);
        }
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
                    slot.querySelector(".sdg-tag").textContent = String(m[1] || "").trim();
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

    function renderFloorImage(idx) {
        let msg = null;
        try { msg = (ctx().chat || [])[idx]; } catch (e) { return false; }
        if (!msg) return false;
        const mesEl = q('#chat .mes[mesid="' + idx + '"]');
        const el = mesEl && mesEl.querySelector(".mes_text");
        if (!el) return false;
        const tags = findAllTags(msg.mes);
        const hide = cfg().hideTagText !== false;

        /* swipe 变了：这楼的槽全部作废重来（否则旧回复的图挂在新回复上） */
        const sk = swipeKey(msg);
        if (mesEl.getAttribute("data-sdg-swipe") !== sk) {
            qa('#chat .mes[mesid="' + idx + '"] .sdg-slot').forEach(function (x) { x.remove(); });
            const orphan0 = el.querySelector("img.sdg-img.sdg-orphan"); if (orphan0) orphan0.remove();
            mesEl.setAttribute("data-sdg-swipe", sk);
        }

        /* 正文里没标记：只有「无标记直接生图」留下的图才追加在楼尾 */
        if (!tags.length) {
            qa('#chat .mes[mesid="' + idx + '"] .sdg-slot').forEach(function (x) { x.remove(); });
            const src = hasAnyImage(msg) ? getImage(msg, 0) : "";
            let img = el.querySelector("img.sdg-img.sdg-orphan");
            if (!src) { if (img) img.remove(); return false; }
            if (!img) {
                img = document.createElement("img");
                img.className = "sdg-img sdg-orphan";
                img.alt = "生成图片";
                /* 同 fillSlot：楼内图片限高，一屏内可见（固定 px，防键盘挤压缩图） */
                img.style.maxWidth = "100%";
                img.style.width = "auto";
                img.style.height = "auto";
                img.style.maxHeight = maxImgH();
                img.style.objectFit = "contain";
                el.appendChild(img);
            }
            if (img.getAttribute("src") !== src) img.setAttribute("src", src);
            bindImagePreview(img);
            return true;
        }

        /* 第一遍：文本节点里的标记 → 槽（只碰文本，别的插件的 HTML 原样留着） */
        const have = el.querySelectorAll(".sdg-slot").length;
        if (have < tags.length) {
            replaceMarkersInDom(el);
            const orphan = el.querySelector("img.sdg-img.sdg-orphan"); if (orphan) orphan.remove();
        }
        /* 第二遍：按文档顺序给槽编号，按状态填内容 */
        const slots = Array.prototype.slice.call(el.querySelectorAll(".sdg-slot"));
        if (!slots.length) return false;
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
            if (hasAnyImage(m) || findAllTags(m.mes).length) {
                try { renderFloorImage(i); } catch (e) {}
            }
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

    async function runExtract(text, supplement, opts) {
        opts = opts || {};
        const targetIdx = typeof opts.targetIdx === "number" ? opts.targetIdx : currentIdx;
        const attempt = Number(opts.attempt || 0);
        if (processing) return;
        processing = true;
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
            currentIdx = targetIdx;

            let desc = raw, layers = null;
            if (layered) {
                const parsed = parseLayers(raw);
                if (parsed) {
                    layers = mergeLayers(parsed, layerOpts.prev, layerOpts.locks);
                    setLayerBoxes(layers);
                    layersFresh = true;
                    desc = joinLayers(layers);
                    setStatus("分层提取完成", C_OK);
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
                if (cfg().autoInject) {
                    try {
                        const r = injectDescToMessage(desc, targetIdx, layers);
                        if (r.injected) setStatus("已注入 ✓", C_OK);
                    } catch (eInj) { log("自动注入失败:", eInj.message); }
                }
                if (cfg().autoGenerate && cfg().enabled) {
                    await generateForFloor(targetIdx, desc);
                }
            }
        } catch (e) {
            console.error(LOG, e);
            const userAbort = e && e.name === "AbortError" && extUserAbort;
            const msg = userAbort ? "请求已被打断" : (e && e.message || String(e));
            setStatus("提取失败: " + msg, C_ERR);
            if (!userAbort && !isConfigError(e) && attempt === 0 && opts.auto) {
                scheduleRetry(text, supplement || "", targetIdx, msg);
            } else {
                toast("提取失败：" + msg, false);
            }
        } finally {
            const btn2 = q("#sdg-btn-extract"); if (btn2) btn2.disabled = false;
            extAbort = null; extUserAbort = false;
            processing = false;
        }
    }

    /* 给某楼的某个标记槽生图；slot 缺省 = 最后一个标记；正文没标记时 desc 必填，图挂在楼尾 */
    async function generateForFloor(idx, desc, slot) {
        const msg = (ctx().chat || [])[idx];
        const tags = msg ? findAllTags(msg.mes) : [];
        if (typeof slot !== "number" || slot < 0) slot = tags.length ? tags.length - 1 : 0;
        desc = String(desc || "").trim();
        if (!desc && tags[slot]) desc = tags[slot].inner;
        if (!desc && msg) { const rec = injectRecord(msg); if (rec) desc = rec.desc; }
        if (!desc) throw new Error("没有可用的生图描述");
        if (idx >= 0) currentIdx = idx;

        const key = idx + ":" + slot;
        if (genBusy[key]) { setStatus("这张正在生图中", C_WARN); return ""; }
        genBusy[key] = true;
        if (msg) renderFloorImage(idx);
        setStatus("正在生图…", C_OK);
        const t0 = Date.now();
        try {
            const { image } = await generateImage(desc);
            if (msg) {
                setImage(msg, slot, image);
                if (!injectRecord(msg)) rememberInject(msg, buildInjectTag(desc, null), desc, null);
                try { if (typeof ctx().saveChat === "function") ctx().saveChat(); } catch (eS) {}
            }
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            setStatus("生图完成，耗时 " + dur + " 秒 ✓", C_OK);
            toast("✅ 生图完成，耗时 " + dur + " 秒", true);
            return image;
        } catch (e) {
            console.error(LOG, e);
            const m = e && e.message || String(e);
            setStatus("生图失败: " + m, C_ERR);
            toast("生图失败：" + m, false);
            throw e;
        } finally {
            delete genBusy[key];
            genAbort = null;
            if (msg) { try { renderFloorImage(idx); installMesButtons(); } catch (e) {} }
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
    function markerPairs() {
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
        return out;
    }
    /* 楼层正文里所有标记，按出现顺序 → [{full, inner, pre, suf}] */
    function findAllTags(text) {
        const t = String(text || "");
        const found = [];
        markerPairs().forEach(function (p) {
            const re = new RegExp(escRe(p.pre) + "([\\s\\S]*?)" + escRe(p.suf), "gi");
            let m;
            while ((m = re.exec(t)) !== null) {
                const inner = String(m[1] || "").trim();
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
        const t = String(tag || "");
        for (const p of markerPairs()) {
            if (t.startsWith(p.pre) && t.endsWith(p.suf)) return t.slice(p.pre.length, t.length - p.suf.length).trim();
        }
        return t.replace(/^\s*<[A-Za-z][\w-]*\s*>/, "").replace(/<\/[A-Za-z][\w-]*\s*>\s*$/, "").replace(/^image###/, "").replace(/###$/, "").trim();
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

            /* 主模型自己写了标记：不叫副AI，每个标记各生一张 */
            const tags = findAllTags(msg.mes);
            if (tags.length) {
                currentIdx = i;
                layersFresh = false;
                setPreview(tags[tags.length - 1].inner);
                renderFloorImage(i);
                if (!cfg().autoGenerate) { setStatus("检测到 " + tags.length + " 个生图标记（自动生图已关闭）", C_WARN); return; }
                setStatus("检测到 " + tags.length + " 个生图标记，直接生图…", C_OK);
                (async function () {
                    for (let s = 0; s < tags.length; s++) {
                        if (getImage(msg, s)) continue;
                        try { await generateForFloor(i, tags[s].inner, s); } catch (e) {}
                    }
                })();
                return;
            }

            if (!cfg().autoExtract) { currentIdx = i; return; }

            pendingAutoIdx = i;
            currentIdx = i;
            if (autoTimer) clearTimeout(autoTimer);
            let delay = Number(cfg().autoDelay || 1800);
            if (delay < 500) delay = 500;
            autoTimer = setTimeout(runPendingAutoExtract, delay);
            setStatus("已捕捉新正文，等待自动提取…", C_OK);
        } catch (e) { console.error(LOG, e); }
    }

    function runPendingAutoExtract() {
        if (pendingAutoIdx < 0) return;
        if (processing) { setTimeout(runPendingAutoExtract, 1200); return; }
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
            await generateForFloor(idx, desc);
        } catch (e) { /* 已提示 */ }
    }
    async function onRegenFloor(idx) {
        try {
            const msg = (ctx().chat || [])[idx];
            if (!msg) return;
            const tags = findAllTags(msg.mes);
            if (!tags.length) { const rec = injectRecord(msg); await generateForFloor(idx, rec ? rec.desc : "", 0); return; }
            for (let s = 0; s < tags.length; s++) {
                try { await generateForFloor(idx, tags[s].inner, s); } catch (e) {}
            }
        } catch (e) { /* 已提示 */ }
    }
    function onStop() {
        try {
            if (extAbort) { extUserAbort = true; extAbort.abort(); extAbort = null; }
            if (genAbort) { genAbort.abort(); genAbort = null; }
            setStatus("已打断当前请求", C_ERR);
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
                    '</div>' +

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
                    presetRowHTML("style", "画风预设") +
                    bigField("sdg-gen-fixed", "genFixedPrompt", 3, "例：Korean semi-realistic anime, ultra-detailed digital painting…", "风格词（拼在描述前）") +
                    bigField("sdg-gen-postfix", "genPostfixPrompt", 2, "例：masterpiece, best quality", "后缀词（拼在描述后）") +
                    '<div class="sdg-hint">画风只影响出图风格，不会发给副AI；跟下面的「提取规则」是两回事</div>' +

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
                    field("超时（秒，0 = 不限）", textInput("sdg-timeout", "requestTimeout", "", "number")) +
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
        q("#sdg-delay").addEventListener("change", function (ev) { save("autoDelay", Number(ev.target.value) || 1800); });
        q("#sdg-imgw").addEventListener("change", function (ev) { save("imageMaxWidth", Number(ev.target.value) || 60); applyImageWidth(); });
        bindChk("#sdg-enabled", "enabled", function () { syncDrawer(); });
        bindChk("#sdg-show-ball", "showBall", function () { applyBallVisible(); syncDrawer(); });

        /* 画风 / 提取规则 / 角色锚点 预设 */
        bindPresets();

        /* 提取设置 */
        bindSite("ext");
        bindText("#sdg-template", "template");
        bindChk("#sdg-ext-proxy", "extProxy");
        bindChk("#sdg-retry", "retryOnce");
        q("#sdg-timeout").addEventListener("change", function (ev) { save("requestTimeout", Number(ev.target.value) || 0); });

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
        if (kind === "gen") on("#sdg-grok-size", "change", function (e) { saveProfileField("gen", "size", e.target.value); });

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
            setStatus("生图连接失败：" + (e && e.message || e), C_ERR);
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
            ["MESSAGE_SWIPED", "MESSAGE_UPDATED", "MESSAGE_EDITED"].forEach(function (evName) {
                if (c.event_types[evName]) {
                    c.eventSource.on(c.event_types[evName], function (i) {
                        setTimeout(function () {
                            try { const n = Number(i); if (Number.isFinite(n)) renderFloorImage(n); else renderAllImages(); installMesButtons(); } catch (e) {}
                        }, 120);
                    });
                }
            });
            if (c.event_types.CHAT_CHANGED) {
                c.eventSource.on(c.event_types.CHAT_CHANGED, function () {
                    currentIdx = -1; layersFresh = false;
                    setTimeout(function () { renderAllImages(); installMesButtons(); }, 300);
                });
            }
            if (c.event_types.APP_READY) {
                c.eventSource.on(c.event_types.APP_READY, function () {
                    setTimeout(function () { renderAllImages(); installMesButtons(); }, 500);
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
                    if (SDG_CAP_H > before) qa("img.sdg-img").forEach(function (im) { im.style.maxHeight = SDG_CAP_H + "px"; });
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
            getProfiles, activeProfile, refreshSiteUI, getPresets, activePreset, refreshPresetUI, getImage, getImageCount, getImageCur, setImage, stepImage, replaceMarkersInDom
        };
    }

})();
