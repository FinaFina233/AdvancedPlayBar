/* ============================================================
 * AdvancedPlayBar — 播放栏增强（透明播放栏 + 进度条动效 + 主题色）
 * BetterNCM 插件 / 注入点：Main
 *
 * 由两个插件合并而成：
 *   PlayBarTransparent 0.1.4  -> 「透明播放栏」一节（barEnabled/opacity/blur/compatMode）
 *   PlayBarHover       0.4.0  -> 「进度条」与「主题色」两节
 * 两节各有独立开关，互不影响；「主题色」是全局设置，不受两者开关约束。
 *
 * 目标元素（本机实测，网易云 3.1.40，CEF 91）：
 *   #page_pc_mini_bar                     迷你播放条容器（唯一的 id 锚点）
 *   └ .cmd-space
 *     ├ .MinibarHoverMask_mvfuu0n         悬停遮罩 1562x200 z=-1
 *     ├ .SpaceContainer_s8o78dm           1562x3
 *     │ └ .slider-default                 进度条本体 1562x3
 *     │   ├ .hotzone-overlay              悬停热区 1562x23
 *     │   ├ .cache                        缓冲进度
 *     │   ├ .track                        已播进度（颜色在 background-image 渐变里）
 *     │   ├ .dots / .ChorusMarkDot        章节点 / 副歌标记点
 *     │   └ .thumb                        白点 0x0（悬停时才 16x16）
 *     └ .default-bar-wrapper              播放栏本体 1562x80  <- 透明化目标
 *
 * ⚠ 两条贯穿始终的硬约束：
 *   1. CEF 是 Chromium 91，**没有 :has()**（要 105+）。带 :has() 的选择器
 *      会让整条规则被浏览器直接丢弃，是静默失效。
 *   2. 类名是 CSS Module 哈希（DefaultBarWrapper_d196mrsa），跨版本会变。
 *      所以优先用不带哈希的静态类名，其次 [class*=]，**绝不用 [class^=]**
 *      —— BGEnhanced 的「预制全透明」就是栽在 ^= 上（见下）。
 *
 * 关于 ^= 那个坑（PlayBarTransparent 存在的理由）：
 *   BGEnhanced 0.3.8 写的是 [class^="DefaultBarWrapper_"]，而真实
 *   className 是 "default-bar-wrapper DefaultBarWrapper_d196mrsa" ——
 *   第一位是 'd' 不是 'D' 开头，^= 要求从头匹配，所以命中 0 个元素。
 *   实测：^= 0 个，*= 1 个，.default-bar-wrapper 1 个。
 *
 * 播放栏透明的两条防线：
 *   1. CSS 选择器做主力（不写内联样式，React 重渲染不会影响它）
 *   2. 兼容模式：内联样式 + MutationObserver 兜底（CSS 被更高权重压过时用）
 * ============================================================ */

(function () {
    'use strict';

    var CONFIG_KEY = 'advanced-playbar-settings';
    var STYLE_ID = 'apb-style';

    /* ── 源码仓库与反馈渠道 ──
     * BetterNCM 插件商店的《上架准则》要求：插件必须在设置页面提供
     * **可点击**的源码仓库链接和问题反馈渠道（用 betterncm.ncm.openUrl
     * 打开外部浏览器）。所以这两个地址会出现在面板底部，别删。 */
    var REPO_URL = 'https://github.com/FinaFina233/AdvancedPlayBar';
    var ISSUES_URL = REPO_URL + '/issues';

    /* 全部进度条规则的作用域锚点 */
    var SCOPE = '#page_pc_mini_bar';

    /* 播放栏候选选择器。第一个是网易云自带的静态类名（不含哈希，跨版本
     * 最稳），第二个用 *= 而不是 ^=（这是修复 BGEnhanced 的核心）。 */
    var BAR_SELECTORS = '.default-bar-wrapper, [class*="DefaultBarWrapper_"]';


    function defaults() {
        return {
            /* ══════════ 一、透明播放栏（原 PlayBarTransparent）══════════
             * 两个功能区各有独立开关，互不影响，没有总开关。 */
            barEnabled: true,
            opacity: 0.1,           // 0.1 = 10% 不透明度（也就是 90% 透明）
            blur: 5,                // 播放栏毛玻璃半径 px
            /* 兼容模式：CSS 选择器被更高权重的样式压过时，
             * 直接把样式内联写到播放栏元素上（配 MutationObserver 守着）。
             * 默认关 —— 正常情况下 CSS 选择器就够了，开着反而多一层
             * 会碰 DOM 的机制。透明没生效时再让用户打开。 */
            compatMode: false,

            /* ══════════ 二、进度条（原 PlayBarHover 主体）══════════ */
            hoverEnabled: true,
            duration: 180,          // 过渡时长 ms
            glow: true,             // 悬停时给进度条加柔光（替换原来的黑影）

            /* 进度条自身的颜色来源（面板上叫「颜色来源」）
             *   'theme'  = 跟随主题（读客户端的 --colorPrimary1，即软件当前主题色）
             *   'custom' = 用 accentRgb 自选色
             * 原来的第三项 'native'（保持原样）已取消：它让"要不要上色"
             * 和"上什么色"两件事搅在一起，逻辑容易错乱。 */
            accentMode: 'theme',
            accentRgb: { r: 236, g: 65, b: 65 },

            /* 悬停时播放条上方那层"光晕"的强度（0 = 完全关掉）。
             * 它来自客户端变量 --minibar-hover--mask-bg 画的 200px 渐变，
             * 原版是纯黑、峰值 96%。我们换成主题色并大幅压低。 */
            maskGlow: 0.05,

            /* ══════════ 三、主题色（全局，不受上面两个开关约束）══════════
             * 客户端把主题色变量**内联写在 <html> 上**（见 --colorPrimary*
             * / --colorSecondary* / --colorSidebar* / --colorFunction11,12），
             * 我们用一个带 !important 的样式表规则压过它，从而全局生效。
             *   'native' = 不干预（默认，最安全）
             *   'custom' = 用 themeRgb 统一改 */
            themeMode: 'native',
            themeRgb: { r: 236, g: 65, b: 65 }
        };
    }

    var state = defaults();
    var styleEl = null;

    /* 播放栏透明（兼容模式）用的状态 */
    var observer = null;
    var barEl = null;
    var inlineApplied = false;


    /* ------------------------------------------------------------
     * 配置读写
     * ---------------------------------------------------------- */
    function api() {
        return (typeof betterncm !== 'undefined' && betterncm) ? betterncm : null;
    }

    /* ------------------------------------------------------------
     * 配置持久化
     *
     * ⚠ 踩过的坑（重要，别再犯）：
     *   betterncm.app.writeConfig 的底层实现是
     *       fetch(`/app/write_config?key=${K}&value=${encodeURIComponent(V)}`)
     *   值被拼进 **URL 查询字符串**，传对象进去会被 String() 成
     *   "[object Object]" 存起来；而 readConfig 返回的是 .text()，
     *   恒为字符串。所以这套 API **只适合存字符串**。
     *
     *   后果：配置存成 [object Object] -> 读回来是字符串 ->
     *   类型校验失败 -> 每次重启都重置成默认值。
     *
     *   正确做法（参考 BGEnhanced 的 useLocalStorage）：
     *   **localStorage + JSON.stringify/parse** 才是可靠来源。
     *   app.writeConfig 只作为附带写一份，读的时候绝不依赖它。
     * ---------------------------------------------------------- */

    /** 合法的设置对象：非 null 且不是数组 */
    function isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }

    /**
     * 读设置。localStorage 是**首选**来源。
     * 读到坏数据（比如 "[object Object]"）时自动忽略并回退。
     */
    function loadSettings(key, fallback) {
        /* 1. localStorage（主力） */
        try {
            var raw = localStorage.getItem(key);
            if (raw !== null && raw !== '' && raw !== '[object Object]') {
                var parsed = JSON.parse(raw);
                if (isPlainObject(parsed)) return Promise.resolve(parsed);
            }
        } catch (e) { /* 解析失败继续往下试 */ }

        /* 2. BetterNCM 存储（兜底，只可能是字符串形式） */
        var b = api();
        try {
            if (b && b.app && typeof b.app.readConfig === 'function') {
                return Promise.resolve(b.app.readConfig(key, null)).then(function (v) {
                    if (isPlainObject(v)) return v;
                    if (typeof v === 'string' && v && v !== '[object Object]') {
                        /* 兼容：如果之前存进去的是 JSON 字符串，这里能救回来 */
                        try {
                            var p2 = JSON.parse(v);
                            if (isPlainObject(p2)) return p2;
                        } catch (e2) { /* 不是 JSON，放弃 */ }
                    }
                    return fallback;
                }).catch(function () { return fallback; });
            }
        } catch (e3) { /* ignore */ }

        return Promise.resolve(fallback);
    }

    /**
     * 写设置。localStorage 必写（可靠），BetterNCM 存储附带写一份
     * 且**必须序列化成字符串**，否则又会写成 [object Object]。
     */
    function saveSettings(key, value) {
        var json = null;
        try { json = JSON.stringify(value); } catch (e) { /* 循环引用等，忽略 */ }

        if (json !== null) {
            try { localStorage.setItem(key, json); } catch (e2) { /* 配额满等，忽略 */ }
        }

        var b = api();
        try {
            if (b && b.app && typeof b.app.writeConfig === 'function' && json !== null) {
                b.app.writeConfig(key, json);   // 传字符串，不传对象
            }
        } catch (e3) { /* ignore */ }
    }

    function clamp(n, min, max, fallback) {
        n = Number(n);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    /* ------------------------------------------------------------
     * 颜色工具
     * ---------------------------------------------------------- */
    function clampByte(n, fallback) {
        return Math.round(clamp(n, 0, 255, fallback));
    }

    function rgbToHex(rgb) {
        return '#' + rgb.map(function (v) {
            var s = clampByte(v, 0).toString(16);
            return s.length === 1 ? '0' + s : s;
        }).join('');
    }

    function hexToRgb(hex) {
        if (typeof hex !== 'string') return null;
        var m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!m) return null;
        var h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var v = parseInt(h, 16);
        return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
    }

    /* ------------------------------------------------------------
     * HSV <-> RGB
     *
     * 取色方块用 HSV 模型（就是 PS 默认那套 sRGB 手感）：
     *   H 色相 0-360   S 饱和度 0-1   V 明度 0-1
     * ---------------------------------------------------------- */
    function hsvToRgb(h, s, v) {
        h = ((h % 360) + 360) % 360;
        s = Math.min(1, Math.max(0, s));
        v = Math.min(1, Math.max(0, v));
        var c = v * s;
        var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        var m = v - c;
        var r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; }
        else if (h < 120) { r = x; g = c; }
        else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; }
        else if (h < 300) { r = x; b = c; }
        else { r = c; b = x; }
        return [
            Math.round((r + m) * 255),
            Math.round((g + m) * 255),
            Math.round((b + m) * 255)
        ];
    }

    function rgbToHsv(r, g, b) {
        r = clampByte(r, 0) / 255;
        g = clampByte(g, 0) / 255;
        b = clampByte(b, 0) / 255;
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        var d = mx - mn;
        var h = 0;
        if (d !== 0) {
            if (mx === r) h = 60 * (((g - b) / d) % 6);
            else if (mx === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        return { h: h, s: mx === 0 ? 0 : d / mx, v: mx };
    }

    /** 读一个 CSS 变量（挂在 :root 上的） */
    function cssVar(name) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name);
            return v ? v.trim() : '';
        } catch (e) { return ''; }
    }

    /**
     * 解析任意 CSS 颜色字符串为 [r,g,b]。
     *
     * ⚠ 必须同时支持 rgba() —— 客户端写在 <html> 上的变量值是
     *   "rgba(252,59,91,1)" 这种形式，**不是 hex**。
     *   之前只调 hexToRgb 导致解析失败、静默掉进兜底色，
     *   这是"小白点不跟随自选主题色"的根因之一。
     */
    function parseColor(str) {
        if (typeof str !== 'string') return null;
        var s = str.trim();
        if (!s) return null;

        var m = s.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
        if (m) return [clampByte(+m[1], 0), clampByte(+m[2], 0), clampByte(+m[3], 0)];

        var h = hexToRgb(s);
        if (h) return [h.r, h.g, h.b];
        return null;
    }

    /* ------------------------------------------------------------
     * 全局主题色
     *
     * 实测（本机 3.1.40）：客户端把主题色变量内联写在 <html> 的
     * style 属性上，形式是 rgba(r,g,b,a) —— 注意**没有空格**：
     *
     *   --colorPrimary1..8        α = 1 .9 .8 .6 .4 .3 .1 .08
     *   --colorSecondary1_1/_2    α = 1 / 1
     *   --colorSecondary2_1..4    四个并列强调色（_1 是主色）
     *   --colorSecondary3_1..4
     *   --colorSecondary4         α = 1
     *   --colorSidebar9..12
     *   --colorFunction11..14
     *
     * 做法：用一条带 !important 的样式表规则压过内联声明。
     * 样式表里的 !important > 内联的非 !important，所以能生效。
     * ---------------------------------------------------------- */

    /* 要覆盖的变量表：[变量名, 该组的基色索引, alpha]
     * 基色索引指向下面 BASES 里的第几个颜色。 */
    var BASES = ['main', 'sec1', 'sec2', 'sec3'];

    var THEME_VARS = [
        /* 主强调色族：按钮、选中态、徽标 —— 用 main */
        ['--colorPrimary1', 'main', 1],
        ['--colorPrimary2', 'main', 0.9],
        ['--colorPrimary3', 'main', 0.8],
        ['--colorPrimary4', 'main', 0.6],
        ['--colorPrimary5', 'main', 0.4],
        ['--colorPrimary6', 'main', 0.3],
        ['--colorPrimary7', 'main', 0.1],
        ['--colorPrimary8', 'main', 0.08],

        /* 次级强调族 1：进度报错链接、侧栏选中 —— 跟 main 同色系 */
        ['--colorSecondary1_1', 'main', 1],
        ['--colorSecondary1_2', 'sec1', 1],

        /* 次级强调族 2：_1 是主色，_2/_3 是并列的装饰色，这里统一 */
        ['--colorSecondary2_1', 'main', 1],
        ['--colorSecondary2_2', 'sec2', 1],
        ['--colorSecondary2_3', 'sec3', 1],
        ['--colorSecondary2_4', 'main', 1],

        /* 次级强调族 3 */
        ['--colorSecondary3_1', 'sec1', 1],
        ['--colorSecondary3_3', 'sec2', 1],

        ['--colorSecondary4', 'sec3', 1],

        /* 侧边栏的强调色 */
        ['--colorSidebar9', 'main', 1],
        ['--colorSidebar10', 'sec1', 1],
        ['--colorSidebar11', 'main', 1],
        ['--colorSidebar12', 'sec1', 1],

        /* 功能色里的强调色 */
        ['--colorFunction11', 'main', 1],
        ['--colorFunction12', 'sec1', 1],
        ['--colorFunction13', 'sec2', 1],
        ['--colorFunction14', 'sec3', 1]
    ];

    /**
     * 由用户选的一个颜色，派生出一组配套色。
     * 只改动色相/饱和度相关的轻微偏移，明度尽量保持，避免某些
     * 强调色变黑看不见。
     */
    function deriveBases(rgb) {
        var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
        var h = hsv.h, s = hsv.s, v = hsv.v;
        /* 三个邻居色相各偏一点，做出层次感又不跑调 */
        function at(dh, ds, dv) {
            return hsvToRgb((h + dh + 360) % 360,
                Math.min(1, Math.max(0, s * ds)),
                Math.min(1, Math.max(0, v * dv)));
        }
        return {
            main: rgb,
            sec1: at(-8, 0.92, 1.05),
            sec2: at(14, 0.85, 1.10),
            sec3: at(-22, 0.75, 1.18)
        };
    }

    /** 按客户端同样的格式拼 rgba：逗号后**不带空格** */
    function fmt(c, a) {
        var r = clampByte(c[0], 0), g = clampByte(c[1], 0), b = clampByte(c[2], 0);
        if (a >= 1) return 'rgba(' + r + ',' + g + ',' + b + ',1)';
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    /** 生成覆盖全局主题色的 CSS。themeMode !== 'custom' 时返回空串。 */
    function themeCss() {
        if (state.themeMode !== 'custom') return '';
        var t = state.themeRgb || {};
        var rgb = [clampByte(t.r, 236), clampByte(t.g, 65), clampByte(t.b, 65)];
        var bases = deriveBases(rgb);

        var out = [];
        out.push('/* 全局主题色覆盖 —— 用 !important 压过客户端内联在 <html> 上的变量 */');
        out.push(':root, html, body {');
        THEME_VARS.forEach(function (row) {
            var name = row[0], baseKey = row[1], alpha = row[2];
            out.push('  ' + name + ': ' + fmt(bases[baseKey], alpha) + ' !important;');
        });
        out.push('  --apb-accent: ' + rgbToHex(rgb) + ';');
        out.push('  --apb-accent-rgb: ' + rgb.join(', ') + ';');
        out.push('}');
        return out.join('\n');
    }

    /**
     * 解析当前生效的颜色。
     * 返回 { hex, rgb:[r,g,b], source } —— source 说明颜色从哪来，
     * 面板上会把它显示出来，方便排查"为什么颜色不对"。
     */
    function resolveAccent() {
        /* 只有两种来源：自选颜色 / 跟随主题。
         * 原来的第三项"保持原样"已移除 —— 它把"要不要上色"和"上什么色"
         * 两件事搅在一起（选了它整块光晕都不生成），逻辑容易错乱。 */
        if (state.accentMode === 'custom') {
            var c = state.accentRgb || {};
            var rgb = [
                clampByte(c.r, 236),
                clampByte(c.g, 65),
                clampByte(c.b, 65)
            ];
            return { hex: rgbToHex(rgb), rgb: rgb, source: '自选颜色' };
        }

        /* 其余一律按"跟随主题"处理。 */
        if (state.themeMode === 'custom') {
            var t = state.themeRgb || {};
            var trgb = [clampByte(t.r, 236), clampByte(t.g, 65), clampByte(t.b, 65)];
            return {
                hex: rgbToHex(trgb), rgb: trgb,
                source: '本插件的自定义主题色'
            };
        }

        /* 其次：GlassTheme 的变量 */
        var gtHex = cssVar('--gt-accent-hex');
        var g1 = parseColor(gtHex);
        if (g1) return { hex: rgbToHex(g1), rgb: g1, source: 'GlassTheme (--gt-accent-hex)' };

        var g2 = parseColor(cssVar('--gt-accent'));
        if (g2) return { hex: rgbToHex(g2), rgb: g2, source: 'GlassTheme (--gt-accent)' };

        /* 最后退到客户端自己的主题色变量。
         * 注意这些值是 rgba() 形式，必须走 parseColor 而不是 hexToRgb。
         *
         * ⚠⚠ 顺序很关键：`--colorPrimary1` 才是**软件当前的主题色**
         *   （实测默认 rgba(255,58,58,1) = #FF3A3A，正是原版那个红）。
         *   早期把 `--colorSecondary2_2` 排在最前是错的 —— 那是个蓝色
         *   装饰色（实测 #5E7CBD），跟"软件主题色"根本不是一回事。
         *   后果：「跟随主题」取到蓝色，点「恢复默认」也回不到原版红。
         */
        var clientVars = [
            '--colorPrimary1',         // 软件当前主题色（默认 #FF3A3A）
            '--colorSecondary1_1',     // 次级强调色（同色系）
            '--colorSecondary2_2'      // 蓝色装饰色，只在前两者都读不到时兜底
        ];
        for (var i = 0; i < clientVars.length; i++) {
            var got = parseColor(cssVar(clientVars[i]));
            if (got) {
                return { hex: rgbToHex(got), rgb: got, source: '客户端 ' + clientVars[i] };
            }
        }

        /* 连客户端变量都读不到时，兜底用网易云的原版主题色 */
        return { hex: '#ff3a3a', rgb: [255, 58, 58], source: '内置兜底（未读到主题变量）' };
    }

    /* ------------------------------------------------------------
     * 一、播放栏透明（原 PlayBarTransparent）
     *
     * 只改播放栏自身的背景，不碰进度条。
     * barEnabled 关闭时返回空串，整节不生成。
     * ---------------------------------------------------------- */
    function buildBarCss() {
        if (!state.barEnabled) return '';

        var bg = 'rgba(0, 0, 0, ' + clamp(state.opacity, 0, 1, 0.1) + ')';
        var blur = clamp(state.blur, 0, 60, 5);
        var L = [];

        L.push('/* AdvancedPlayBar — 透明播放栏 */');

        /* 播放栏本体。两种选择器都写上：
         * - .default-bar-wrapper 静态类名，最稳
         * - [class*=...] 包含匹配，修正 BGEnhanced 的 ^= 错误
         * 用 :is() 合并，保证权重一致 */
        L.push(':is(.default-bar-wrapper, [class*="DefaultBarWrapper_"]) {');
        L.push('  background: ' + bg + ' !important;');
        L.push('  background-color: ' + bg + ' !important;');
        L.push('  background-image: none !important;');
        if (blur > 0) {
            L.push('  backdrop-filter: blur(' + blur + 'px) !important;');
            L.push('  -webkit-backdrop-filter: blur(' + blur + 'px) !important;');
        }
        L.push('}');

        /* 已知的祖先/背景容器在 3.1.40 上本来就是透明的，
         * 但别的版本或皮肤可能给它们上色，顺手一起清掉。
         * 全部用 *= 或静态类名，不用 ^= */
        L.push(':is(.default-bar-wrapper, [class*="DefaultBarWrapper_"]) :is(.default-bar-bg, [class*="BarBG"], [class*="bar-bg"]) {');
        L.push('  background: transparent !important;');
        L.push('}');

        /* 顺带把 BGEnhanced 那个坏掉的开关也补上：万一它打开了
         * prefab-transparency 但仍不生效，这里用正确选择器兜住 */
        L.push('.prefab-transparency :is(.default-bar-wrapper, [class*="DefaultBarWrapper_"]) {');
        L.push('  background: ' + bg + ' !important;');
        L.push('}');

        return L.join('\n');
    }

    /* ------------------------------------------------------------
     * 二、主题色（全局，独立于两个功能开关）
     * ---------------------------------------------------------- */

    /* ------------------------------------------------------------
     * 三、进度条（原 PlayBarHover）
     * ---------------------------------------------------------- */
    function buildHoverCss() {
        if (!state.hoverEnabled) return '';

        var d = clamp(state.duration, 0, 1000, 180);
        var ease = 'cubic-bezier(0.22, 0.61, 0.36, 1)';   // ease-out 的柔和版
        var L = [];

        L.push('/* AdvancedPlayBar — 进度条：仅作用于 #page_pc_mini_bar 内');
        L.push(' * 注意：网易云 3.x 的 CEF 是 Chromium 91，');
        L.push(' * :has() 要 Chrome 105 才支持，这里一律不能用 ——');
        L.push(' * 带 :has() 的选择器整条规则会被直接丢弃。 */');

        /* 主题色：按 accentMode 决定来源。
         * 'native' 时不写这两个变量（下面的规则也不会用它们），
         * 于是客户端原本的颜色和阴影原封不动。 */
        var acc = resolveAccent();
        var accHex = acc.hex || '#ff3a3a';
        var accRgb = acc.rgb ? acc.rgb.join(', ') : '236, 65, 65';

        /* 光晕/遮罩统一用这个颜色。resolveAccent 现在一定返回一个颜色
         * （最差也有内置兜底），所以这里不再需要第二套取色逻辑。 */
        var baseRgb = acc.rgb || [236, 65, 65];
        var ar = baseRgb[0], ag = baseRgb[1], ab = baseRgb[2];
        function lit(alpha) {
            return 'rgba(' + ar + ',' + ag + ',' + ab + ',' + alpha + ')';
        }

        L.push(SCOPE + ' {');
        L.push('  --apb-accent: ' + accHex + ';');
        L.push('  --apb-accent-rgb: ' + accRgb + ';');
        L.push('  --apb-dur: ' + d + 'ms;');
        L.push('  --apb-ease: ' + ease + ';');
        L.push('}');

        /* ------------------------------------------------------------
         * 1. 给进度条整条链路加过渡
         *
         * 悬停时客户端会改高度、显影 thumb、弹时间轴 —— 具体是改哪个
         * 属性还没完全确定，所以这里对**最可能变化**的属性统一加过渡。
         * 用 :where() 把权重压到 0，需要时随时能被覆盖。
         * ---------------------------------------------------------- */
        L.push(':where(' + SCOPE + ' .slider-default),');
        L.push(':where(' + SCOPE + ' .slider-default > *) {');
        L.push('  transition:');
        L.push('    height var(--apb-dur) var(--apb-ease),');
        L.push('    min-height var(--apb-dur) var(--apb-ease),');
        L.push('    width var(--apb-dur) var(--apb-ease),');
        L.push('    padding var(--apb-dur) var(--apb-ease),');
        L.push('    margin var(--apb-dur) var(--apb-ease),');
        L.push('    opacity var(--apb-dur) var(--apb-ease),');
        L.push('    background-color var(--apb-dur) var(--apb-ease),');
        L.push('    box-shadow var(--apb-dur) var(--apb-ease),');
        L.push('    border-radius var(--apb-dur) var(--apb-ease),');
        L.push('    filter var(--apb-dur) var(--apb-ease),');
        L.push('    transform var(--apb-dur) var(--apb-ease) !important;');
        L.push('}');

        /* ------------------------------------------------------------
         * 2. 轨道外观
         * ---------------------------------------------------------- */
        L.push(':where(' + SCOPE + ' .slider-default) {');
        L.push('  border-radius: 999px;');
        L.push('}');

        L.push(':where(' + SCOPE + ' .slider-default .cache) {');
        L.push('  border-radius: 999px;');
        L.push('  background: rgba(255, 255, 255, 0.08);');
        L.push('}');

        /* 已播进度条上色。
         *
         * ⚠ 关键：客户端用 **background-image 渐变** 画已播条
         *   （实测 linear-gradient(270deg, rgb(252,61,73) ...)），
         *   而 background-color 是透明的。渐变绘制在颜色**之上**，
         *   所以只设 background/background-color 是**看不见效果的**——
         *   必须显式 background-image: none 把渐变清掉。
         *   这就是"进度条颜色选了自选色但只有小白点变色"的根因。 */
        L.push(':where(' + SCOPE + ' .slider-default .track) {');
        L.push('  border-radius: 999px;');
        L.push('  background-color: var(--apb-accent) !important;');
        L.push('  background-image: none !important;');
        L.push('  opacity: 0.9;');
        L.push('}');

        /* 副歌标记点：实测 --mark-color: var(--colorWhite1)，让它跟随主题色 */
        /* ⚠⚠ 每个 :where() 必须**各自闭合**，逗号放在 :where() 之间。
         * 曾经的写法 :where(a, :where(b, :where(c) {  —— 括号永不闭合，
         * 浏览器的 CSS 解析器会把**后续所有规则**当成这个选择器的一部分
         * 整段吞掉（遮罩覆盖就是这么被吃掉的，表现为"只有保持原样时
         * 光晕才生效"）。这类错误不报错、不警告，只是静默失效。 */
        L.push(':where(' + SCOPE + ' .slider-default [class*="ChorusMark"]),');
        L.push(':where(' + SCOPE + ' .slider-default [class*="chorus-mark"]) {');
        L.push('  --mark-color: var(--apb-accent) !important;');
        L.push('  background-color: var(--apb-accent) !important;');
        L.push('}');

        /* ------------------------------------------------------------
         * 3. 白点（.thumb）
         *
         * 实测它的 background 是 rgb(255,255,255)，尺寸 0x0（未悬停时
         * 不显示），宽度由客户端用内联 width 控制。
         *
         * ⚠ 这里刻意【不设 width/height/min-width】：
         *   白点的水平位置靠内联 width 或 transform 定位，我们一旦改
         *   尺寸就会让它偏离播放位置。只改颜色和光晕，尺寸交给客户端。
         * ---------------------------------------------------------- */
        L.push(':where(' + SCOPE + ' .slider-default .thumb) {');
        L.push('  background: var(--apb-accent) !important;');
        L.push('  box-shadow:');
        L.push('    0 0 0 2px rgba(255, 255, 255, 0.16),');
        L.push('    0 0 10px 2px rgba(var(--apb-accent-rgb), 0.55),');
        L.push('    0 0 22px 6px rgba(var(--apb-accent-rgb), 0.28) !important;');
        L.push('}');

        /* ------------------------------------------------------------
         * 4. 把悬停时扩散的黑影换成主题色柔光
         *
         * 实测播放栏子树里没有任何元素的 box-shadow 是非 none 的、
         * 也没有非 0s 的 transition —— 所以那个"黑影"只可能出现在
         * 悬停时才生成的东西上。这里按几种可能的承载者分别处理，
         * 全部用悬停态选择器，不影响常态。
         *
         * accentMode 已经没有"保持原样"这一项了，这一节只受 glow 控制。
         * ---------------------------------------------------------- */
        if (state.glow) {
            /* 4a. 进度条本体的悬停光晕。
             *
             * ⚠ 实测有个独立的 .MinibarHoverMask 悬停遮罩（1562x200，
             *   z-index:-1），意味着进度条自己可能收不到 :hover。
             *   所以这里把"自己悬停"和"父容器悬停"都写上，两条路都覆盖。 */
            L.push(SCOPE + ' .slider-default:hover,');
            L.push(SCOPE + ' .cmd-space:hover > .slider-default,');
            L.push(SCOPE + ' [class*="SpaceContainer"]:hover > .slider-default {');
            L.push('  box-shadow: 0 0 16px rgba(var(--apb-accent-rgb), 0.38),');
            L.push('              0 0 2px rgba(var(--apb-accent-rgb), 0.55) !important;');
            L.push('  border-radius: 999px;');
            L.push('}');
            /* 同时给 track 补一层，保证"上下扩散"的感觉是主题色而不是黑 */
            L.push(SCOPE + ' .slider-default:hover .track,');
            L.push(SCOPE + ' .cmd-space:hover > .slider-default .track {');
            L.push('  box-shadow: 0 0 12px rgba(var(--apb-accent-rgb), 0.45) !important;');
            L.push('}');

            /* 4b. 悬停遮罩的覆盖**不在这里** —— 它已移到下面独立的一节。
             * 原先它挂在这个 if（要求 useAccent）里面，导致"进度条颜色"
             * 一选「保持原样」，遮罩覆盖就整个不生成，「主题色柔光」开关
             * 怎么点都没反应。现在它只受 glow 和 maskGlow 控制。 */

            /* 4c. 兜底：悬停时进度条所有子元素的投影一律清掉，
             *     只保留 thumb 的主题色光晕（4d 再补回来）。 */
            L.push(SCOPE + ' .slider-default:hover > *,');
            L.push(SCOPE + ' .cmd-space:hover > .slider-default > * {');
            L.push('  box-shadow: none !important;');
            L.push('}');

            /* 4d. thumb 的光晕在所有悬停路径下都成立 */
            L.push(SCOPE + ' .slider-default:hover .thumb,');
            L.push(SCOPE + ' .cmd-space:hover > .slider-default .thumb {');
            L.push('  box-shadow:');
            L.push('    0 0 0 2px rgba(255, 255, 255, 0.16),');
            L.push('    0 0 10px 2px rgba(var(--apb-accent-rgb), 0.55),');
            L.push('    0 0 22px 6px rgba(var(--apb-accent-rgb), 0.28) !important;');
            L.push('}');
        }

        /* ------------------------------------------------------------
         * 4x. 悬停遮罩 —— "上下扩散黑光"的真身（独立一节）
         *
         * 实测（probe-glow.js / probe-ab.js）：
         *   div.MinibarHoverMask_mvfuu0n  1562x200 @644
         *     常态 opacity=0，悬停 opacity=1（JS 淡入）
         *     可见背景来自变量 --minibar-hover--mask-bg：
         *       linear-gradient(180deg, rgba(0,0,0,0) 0%, ...,
         *                       rgba(0,0,0,0.55) 50%, rgba(0,0,0,0.96) 81.25%, ...)
         *     它自己的 box-shadow / filter 本来就是 none
         *   => 改 box-shadow/filter 无效，必须换掉**变量本身**
         *   => A/B 实测确认：变量覆盖 + !important 能压过 <html> 内联样式
         *
         * ⚠ 这一节**不能**放进上面的 useAccent 分支！
         *   否则"进度条颜色"一选「保持原样」，遮罩覆盖就整个不生成，
         *   表现为「主题色柔光」开关怎么点都没反应（用户实际踩到的）。
         *   它只受 state.glow 与 state.maskGlow 控制。
         * ---------------------------------------------------------- */
        if (state.glow) {
            var mg = clamp(state.maskGlow, 0, 1, 0.05);
            var stops = [0, 0.06, 0.12, 0.24, 0.35, 0.53, 0.71, 0.88, 1];

            /* 主手段：覆盖变量本身（声明在 <html> 内联 style 上）。
             * 用**字面量 RGB** —— 这一节写在 html/:root 上，而
             * --apb-accent-rgb 定义在其后代 #page_pc_mini_bar 上，
             * 变量只向下继承，在 html 上 var() 会解析失败变无效值。 */
            L.push('html, :root, body, ' + SCOPE + ' {');
            L.push('  --minibar-hover--mask-bg: linear-gradient(180deg,');
            stops.forEach(function (frac, idx) {
                var a = +(mg * frac).toFixed(3);
                L.push('    ' + lit(a) + ' ' + (idx * 12.5) + '%' +
                    (idx === stops.length - 1 ? ') !important;' : ','));
            });
            L.push('}');

            /* 第二手段：直接盖遮罩元素自己的 background-image。
             * A/B 实测这条同样有效，留着做双保险 —— 万一以后客户端
             * 不再从变量取值，这条还能兜住。 */
            L.push(SCOPE + ' [class*="MinibarHoverMask"] {');
            L.push('  box-shadow: none !important;');
            L.push('  filter: none !important;');
            L.push('  background-image: linear-gradient(180deg,');
            L.push('    ' + lit(0) + ' 0%,');
            L.push('    ' + lit(+(mg * 0.35).toFixed(3)) + ' 50%,');
            L.push('    ' + lit(+mg.toFixed(3)) + ' 100%) !important;');
            L.push('}');
        }

        /* ------------------------------------------------------------
         * 5. 时间轴浮层
         *
         * 实测真实类名（我前几版猜的 tooltip / preview 全都猜错了）：
         *   .curtime-thumb.TimeWarpper_t1eityq1          容器，悬停时 16x28
         *   └ button.cmd-button.cmd-button-surfacePri...  浮层本体，108x28
         *      └ span.cmd-button-content                  文字 78x14
         *
         * 悬停时容器从 0x0 变成 16x28，位置用内联 --t1eityq1-0 控制。
         * 这里只改外观，不碰尺寸和定位。
         * ---------------------------------------------------------- */
        var tipSelectors = [
            SCOPE + ' [class*="TimeWarpper"]',
            SCOPE + ' .curtime-thumb',
            /* 兜底：万一以后类名变了 */
            SCOPE + ' .slider-default [class*="tooltip"]',
            SCOPE + ' .slider-default [class*="Tooltip"]',
            SCOPE + ' .slider-default [class*="preview"]',
            SCOPE + ' .slider-default [class*="Preview"]'
        ];
        /* 容器（.curtime-thumb / TimeWarpper）只有 16x28 —— 它是贴在圆点上
         * 的一个窄条，浮层本体（108x28 的 button）在它里面、文字再居中。
         * 把玻璃背景画在容器上，看起来就是"时间文字左边凭空多出一个小胶囊"，
         * 而不是把文字包住（用户实测就是这个现象）。所以容器一律透明。 */
        L.push(tipSelectors.join(', ') + ' {');
        L.push('  background: transparent !important;');
        L.push('  background-image: none !important;');
        L.push('  border: none !important;');
        L.push('  box-shadow: none !important;');
        L.push('  backdrop-filter: none !important;');
        L.push('  -webkit-backdrop-filter: none !important;');
        L.push('  pointer-events: none;');
        L.push('}');

        /* 浮层本体才是要"被包裹"的那个盒子 —— 玻璃背景放这里，
         * 圆角与投影才会正好框住时间文字。 */
        var tipBox = [];
        tipSelectors.forEach(function (s) {
            tipBox.push(s + ' button');
            tipBox.push(s + ' .cmd-button');
            /* ⚠⚠ 这里**不能**写 [class*="cmd-button"]。
             * 文字所在的 span 类名是 `.cmd-button-content`，也含
             * "cmd-button" 这个子串 —— 用 *= 匹配会把它一起套上背景和
             * 边框，于是时间文字外面出现**两层圆角框**（实测踩到）。
             * 只认真正的按钮：元素名 button + 精确类名 .cmd-button。 */
        });
        L.push(tipBox.join(',\n') + ' {');
        L.push('  background: rgba(28, 28, 34, 0.72) !important;');
        L.push('  background-image: none !important;');
        L.push('  backdrop-filter: blur(14px) saturate(1.6) !important;');
        L.push('  -webkit-backdrop-filter: blur(14px) saturate(1.6) !important;');
        L.push('  border: 1px solid rgba(255, 255, 255, 0.14) !important;');
        L.push('  border-radius: 10px !important;');
        L.push('  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.34),');
        L.push('              0 0 0 1px rgba(var(--apb-accent-rgb), 0.12) !important;');
        L.push('  color: rgba(255, 255, 255, 0.96) !important;');
        L.push('  font-variant-numeric: tabular-nums;');
        L.push('}');

        /* 浮层内部的文字节点只负责排版，**一律不许再有背景/边框/投影**
         * —— 双保险：就算以后客户端给内层元素加了别的类名，也不会再套一层。 */
        var tipInner = [];
        tipSelectors.forEach(function (s) {
            tipInner.push(s + ' span');
            tipInner.push(s + ' button > *');
        });
        L.push(tipInner.join(',\n') + ' {');
        L.push('  background: none !important;');
        L.push('  background-image: none !important;');
        L.push('  border: none !important;');
        L.push('  box-shadow: none !important;');
        L.push('  color: rgba(255, 255, 255, 0.96) !important;');
        L.push('  font-size: 12px !important;');
        L.push('  line-height: 1.3 !important;');
        L.push('  font-variant-numeric: tabular-nums;');
        L.push('}');

        /* ------------------------------------------------------------
         * 6. 章节点：默认高度 0，先确保不挡鼠标
         * ---------------------------------------------------------- */
        L.push(':where(' + SCOPE + ' .slider-default .dots) {');
        L.push('  pointer-events: none;');
        L.push('}');

        /* 尊重系统"减少动态效果" */
        L.push('@media (prefers-reduced-motion: reduce) {');
        L.push('  :where(' + SCOPE + ' .slider-default),');
        L.push('  :where(' + SCOPE + ' .slider-default > *) {');
        L.push('    transition-duration: 1ms !important;');
        L.push('  }');
        L.push('}');

        return L.join('\n');
    }

    /* ------------------------------------------------------------
     * 汇总：三段拼起来
     *
     * ⚠ 主题色单独一段，**不放进** buildHoverCss —— 它是全局设置，
     *   不该被"进度条"那个开关连带关掉。
     * ---------------------------------------------------------- */
    function buildCss() {
        var parts = [
            buildBarCss(),
            themeCss(),
            buildHoverCss()
        ].filter(function (s) { return s; });

        return parts.join('\n');
    }

    function ensureStyle() {
        if (!styleEl || !styleEl.isConnected) {
            styleEl = document.getElementById(STYLE_ID);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = STYLE_ID;
                (document.head || document.documentElement).appendChild(styleEl);
            }
        }
        /* ⚠⚠ 顺序必须是「先清空 → 再生成 → 最后写入」。
         *
         * buildCss() 会读 CSS 变量来解析"跟随主题"的颜色（resolveAccent），
         * 而上一次注入的样式里可能正覆盖着那些变量。如果先 build 再写，
         * 读到的就是**自己上一次写进去的值** —— 于是把「全局主题色」改成
         * 不干预之后，进度条的「跟随主题」仍然攥着上一次的自选色不放，
         * 而不是回落到网易云原生色。
         *
         * 先清空，变量立刻回落到客户端的原生值，读到的才是真·原生色。 */
        styleEl.textContent = '';
        styleEl.textContent = buildCss();
        return styleEl;
    }

    /* ------------------------------------------------------------
     * 播放栏透明的兼容模式：内联样式 + 监听重渲染
     *
     * 主防线是 CSS 选择器（见 buildBarCss）。但如果有别的插件写了
     * 权重更高的 !important，CSS 会输，算出来的背景仍然不透明。
     * 兼容模式就是对付这种情况的：直接把样式写到元素身上，绕开层叠。
     *
     * ⚠ 只服务「透明播放栏」这一节，与进度条动效无关
     *   （动效靠样式表就够了，不需要内联兜底）。
     *
     * ⚠⚠⚠ 这一段有两个血泪教训，改之前务必读完：
     *
     * 【教训一】不要用 getComputedStyle 判断"CSS 有没有生效"。
     *   那个值里包含**我们自己写进去的内联样式**。只要内联样式在，
     *   读出来永远是"已透明"，就被误判成"CSS 生效了" → 清掉内联样式
     *   → 又变回不透明 → 下次再写回来 —— 一写一清来回抖（透明闪烁）。
     *
     * 【教训二】更不要"临时摘掉自己的内联样式量一次再还回去"。
     *   因为 **MutationObserver 的回调是异步微任务**：等回调跑起来时，
     *   "正在测量"的标志早复位了，于是测量本身又触发下一轮回调 ——
     *   每次回调改 8 次 style、再排一个微任务，**无限循环、主线程卡死**。
     *   （实测：装上后网易云几秒内未响应。）
     *
     * 【现在的做法】不做任何测量，直接按配置把值写到位；
     *   **值已经对了就一个字节都不改** —— 不产生 MutationRecord，
     *   observer 自然不会被唤醒，循环无从发生。
     * ---------------------------------------------------------- */

    /* 我们自己会写的那几个属性 */
    var INLINE_PROPS = ['background-color', 'background-image',
        'backdrop-filter', '-webkit-backdrop-filter'];

    function applyInline() {
        if (!state.compatMode || !state.barEnabled) return;
        if (!barEl || !barEl.isConnected) return;

        var bg = 'rgba(0, 0, 0, ' + clamp(state.opacity, 0, 1, 0.1) + ')';
        var blur = clamp(state.blur, 0, 60, 5);

        /* 期望值表：写哪个属性、写成什么 */
        var wanted = {
            'background-color': bg,
            'background-image': 'none'
        };
        if (blur > 0) {
            wanted['backdrop-filter'] = 'blur(' + blur + 'px)';
            wanted['-webkit-backdrop-filter'] = 'blur(' + blur + 'px)';
        }

        INLINE_PROPS.forEach(function (p) {
            var want = wanted[p];
            var cur = barEl.style.getPropertyValue(p);

            if (want === undefined) {
                /* 这次不需要这个属性（例如毛玻璃关掉了），有残留就清掉 */
                if (cur) {
                    barEl.style.removeProperty(p);
                    inlineApplied = true;
                }
                return;
            }
            /* ⚠ 只有真的不一样才写 —— 这是不产生死循环的关键 */
            if (cur !== want) {
                barEl.style.setProperty(p, want, 'important');
                inlineApplied = true;
            }
        });
    }

    function clearInline() {
        if (!barEl || !barEl.isConnected || !inlineApplied) return;
        barEl.style.removeProperty('background-color');
        barEl.style.removeProperty('background-image');
        barEl.style.removeProperty('backdrop-filter');
        barEl.style.removeProperty('-webkit-backdrop-filter');
        inlineApplied = false;
    }

    /* ------------------------------------------------------------
     * 保险丝
     *
     * applyInline 在值已正确时不改动 style，理论上 observer 不会被自己
     * 反复唤醒。但"卡死客户端"这个后果太严重，值得留一道闸：短时间內
     * 回调过于频繁就直接停掉 observer（CSS 那条主防线还在，功能不受影响），
     * 而不是把主线程拖死。
     *
     * 失败方向是安全的：停掉只是少了兜底，不会让情况更糟。
     * ---------------------------------------------------------- */
    var obsHits = 0;
    var obsWindowStart = 0;
    var OBS_LIMIT = 60;          // 1 秒内最多 60 次
    var OBS_WINDOW = 1000;

    function observerTripped() {
        var now = Date.now();
        if (now - obsWindowStart > OBS_WINDOW) {
            obsWindowStart = now;
            obsHits = 0;
        }
        obsHits++;
        if (obsHits > OBS_LIMIT) {
            console.warn('[AdvancedPlayBar] 播放栏监听触发过于频繁，已暂停内联兜底' +
                '（CSS 仍然生效；改动任意设置可重新启用）');
            if (observer) { observer.disconnect(); observer = null; }
            obsHits = 0;
            return true;
        }
        return false;
    }

    function startObserver() {
        if (observer) return;
        obsHits = 0;
        obsWindowStart = Date.now();
        observer = new MutationObserver(function () {
            /* 兼容模式没开就无事可做 —— 先短路。
             * 这道短路必须放在熔断计数**之前**：客户端平时会高频改 DOM
             * （播放时进度条每帧都在变），不计入就不会误报"触发过于频繁"。 */
            if (!state.barEnabled || !state.compatMode) return;
            if (observerTripped()) return;
            /* React 重渲染会把内联样式抹掉，这里立刻补回来。
             * 只改我们自己设过的那几个属性，不动别人的。
             * （applyInline 在值已正确时不会改动 style，所以这里不会自触发） */
            if (!barEl || !barEl.isConnected) {
                var next = document.querySelector(BAR_SELECTORS);
                if (next) {
                    barEl = next;
                    applyInline();
                }
                return;
            }
            applyInline();
        });
        try {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class']
            });
        } catch (e) { /* body 还没准备好等极端情况，忽略 */ }
    }

    /* 播放栏那一半的"应用"：找元素 + 上兜底 */
    function applyBar() {
        if (!state.barEnabled) {
            clearInline();
            return;
        }
        barEl = document.querySelector(BAR_SELECTORS);
        if (barEl) {
            applyInline();
        }
    }

    /* ------------------------------------------------------------
     * 诊断：把迷你栏进度条的真实情况报出来
     *
     * 面板上**不再显示它**（那属于开发调试信息）。保留这个函数是为了
     * 控制台排查与本地测试：window.__advancedPlayBar.inspect() 随时可调。
     * ---------------------------------------------------------- */
    function inspect() {
        var rows = [];
        function push(label, sel, extra) {
            var n = document.querySelectorAll(sel).length;
            rows.push({ label: label, sel: sel, count: n, extra: extra });
        }

        /* ── 播放栏（透明那一节的目标）── */
        push('播放栏本体（静态类名 .default-bar-wrapper）', '.default-bar-wrapper');
        push('播放栏本体（[*=] 修正写法）', '[class*="DefaultBarWrapper_"]');
        /* ^= 是 BGEnhanced 那个失效的写法，列出来是为了对照 —— 它必然是 0 */
        push('播放栏本体（^= 旧写法，预期 0）', '[class^="DefaultBarWrapper_"]',
            'BGEnhanced「预制全透明」失效的原因');

        /* ── 进度条 ── */
        push('迷你播放条容器', SCOPE);
        push('进度条本体', SCOPE + ' .slider-default');
        push('已播进度 track', SCOPE + ' .slider-default .track');
        push('缓冲 cache', SCOPE + ' .slider-default .cache');
        push('白点 thumb', SCOPE + ' .slider-default .thumb');
        push('悬停热区 hotzone-overlay', SCOPE + ' .hotzone-overlay');
        push('章节点 dots', SCOPE + ' .slider-default .dots');
        push('悬停遮罩 MinibarHoverMask', SCOPE + ' [class*="MinibarHoverMask"]');

        var tipN = document.querySelectorAll(
            SCOPE + ' [class*="TimeWarpper"], ' + SCOPE + ' .curtime-thumb'
        ).length;
        rows.push({
            label: '时间轴浮层', sel: SCOPE + ' [class*="TimeWarpper"]',
            count: tipN, extra: tipN ? '' : '未悬停时通常为 0'
        });

        var bar = document.querySelector(SCOPE + ' .slider-default');
        var detail = '';
        if (bar) {
            var cs = getComputedStyle(bar);
            detail = '进度条 height=' + cs.height + '  radius=' + cs.borderRadius +
                '  transition=' + cs.transition.split(',')[0];
        }
        /* 播放栏实际背景：透明是否生效，看这一行 */
        var b = document.querySelector(BAR_SELECTORS);
        if (b) {
            var bcs = getComputedStyle(b);
            detail += (detail ? '  |  ' : '') + '播放栏 background=' + bcs.backgroundColor +
                '  (启用=' + state.barEnabled + ' 兼容模式=' + state.compatMode +
                ' 内联已写=' + inlineApplied + ')';
        }
        return { rows: rows, detail: detail };
    }

    /* ------------------------------------------------------------
     * 配置面板
     * ---------------------------------------------------------- */

    /** 在外部浏览器打开链接（上架准则要求面板里的链接可点击跳转） */
    function openExternal(url) {
        var b = api();
        try {
            if (b && b.ncm && typeof b.ncm.openUrl === 'function') {
                b.ncm.openUrl(url);
                return;
            }
        } catch (e) { /* 继续走兜底 */ }
        try {
            if (typeof window !== 'undefined' && window.open) window.open(url, '_blank');
        } catch (e2) { /* 打不开就算了，不能因为一个链接把面板搞崩 */ }
    }

    /** 面板底部的源码仓库 / 问题反馈入口 */
    function buildLinks() {
        var wrap = el('div', {
            marginTop: '22px', paddingTop: '14px',
            borderTop: '1px solid rgba(128,128,128,0.18)',
            fontSize: '12.5px', display: 'flex', alignItems: 'center',
            gap: '16px', flexWrap: 'wrap', opacity: '0.85'
        });

        function link(text, url) {
            var a = el('span', {
                cursor: 'pointer', textDecoration: 'underline',
                color: 'rgba(255,120,120,0.95)'
            }, text);
            a.addEventListener('click', function () { openExternal(url); });
            return a;
        }

        wrap.appendChild(link('源码仓库', REPO_URL));
        wrap.appendChild(link('问题反馈', ISSUES_URL));
        return wrap;
    }

    function el(tag, style, text) {
        var e = document.createElement(tag);
        if (style) Object.keys(style).forEach(function (k) { e.style[k] = style[k]; });
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function button(text, primary) {
        return el('button', {
            padding: '7px 16px', borderRadius: '9px', cursor: 'pointer',
            fontSize: '13px', fontFamily: 'inherit',
            border: '1px solid rgba(128,128,128,0.35)',
            background: primary ? 'rgba(236,65,65,0.92)' : 'rgba(128,128,128,0.14)',
            color: primary ? '#fff' : 'inherit'
        }, text);
    }

    function row(label, control, hint) {
        var wrap = el('div', {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '12px', padding: '10px 0',
            borderBottom: '1px solid rgba(128,128,128,0.18)'
        });
        var left = el('div', { minWidth: '160px' });
        left.appendChild(el('div', { fontSize: '14px', fontWeight: '600' }, label));
        if (hint) left.appendChild(el('div', { fontSize: '11.5px', opacity: '0.6', marginTop: '2px' }, hint));
        wrap.appendChild(left);
        var right = el('div', { display: 'flex', alignItems: 'center', gap: '10px', flex: '1', justifyContent: 'flex-end' });
        right.appendChild(control);
        wrap.appendChild(right);
        return wrap;
    }

    function slider(min, max, step, value, onInput, fmt) {
        var box = el('div', { display: 'flex', alignItems: 'center', gap: '10px', flex: '1', justifyContent: 'flex-end' });
        var input = el('input', { flex: '1', maxWidth: '220px' });
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        var out = el('span', {
            minWidth: '56px', textAlign: 'right', fontSize: '12.5px',
            fontVariantNumeric: 'tabular-nums', opacity: '0.85'
        }, fmt ? fmt(value) : String(value));
        input.addEventListener('input', function () {
            var v = Number(input.value);
            out.textContent = fmt ? fmt(v) : String(v);
            onInput(v);
        });
        box.appendChild(input);
        box.appendChild(out);
        return box;
    }

    function toggleRow(label, key, hint) {
        var b = button(state[key] ? '开' : '关', state[key]);
        b.addEventListener('click', function () {
            var patch = {};
            patch[key] = !state[key];
            update(patch);
            b.textContent = state[key] ? '开' : '关';
            b.style.background = state[key] ? 'rgba(236,65,65,0.92)' : 'rgba(128,128,128,0.14)';
            b.style.color = state[key] ? '#fff' : 'inherit';
        });
        return row(label, b, hint);
    }

    /* ------------------------------------------------------------
     * PS 风格取色器：色相条 + 正方形（横轴 S 饱和度 / 纵轴 V 明度）
     *
     * opts.modeKey   哪个配置项控制启用（如 'accentMode'）
     * opts.rgbKey    色值存哪个配置键（如 'accentRgb'）
     *
     * 用 2D canvas 手绘，不依赖 <input type="color"> —— 后者的外观
     * 由 Chromium 91 决定，塞不进面板也不可控。
     * ---------------------------------------------------------- */
    var PICKER_W = 236, PICKER_H = 150, HUE_W = 18, HUE_GAP = 10;

    function colorPicker(opts) {
        var cur = state[opts.rgbKey] || { r: 236, g: 65, b: 65 };
        var hsv = rgbToHsv(clampByte(cur.r, 236), clampByte(cur.g, 65), clampByte(cur.b, 65));

        var enabled = state[opts.modeKey] === 'custom';
        var wrap = el('div', {
            display: 'flex', gap: HUE_GAP + 'px', alignItems: 'flex-start',
            marginTop: '8px', opacity: enabled ? '1' : '0.42',
            pointerEvents: enabled ? 'auto' : 'none',
            transition: 'opacity 160ms ease'
        });

        /* --- 色相条 --- */
        var hueCanvas = el('canvas', {
            width: HUE_W + 'px', height: PICKER_H + 'px', flex: 'none',
            borderRadius: '8px', cursor: 'crosshair',
            border: '1px solid rgba(128,128,128,0.35)'
        });
        var hueCtx = hueCanvas.getContext ? hueCanvas.getContext('2d') : null;

        /* --- 右侧：正方形 + 底部信息 --- */
        var rightCol = el('div', { display: 'flex', flexDirection: 'column', gap: '8px' });

        var svCanvas = el('canvas', {
            width: PICKER_W + 'px', height: PICKER_H + 'px',
            borderRadius: '8px', cursor: 'crosshair',
            border: '1px solid rgba(128,128,128,0.35)'
        });
        var svCtx = svCanvas.getContext ? svCanvas.getContext('2d') : null;
        rightCol.appendChild(svCanvas);

        var infoRow = el('div', { display: 'flex', alignItems: 'center', gap: '10px' });

        var swatch = el('span', {
            width: '30px', height: '30px', borderRadius: '8px', flex: 'none',
            border: '1px solid rgba(128,128,128,0.4)',
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
        });
        infoRow.appendChild(swatch);

        var hexInput = el('input', {
            width: '92px', padding: '5px 8px', fontSize: '12.5px', fontFamily: 'inherit',
            textAlign: 'center', borderRadius: '8px'
        });
        hexInput.type = 'text';
        hexInput.spellcheck = false;
        infoRow.appendChild(hexInput);

        /* 客户端原色对照 —— 方便比对改成了什么 */
        var origSwatch = el('span', {
            width: '18px', height: '18px', borderRadius: '5px', flex: 'none',
            border: '1px solid rgba(128,128,128,0.4)'
        });
        var origLabel = el('span', { fontSize: '11.5px', opacity: '0.6' }, '');
        var origBox = el('div', { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' });
        origBox.appendChild(el('span', { fontSize: '11.5px', opacity: '0.6' }, '原色'));
        origBox.appendChild(origSwatch);
        origBox.appendChild(origLabel);
        infoRow.appendChild(origBox);

        rightCol.appendChild(infoRow);
        wrap.appendChild(hueCanvas);
        wrap.appendChild(rightCol);

        /* ---------------- 绘制 ---------------- */
        function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

        function drawHue() {
            if (!hueCtx) return;
            var d = dpr();
            hueCanvas.width = HUE_W * d;
            hueCanvas.height = PICKER_H * d;
            hueCanvas.style.width = HUE_W + 'px';
            hueCanvas.style.height = PICKER_H + 'px';
            hueCtx.setTransform(d, 0, 0, d, 0, 0);
            var g = hueCtx.createLinearGradient(0, 0, 0, PICKER_H);
            for (var i = 0; i <= 6; i++) {
                var rgb = hsvToRgb(i * 60, 1, 1);
                g.addColorStop(i / 6, 'rgb(' + rgb.join(',') + ')');
            }
            hueCtx.fillStyle = g;
            hueCtx.fillRect(0, 0, HUE_W, PICKER_H);
            /* 当前色相指示线 */
            var y = (hsv.h / 360) * PICKER_H;
            hueCtx.strokeStyle = 'rgba(255,255,255,0.95)';
            hueCtx.lineWidth = 2;
            hueCtx.beginPath();
            hueCtx.moveTo(0, y);
            hueCtx.lineTo(HUE_W, y);
            hueCtx.stroke();
            hueCtx.strokeStyle = 'rgba(0,0,0,0.45)';
            hueCtx.lineWidth = 1;
            hueCtx.beginPath();
            hueCtx.moveTo(0, y - 1.5);
            hueCtx.lineTo(HUE_W, y - 1.5);
            hueCtx.moveTo(0, y + 1.5);
            hueCtx.lineTo(HUE_W, y + 1.5);
            hueCtx.stroke();
        }

        function drawSV() {
            if (!svCtx) return;
            var d = dpr();
            svCanvas.width = PICKER_W * d;
            svCanvas.height = PICKER_H * d;
            svCanvas.style.width = PICKER_W + 'px';
            svCanvas.style.height = PICKER_H + 'px';
            svCtx.setTransform(d, 0, 0, d, 0, 0);

            /* 底色：当前色相的纯色 */
            var base = hsvToRgb(hsv.h, 1, 1);
            svCtx.fillStyle = 'rgb(' + base.join(',') + ')';
            svCtx.fillRect(0, 0, PICKER_W, PICKER_H);

            /* 横向：白 -> 透明（饱和度） */
            var gw = svCtx.createLinearGradient(0, 0, PICKER_W, 0);
            gw.addColorStop(0, 'rgba(255,255,255,1)');
            gw.addColorStop(1, 'rgba(255,255,255,0)');
            svCtx.fillStyle = gw;
            svCtx.fillRect(0, 0, PICKER_W, PICKER_H);

            /* 纵向：透明 -> 黑（明度） */
            var gb = svCtx.createLinearGradient(0, 0, 0, PICKER_H);
            gb.addColorStop(0, 'rgba(0,0,0,0)');
            gb.addColorStop(1, 'rgba(0,0,0,1)');
            svCtx.fillStyle = gb;
            svCtx.fillRect(0, 0, PICKER_W, PICKER_H);

            /* 光标：白色圆圈 + 内侧深色描边，深浅底上都看得见 */
            var cx = hsv.s * PICKER_W;
            var cy = (1 - hsv.v) * PICKER_H;
            svCtx.beginPath();
            svCtx.arc(cx, cy, 7, 0, Math.PI * 2);
            svCtx.strokeStyle = 'rgba(0,0,0,0.5)';
            svCtx.lineWidth = 3;
            svCtx.stroke();
            svCtx.beginPath();
            svCtx.arc(cx, cy, 7, 0, Math.PI * 2);
            svCtx.strokeStyle = 'rgba(255,255,255,0.98)';
            svCtx.lineWidth = 1.6;
            svCtx.stroke();
        }

        /* ---------------- 状态同步 ---------------- */
        function current() { return hsvToRgb(hsv.h, hsv.s, hsv.v); }

        /* 只刷显示，不写配置 —— 初始化用，避免打开面板就覆盖已有配置 */
        function render() {
            var rgb = current();
            var hex = rgbToHex(rgb);
            swatch.style.background = hex;
            if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
            drawHue();
            drawSV();
        }

        /* 刷显示 + 下发配置 */
        function commit() {
            var rgb = current();
            render();
            var patch = {};
            patch[opts.rgbKey] = { r: rgb[0], g: rgb[1], b: rgb[2] };
            update(patch);
            if (opts.onChange) opts.onChange(rgb);
        }

        /* ---------------- 拖拽 ---------------- */
        function bindDrag(canvas, onPos) {
            var dragging = false;
            function pos(ev) {
                var r = canvas.getBoundingClientRect();
                return {
                    x: Math.min(r.width - 0.01, Math.max(0, ev.clientX - r.left)),
                    y: Math.min(r.height - 0.01, Math.max(0, ev.clientY - r.top)),
                    w: r.width, h: r.height
                };
            }
            canvas.addEventListener('pointerdown', function (ev) {
                dragging = true;
                if (canvas.setPointerCapture) {
                    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { }
                }
                onPos(pos(ev));
                ev.preventDefault();
            });
            canvas.addEventListener('pointermove', function (ev) {
                if (!dragging) return;
                onPos(pos(ev));
            });
            ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
                canvas.addEventListener(t, function () { dragging = false; });
            });
        }

        bindDrag(hueCanvas, function (p) {
            hsv.h = (p.y / p.h) * 360;
            commit();
        });

        bindDrag(svCanvas, function (p) {
            hsv.s = p.x / p.w;
            hsv.v = 1 - (p.y / p.h);
            commit();
        });

        /* ---------------- hex 手输 ---------------- */
        hexInput.addEventListener('input', function () {
            var parsed = hexToRgb(hexInput.value.trim());
            if (!parsed) return;                    // 打了一半不处理
            var h2 = rgbToHsv(parsed.r, parsed.g, parsed.b);
            hsv.h = h2.h; hsv.s = h2.s; hsv.v = h2.v;
            render();
            var patch = {};
            patch[opts.rgbKey] = { r: parsed.r, g: parsed.g, b: parsed.b };
            update(patch);
            if (opts.onChange) opts.onChange([parsed.r, parsed.g, parsed.b]);
        });
        hexInput.addEventListener('blur', function () {
            hexInput.value = rgbToHex(current()).toUpperCase();
        });

        /* ---------------- 原色对照 ---------------- */
        function showOriginal(rgb) {
            if (!rgb) { origSwatch.style.display = 'none'; origLabel.textContent = ''; return; }
            var hex = rgbToHex(rgb);
            origSwatch.style.background = hex;
            origLabel.textContent = hex.toUpperCase();
        }
        if (opts.originalVar) {
            var raw = cssVar(opts.originalVar);
            var m = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            showOriginal(m ? [+m[1], +m[2], +m[3]] : null);
        } else {
            origBox.style.display = 'none';
        }

        render();   // 初始化只刷显示
        return wrap;
    }

    /* 二选一的模式选择（通用：进度条「颜色来源」/「主题色」的「应用范围」各用一份） */
    function modeRow(opts) {
        var seg = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
        var btns = {};
        opts.modes.forEach(function (m) {
            var b = button(m[1], state[opts.modeKey] === m[0]);
            btns[m[0]] = b;
            b.addEventListener('click', function () {
                var patch = {};
                patch[opts.modeKey] = m[0];
                update(patch);
                Object.keys(btns).forEach(function (k) {
                    var on = k === state[opts.modeKey];
                    btns[k].style.background = on ? 'rgba(236,65,65,0.92)' : 'rgba(128,128,128,0.14)';
                    btns[k].style.color = on ? '#fff' : 'inherit';
                });
                if (opts.onChange) opts.onChange();
            });
            seg.appendChild(b);
        });
        return row(opts.label, seg, opts.hint);
    }

    function buildPanel() {
        var root = el('div', {
            fontFamily: 'inherit', color: 'inherit',
            maxWidth: '660px', margin: '0', padding: '4px 0 24px',
            textAlign: 'left', fontSize: '14px', lineHeight: '1.5'
        });

        root.appendChild(el('div', { fontSize: '20px', fontWeight: '700', marginBottom: '10px' }, 'AdvancedPlayBar'));

        function rebuild() {
            host.textContent = '';
            host.appendChild(buildPanel());
        }

        /* ══════════ 一、透明播放栏（原 PlayBarTransparent）══════════
         * 与下面的「进度条」各有独立开关，互不影响，没有总开关。 */
        root.appendChild(el('div', {
            fontSize: '15px', fontWeight: '700', marginTop: '10px', marginBottom: '2px'
        }, '透明播放栏'));

        root.appendChild(toggleRow('启用', 'barEnabled', '关闭后播放栏恢复客户端原生背景'));
        root.appendChild(row('播放栏不透明度', slider(0, 1, 0.02, state.opacity, function (v) {
            update({ opacity: v });
        }, function (v) { return Math.round(v * 100) + '%'; }), '0% 为完全透明'));
        root.appendChild(row('毛玻璃', slider(0, 40, 1, state.blur, function (v) {
            update({ blur: v });
        }, function (v) { return v === 0 ? '关闭' : v + 'px'; }), '给播放栏加背景模糊，数值越大越糊'));
        root.appendChild(toggleRow('兼容模式', 'compatMode',
            '如果透明样式无效，可以尝试开启'));

        /* ══════════ 二、进度条（原 PlayBarHover）══════════ */
        root.appendChild(el('div', {
            fontSize: '15px', fontWeight: '700', marginTop: '28px', marginBottom: '2px'
        }, '进度条'));

        root.appendChild(toggleRow('启用', 'hoverEnabled', '关闭后进度条恢复客户端原生表现'));
        root.appendChild(toggleRow('主题色柔光', 'glow', '把悬停时扩散的黑影换成主题色光晕'));
        root.appendChild(row('光晕强度', slider(0, 0.6, 0.01, state.maskGlow, function (v) {
            update({ maskGlow: v });
        }, function (v) { return v === 0 ? '关闭' : Math.round(v * 100) + '%'; }),
            '悬停时播放条上方那层光晕的明显程度'));

        root.appendChild(row('动画时长', slider(60, 500, 10, state.duration, function (v) {
            update({ duration: v });
        }, function (v) { return v + 'ms'; }), '进度条悬停动画的持续时间'));

        /* 只有两种来源。原来的"保持原样"已移除 —— 它把"要不要上色"和
         * "上什么色"两件事搅在一起，容易出现"选了它光晕就不见了"的困惑。 */
        root.appendChild(modeRow({
            label: '颜色来源',
            modeKey: 'accentMode',
            hint: '进度条、圆点与光晕的颜色',
            modes: [['theme', '跟随主题'], ['custom', '自选颜色']],
            onChange: rebuild
        }));

        root.appendChild(colorPicker({
            modeKey: 'accentMode',
            rgbKey: 'accentRgb'
        }));

        /* ══════════ 三、主题色（全局）══════════
         * 改的是整个软件的强调色，不受上面两个开关约束。 */
        root.appendChild(el('div', {
            fontSize: '15px', fontWeight: '700', marginTop: '28px', marginBottom: '2px'
        }, '主题色'));

        root.appendChild(modeRow({
            label: '应用范围',
            modeKey: 'themeMode',
            hint: '按钮、选中态、侧栏等界面的强调色',
            modes: [['native', '不干预'], ['custom', '自选颜色']],
            onChange: rebuild
        }));

        root.appendChild(colorPicker({
            modeKey: 'themeMode',
            rgbKey: 'themeRgb',
            originalVar: '--colorPrimary1'
        }));

        var foot = el('div', { display: 'flex', gap: '10px', marginTop: '24px' });
        var bReset = button('恢复默认');
        bReset.addEventListener('click', function () {
            state = defaults();
            saveSettings(CONFIG_KEY, state);
            ensureStyle();
            applyBar();
            host.textContent = '';
            host.appendChild(buildPanel());
        });
        foot.appendChild(bReset);
        root.appendChild(foot);

        /* 源码仓库 / 问题反馈（插件商店上架准则要求提供可点击的入口） */
        root.appendChild(buildLinks());

        return root;
    }

    function update(patch) {
        Object.keys(patch || {}).forEach(function (k) { state[k] = patch[k]; });
        saveSettings(CONFIG_KEY, state);
        ensureStyle();
        /* 播放栏那一半还要管内联兜底（进度条只靠样式表） */
        applyBar();
    }

    var host = null;

    /* ------------------------------------------------------------
     * 配置迁移
     *
     * ⚠ AdvancedPlayBar 是全新插件，用全新的配置键
     *   (advanced-playbar-settings)，**不读取**旧的两个插件配置
     *   （playbar-hover-settings / playbar-transparent-settings）——
     *   这是与用户确认过的决定：从干净默认值起步。
     *
     * 这里的 migrate 只负责"脏数据兜底"，以及处理本插件自己
     * 早期键名的兼容：
     *   enabled -> hoverEnabled（最初只有一个总开关，语义是"进度条"）
     * ---------------------------------------------------------- */
    function migrate(saved) {
        if (!saved || typeof saved !== 'object') return saved;

        /* 早期叫 enabled，现在拆成 barEnabled / hoverEnabled 两个 */
        if (saved.hoverEnabled === undefined && saved.enabled !== undefined) {
            saved.hoverEnabled = !!saved.enabled;
        }
        /* 自选色必须补齐为合法结构，否则取色器拿不到值 */
        function fixRgb(v, dr, dg, db) {
            if (!v || typeof v !== 'object') return { r: dr, g: dg, b: db };
            return { r: clampByte(v.r, dr), g: clampByte(v.g, dg), b: clampByte(v.b, db) };
        }
        saved.accentRgb = fixRgb(saved.accentRgb, 236, 65, 65);
        saved.themeRgb = fixRgb(saved.themeRgb, 236, 65, 65);

        /* 合法值校验，防止存档里是脏数据；已取消的 'native' 并入 'theme' */
        if (['theme', 'custom'].indexOf(saved.accentMode) === -1) {
            saved.accentMode = 'theme';
        }
        if (['custom', 'native'].indexOf(saved.themeMode) === -1) {
            saved.themeMode = 'native';
        }
        /* 光晕强度必须是合法数字，否则拼出的 rgba alpha 会变成 NaN */
        saved.maskGlow = clamp(saved.maskGlow, 0, 1, 0.05);
        /* 播放栏那两个数值也必须合法，否则拼出的 rgba / blur 会坏掉。
         * 兜底值要与 defaults() 保持一致，否则坏存档会得到一个
         * 谁也没预期过的中间状态。 */
        saved.opacity = clamp(saved.opacity, 0, 1, 0.1);
        saved.blur = clamp(saved.blur, 0, 60, 5);
        return saved;
    }

    /* ------------------------------------------------------------
     * 启动
     * ---------------------------------------------------------- */
    plugin.onLoad(function () {
        loadSettings(CONFIG_KEY, null).then(function (saved) {
            saved = migrate(saved);
            if (saved && typeof saved === 'object') {
                Object.keys(defaults()).forEach(function (k) {
                    if (saved[k] !== undefined) state[k] = saved[k];
                });
            }
            /* 播放栏可能还没渲染（没在放歌时不存在），先注入 CSS，
             * 等它出现后再上兜底内联样式 */
            ensureStyle();
            applyBar();
            startObserver();

            setInterval(function () {
                /* 样式标签可能被客户端重建 head 时丢掉，守着 */
                if (!document.getElementById(STYLE_ID)) ensureStyle();

                if (!state.barEnabled) return;
                /* 轮询兜底：MutationObserver 在某些重渲染路径下不一定触发 */
                var cur = document.querySelector(BAR_SELECTORS);
                if (cur !== barEl) barEl = cur;
                if (cur) applyInline();
            }, 1500);
        }).catch(function (err) {
            console.warn('[AdvancedPlayBar] 初始化失败：', err);
        });
    });

    plugin.onConfig(function () {
        host = el('div', { padding: '6px 4px' });
        host.appendChild(buildPanel());
        return host;
    });

    window.__advancedPlayBar = {
        get state() { return state; },
        update: update,
        inspect: inspect,
        migrate: migrate,
        applyBar: applyBar,
        get bar() { return barEl; },
        resolveAccent: resolveAccent,
        rgbToHex: rgbToHex,
        hexToRgb: hexToRgb,
        parseColor: parseColor,
        /* HSV 工具暴露出来，方便在 Node 里验证颜色数学（canvas 跑不了） */
        hsvToRgb: hsvToRgb,
        rgbToHsv: rgbToHsv,
        themeVars: THEME_VARS,
        get themeCss() { return themeCss(); },
        get css() { return buildCss(); },
        get barCss() { return buildBarCss(); },
        get hoverCss() { return buildHoverCss(); },
        version: '1.0.0'
    };
})();
