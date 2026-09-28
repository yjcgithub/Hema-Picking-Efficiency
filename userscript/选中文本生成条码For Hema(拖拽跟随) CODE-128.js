// ==UserScript==
// @name         选中文本生成条码For Hema(拖拽跟随) CODE-128
// @namespace    http://tampermonkey.net/
// @version      V4.6
// @description  选中文字后拖动显示悬浮窗并跟随，拖拽到悬浮窗生成CODE-128条形码并跟随鼠标；同时内置「拣货效率同步」面板：在 UMS 页面取数回传到拣货效率统计后端
// @author       YJC / hema-picking-efficiency
// @match        https://portalpro.hemaos.com/*
// @match        https://ums.hemaos.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @connect      *
// @run-at       document-idle
// @license MIT
// ==/UserScript==

/* 说明：本文件 = 条码脚本（原样保留）+ 文件末尾追加的「拣货效率同步」面板。
   1) 已去掉 greasyfork 的 @downloadURL / @updateURL —— 否则在线更新会把追加的同步代码覆盖掉；
   2) 已把 @grant none 换成 GM_* 权限（同步面板需要 GM_xmlhttpRequest / GM_cookie）；
   3) 同步面板只在顶层窗口创建，iframe 里不重复出现（见文件末尾的判断）。 */

(function() {
    'use strict';

    // 本脚本用于 Hema 系统：拖拽选中文本生成 CODE-128 条形码浮动窗口
    // 支持拖放目标、悬浮显示以及生成后跟随鼠标移动的条码展示

    const GLOBAL_SINGLETON_KEY = '__barcodeInstanceV2__';
    const isTopWindow = () => {
        try {
            if (typeof window === 'undefined') return true;
            return window.top === window;
        } catch (_) { return true; }
    };
    const IS_TOP = isTopWindow();

    const isTopShellWindow = () => {
        if (!IS_TOP) return false;
        try {
            const body = document.body;
            if (!body) return false;
            const iframeCount = body.querySelectorAll('iframe').length;
            if (iframeCount === 0) return false;

            const shellTags = new Set(['IFRAME', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'TEMPLATE']);
            const visibleChildren = Array.from(body.children).filter((el) => {
                if (shellTags.has(el.tagName)) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 8 && rect.height > 8;
            });
            const hasNonIframeVisibleChild = visibleChildren.some(el => el.tagName !== 'IFRAME');
            if (hasNonIframeVisibleChild) return false;

            const visibleText = (body.innerText || '').trim();
            if (visibleText.length < 500) return true;

            if (visibleChildren.length <= 1) return true;

            const businessSelectors = [
                '#app',
                '#root',
                '.app',
                '.main',
                '.workspace',
                '.pro-layout',
                '.portal-wrapper',
                '[data-v-app]',
                '[id*="portal"]',
                '[class*="portal"]'
            ];
            for (const sel of businessSelectors) {
                if (body.querySelector(sel)) return false;
            }
            return true;
        } catch (_) {
            return false;
        }
    };
    const shouldCreateConfig = () => {
        if (isTopShellWindow()) return false;
        return shouldCreateConfigPanel();
    };
    let SHOULD_CREATE_CONFIG = null;

    const CONFIG_UI_SINGLETON_KEY = '__tm_barcode_config_ui_created_v2__';
    const shouldCreateConfigPanel = () => {
        try {
            const top = window.top;
            if (top && top !== window) {
                try {
                    if (top[CONFIG_UI_SINGLETON_KEY]) return false;
                    Object.defineProperty(top, CONFIG_UI_SINGLETON_KEY, {
                        value: true,
                        writable: false,
                        configurable: false,
                        enumerable: false
                    });
                    return true;
                } catch (_) {
                }
            }

            if (window[CONFIG_UI_SINGLETON_KEY]) return false;
            try {
                Object.defineProperty(window, CONFIG_UI_SINGLETON_KEY, {
                    value: true,
                    writable: false,
                    configurable: false,
                    enumerable: false
                });
            } catch (_) {
                window[CONFIG_UI_SINGLETON_KEY] = true;
            }
            return true;
        } catch (_) {
            return true;
        }
    };

    const BARCODE_DOM_IDS = [
        'tm-drop-zone',
        'tm-barcode-container',
        'tm-config-panel',
        'tm-toggle-btn'
    ];
    // DOM 清理延迟到 ensureBodyThen 中执行，确保 body 已存在
    const cleanupOldDom = () => {
        BARCODE_DOM_IDS.forEach((id) => {
            try {
                const el = document.getElementById(id);
                if (el && el.parentNode) el.parentNode.removeChild(el);
            } catch (_) {}
        });
    };

    if (typeof window !== 'undefined' && window[GLOBAL_SINGLETON_KEY]) {
        return;
    }
    try {
        if (typeof window !== 'undefined') {
            Object.defineProperty(window, GLOBAL_SINGLETON_KEY, {
                value: { startedAt: Date.now(), isTop: IS_TOP },
                writable: false, configurable: false, enumerable: false
            });
        }
    } catch (_) {
        try { if (typeof window !== 'undefined') window[GLOBAL_SINGLETON_KEY] = { startedAt: Date.now(), isTop: IS_TOP }; } catch (_) {}
    }

    const ensureBodyThen = (fn) => {
        let executed = false;
        const run = () => {
            if (executed) return;
            if (document.body) { executed = true; try { fn(); } catch (_) {} }
            else { setTimeout(run, 50); }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            run();
        }
    };

    const CONFIG_KEY = 'tm_barcode_config';
    const DEFAULT_CONFIG = {
        barWidth: 2,
        barHeight: 100,
        showConfig: false,
        countdownTime: 2,
        enabled: false,
        removeWatermark: false
    };
    let config;
    try {
        const saved = JSON.parse(localStorage.getItem(CONFIG_KEY));
        config = saved ? Object.assign({}, DEFAULT_CONFIG, saved) : Object.assign({}, DEFAULT_CONFIG);
    } catch (_) {
        config = Object.assign({}, DEFAULT_CONFIG);
    }

    const CODE128_PATTERNS = [
        '11011001100','11001101100','11001100110','10010011000','10010001100',
        '10001001100','10011001000','10011000100','10001100100','11001001000',
        '11001000100','11000100100','10110011100','10011011100','10011001110',
        '10111001100','10011101100','10011100110','11001110010','11001011100',
        '11001001110','11011100100','11001110100','11101101110','11101001100',
        '11100101100','11100100110','11101100100','11100110100','11100110010',
        '11011011000','11011000110','11000110110','10100011000','10001011000',
        '10001000110','10110001000','10001101000','10001100010','11010001000',
        '11000101000','11000100010','10110111000','10110001110','10001101110',
        '10111011000','10111000110','10001110110','11101110110','11010001110',
        '11000101110','11011101000','11011100010','11011101110','11101011000',
        '11101000110','11100010110','11101101000','11101100010','11100011010',
        '11101111010','11001000010','11110001010','10100110000','10100001100',
        '10010110000','10010000110','10000101100','10000100110','10110010000',
        '10110000100','10011010000','10011000010','10000110100','10000110010',
        '11000010010','11001010000','11110111010','11000010100','10001111010',
        '10100111100','10010111100','10010011110','10111100100','10011110100',
        '10011110010','11110100100','11110010100','11110010010','11011011110',
        '11011110110','11110110110','10101111000','10100011110','10001011110',
        '10111101000','10111100010','11110101000','11110100010','10111011110',
        '10111101110','11101011110','11110101110','11010000100','11010010000',
        '11010011100','1100011101011'
    ];

    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const createEl = (tag, props = {}) => Object.assign(document.createElement(tag), props);

    const rmWatermark = () => {
        if(config.removeWatermark) {
            const wm = $('.page-watermark');
            if(wm) wm.remove();
        }
    };

    const genCode128 = text => {
        if (!text) return [];

        const normalize = (str) => {
            let result = '';
            for (let i = 0; i < str.length; i++) {
                const ascii = str.charCodeAt(i);
                if (ascii >= 32 && ascii <= 126) {
                    result += str[i];
                }
            }
            return result;
        };

        const isDigit = (ch) => ch >= '0' && ch <= '9';
        const digitRunLength = (str, start) => {
            let len = 0;
            while (start + len < str.length && isDigit(str[start + len])) {
                len += 1;
            }
            return len;
        };

        const canUseCodeCAt = (str, index) => {
            const len = digitRunLength(str, index);
            return len >= 4 || (index === 0 && len >= 2);
        };

        const START_CODE_B = 104;
        const START_CODE_C = 105;
        const CODE_CODE_B = 100;
        const CODE_CODE_C = 99;
        const STOP_CODE = 106;

        const clean = normalize(text);
        if (!clean) return [];

        let codes = [];
        let pos = 0;
        let currentSet = canUseCodeCAt(clean, 0) ? 'C' : 'B';
        codes.push(currentSet === 'C' ? START_CODE_C : START_CODE_B);

        while (pos < clean.length) {
            if (currentSet === 'C') {
                const runLen = digitRunLength(clean, pos);
                if (runLen < 2) {
                    currentSet = 'B';
                    codes.push(CODE_CODE_B);
                    continue;
                }

                const pairs = Math.floor(runLen / 2);
                for (let i = 0; i < pairs; i++) {
                    const pair = clean.substr(pos + i * 2, 2);
                    codes.push(parseInt(pair, 10));
                }
                pos += pairs * 2;

                if (runLen % 2 === 1) {
                    currentSet = 'B';
                    codes.push(CODE_CODE_B);
                    continue;
                }
            } else {
                const runLen = digitRunLength(clean, pos);
                if (runLen >= 4) {
                    currentSet = 'C';
                    codes.push(CODE_CODE_C);
                    continue;
                }

                const ascii = clean.charCodeAt(pos);
                if (ascii < 32 || ascii > 126) {
                    pos += 1;
                    continue;
                }
                codes.push(ascii - 32);
                pos += 1;
            }
        }

        let checksum = codes[0];
        for (let i = 1; i < codes.length; i++) {
            checksum += codes[i] * i;
        }
        checksum %= 103;
        codes.push(checksum, STOP_CODE);

        const bars = [];
        codes.forEach(code => {
            const pattern = CODE128_PATTERNS[code];
            if (!pattern) return;
            for (let i = 0; i < pattern.length; i++) {
                bars.push(parseInt(pattern[i], 10));
            }
        });

        return bars;
    };

    const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

    let dropZone = null;
    let container = null;
    let configPanel = null;
    let toggleBtn = null;

    ensureBodyThen(() => {
        cleanupOldDom();
        if (isTopShellWindow()) return;
        dropZone = createEl('div', {
            id: 'tm-drop-zone',
            textContent: '拖拽至此\n生成条码',
            style: `
                position: fixed;
                z-index: 2147483646;
                width: 144px;
                min-height: 88px;
                padding: 10px 10px;
                background: linear-gradient(135deg, rgba(37,99,235,0.95), rgba(59,130,246,0.92));
                border: 1px solid rgba(59,130,246,0.9);
                border-radius: 14px;
                display: none;
                align-items: center;
                justify-content: center;
                text-align: center;
                font-weight: 600;
                color: #fff;
                font-size: 13px;
                font-family: ${FONT_STACK};
                line-height: 1.5;
                cursor: move;
                transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
                box-shadow: 0 20px 40px rgba(15,23,42,0.18);
                pointer-events: auto;
                white-space: pre-line;
            `
        });
        document.body.appendChild(dropZone);

        container = createEl('div', {
            id: 'tm-barcode-container',
            innerHTML: `
                <div style="padding:10px 12px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;border-top-left-radius:10px;border-top-right-radius:10px;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;font-family:${FONT_STACK};">
                    <strong style="font-size:14px;">条形码生成 (CODE-128)</strong>
                </div>
                <div style="padding:10px 12px;">
                    <div id="original-text" style="margin:6px 0;word-break:break-all;text-align:center;font-size:12px;color:#6b7280;padding:8px 10px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;font-family:${FONT_STACK};min-height:38px;"></div>
                    <div id="tm-barcode" style="display:flex;background:#ffffff;overflow-x:auto;overflow-y:hidden;margin-top:0;border:1px solid #e5e7eb;border-radius:6px;padding:14px 0;min-height:110px;">
                    </div>
                    <div id="countdown-display" style="margin:8px 0 0;text-align:center;font-size:13px;color:#991b1b;font-weight:500;padding:4px 0;font-family:${FONT_STACK};"></div>
                </div>
            `,
            style: `
                position:fixed;top:16px;left:16px;z-index:2147483647;
                background:rgba(255,255,255,0.98);color:#222;
                border:1px solid #e5e7eb;
                border-radius:10px;
                box-shadow:0 18px 40px rgba(15,23,42,0.18);
                font:13px/1.5 ${FONT_STACK};
                display:none;
                max-width:min(620px,calc(100vw - 32px));
                max-height:calc(100vh - 32px);
                overflow:hidden;
            `
        });
        document.body.appendChild(container);
    });

    ensureBodyThen(() => {
        if (SHOULD_CREATE_CONFIG === null) SHOULD_CREATE_CONFIG = shouldCreateConfig();
        if (!SHOULD_CREATE_CONFIG) return;
        configPanel = createEl('div', {
            id: 'tm-config-panel',
            innerHTML: `
                <div style="padding:10px 12px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;border-top-left-radius:10px;border-top-right-radius:10px;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;">
                    <strong style="font-size:13px;font-family:${FONT_STACK};">条形码设置</strong>
                </div>
                <div style="padding:12px;">
                    <div style="margin-bottom:12px;position:relative;">
                        <label id="enabledLabel" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:#334155;font-family:${FONT_STACK};font-size:12px;">
                            <input type="checkbox" id="enabledCheckbox" ${config.enabled?'checked':''} style="width:14px;height:14px;cursor:pointer;accent-color:#2563eb;">
                            <span>启用功能</span>
                            <span style="display:inline-block;font-size:10px;color:#1d4ed8;background:#dbeafe;border:1px solid #93c5fd;padding:1px 5px;line-height:18px;border-radius:999px;cursor:help;">?</span>
                        </label>
                        <div id="helpContent" style="position:absolute;top:40px;right:0;left:auto;min-width:220px;max-width:320px;background:#fff;color:#0f172a;padding:10px 12px;border-radius:12px;font-size:12px;display:none;z-index:2147483647;box-shadow:0 15px 40px rgba(15,23,42,0.16);line-height:1.65;border:1px solid #e2e8f0;font-family:${FONT_STACK};box-sizing:border-box;">
                            <div style="position:relative;">
                                <div style="position:absolute;right:30px;top:-10px;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:10px solid #e2e8f0;"></div>
                                <div style="position:absolute;right:30px;top:-9px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:9px solid #fff;"></div>
                                <div style="font-weight:600;margin-bottom:8px;color:#1d4ed8;font-size:13px;">使用说明</div>
                                <div style="color:#475569;">1. 拖选或双击需要转为条码的内容。</div>
                                <div style="color:#475569;">2. 按住鼠标左键不放开始拖动，悬浮窗会跟随文本移动。</div>
                                <div style="color:#475569;">3. 将选中的文本拖拽到悬浮窗上，即可生成条码。</div>
                                <div style="margin-top:8px;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;padding:8px 10px;border-radius:8px;font-size:12px;">保存后刷新可应用所有设置。</div>
                            </div>
                        </div>
                    </div>
                    <div style="margin-bottom:14px;">
                        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:#334155;font-family:${FONT_STACK};font-size:13px;">
                            <input type="checkbox" id="removeWatermarkCheckbox" ${config.removeWatermark?'checked':''} style="width:16px;height:16px;cursor:pointer;accent-color:#2563eb;">
                            <span>移除水印</span>
                        </label>
                    </div>
                    <div style="display:grid;grid-template-columns:100px 1fr;gap:8px 8px;align-items:center;margin:8px 0;">
                        <label style="color:#334155;font-size:12px;font-family:${FONT_STACK};">宽度</label>
                        <input type="number" id="barWidthInput" min="1" max="5" value="${config.barWidth}" style="padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;outline:none;font-family:${FONT_STACK};color:#0f172a;">
                        <label style="color:#334155;font-size:12px;font-family:${FONT_STACK};">高度</label>
                        <input type="number" id="barHeightInput" min="80" max="300" value="${config.barHeight}" style="padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;outline:none;font-family:${FONT_STACK};color:#0f172a;">
                        <label style="color:#334155;font-size:12px;font-family:${FONT_STACK};">倒计时</label>
                        <input type="number" id="countdownTimeInput" min="1" max="60" value="${config.countdownTime}" style="padding:6px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;outline:none;font-family:${FONT_STACK};color:#0f172a;">
                    </div>
                    <div style="display:flex;gap:8px;margin-top:10px;">
                        <button id="saveConfigBtn" class="an-btn-style an-btn-success" style="flex:1;padding:8px 12px;border-radius:10px;background:#059669;color:#fff;border:none;cursor:pointer;font-size:12px;font-family:${FONT_STACK};">保存</button>
                        <button id="closeConfigBtn" class="an-btn-style an-btn-secondary" style="flex:1;padding:8px 12px;border-radius:10px;background:#64748b;color:#fff;border:none;cursor:pointer;font-size:12px;font-family:${FONT_STACK};">关闭</button>
                    </div>
                    <style>.power-link{color:#94a3b8;text-decoration:none;transition:color 0.2s;font-size:11px;font-family:${FONT_STACK};}.power-link:hover{color:#475569;}</style>
                    <div style="display:flex;justify-content:center;align-items:center;padding-top:12px;margin-top:16px;border-top:1px solid #e2e8f0;font-family:${FONT_STACK};">
                        <a href="https://yjmc.xyz/s/QRACz" target="_blank" class="power-link">Powered by Qwen with YJC</a>
                    </div>
                </div>
            `,
            style: `
                position:fixed;top:16px;right:16px;z-index:2147483647;
                background:rgba(255,255,255,0.96);color:#0f172a;
                border:1px solid #e2e8f0;
                border-radius:18px;width:min(220px,calc(100vw - 32px));
                box-shadow:0 16px 36px rgba(15,23,42,0.16);
                font:12px/1.4 ${FONT_STACK};
                display:${config.showConfig?'block':'none'};
                max-height:calc(100vh - 32px);
                overflow:visible;
            `
        });
        document.body.appendChild(configPanel);

        toggleBtn = createEl('button', {
            id: 'tm-toggle-btn',
            textContent: '条码设置',
            style: `
                position:fixed;bottom:10px;right:1px;z-index:2147483646;
                padding:6px 10px;height:auto;
                background:${config.enabled?'#2563eb':'#ffffff'};
                color:${config.enabled?'#ffffff':'#1f2937'};
                border:1px solid ${config.enabled?'#2563eb':'#cbd5e1'};
                border-radius:999px;cursor:pointer;font-size:12px;font-weight:400;line-height:1.4;
                box-shadow:0 18px 38px rgba(15,23,42,0.18);
                transition:transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease, color 0.18s ease;
                font-family:${FONT_STACK};
            `,
            onmouseover: function() {
                if (config.enabled) {
                    this.style.transform = 'translateY(-1px)';
                    this.style.boxShadow = '0 20px 45px rgba(15,23,42,0.22)';
                    this.style.background = '#1d4ed8';
                    this.style.borderColor = '#1d4ed8';
                } else {
                    this.style.color = '#2563eb';
                    this.style.borderColor = '#2563eb';
                }
            },
            onmouseout: function() {
                if (config.enabled) {
                    this.style.transform = 'translateY(0)';
                    this.style.boxShadow = '0 18px 38px rgba(15,23,42,0.18)';
                    this.style.background = '#2563eb';
                    this.style.borderColor = '#2563eb';
                } else {
                    this.style.color = '#1f2937';
                    this.style.borderColor = '#cbd5e1';
                }
            },
            onmousedown: function() {
                if (config.enabled) {
                    this.style.transform = 'translateY(1px)';
                    this.style.background = '#1e40af';
                    this.style.borderColor = '#1e40af';
                }
            },
            onmouseup: function() {
                if (config.enabled) {
                    this.style.transform = 'translateY(-1px)';
                    this.style.background = '#1d4ed8';
                    this.style.borderColor = '#1d4ed8';
                }
            },
            onclick: () => {
                if (!configPanel) return;
                configPanel.style.display = configPanel.style.display === 'block' ? 'none' : 'block';
                config.showConfig = configPanel.style.display === 'block';
                localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
            }
        });
        document.body.appendChild(toggleBtn);
    });

    ensureBodyThen(() => {
        if (SHOULD_CREATE_CONFIG === null) SHOULD_CREATE_CONFIG = shouldCreateConfig();
        if (!SHOULD_CREATE_CONFIG) return;
        const enabledLabel = $('#enabledLabel');
        const helpContent = $('#helpContent');
        if (enabledLabel && helpContent) {
            enabledLabel.addEventListener('mouseenter', () => { helpContent.style.display = 'block'; });
            enabledLabel.addEventListener('mouseleave', () => { helpContent.style.display = 'none'; });
            helpContent.addEventListener('mouseenter', () => { helpContent.style.display = 'block'; });
            helpContent.addEventListener('mouseleave', () => { helpContent.style.display = 'none'; });
        }
    });

    const renderBarcode = bars => {
        const barcodeEl = $('#tm-barcode');
        barcodeEl.innerHTML = '';

        const quietZone = 10;
        for(let i = 0; i < quietZone; i++) {
            const space = createEl('div', {
                style: `width:${config.barWidth}px;height:${config.barHeight}px;background:white;display:inline-block;vertical-align:top;`
            });
            barcodeEl.appendChild(space);
        }

        bars.forEach(bit => {
            const bar = createEl('div', {
                style: `width:${config.barWidth}px;height:${config.barHeight}px;background-color:${bit===1?'#000000':'#FFFFFF'};display:inline-block;vertical-align:top;`
            });
            barcodeEl.appendChild(bar);
        });

        for(let i = 0; i < quietZone; i++) {
            const space = createEl('div', {
                style: `width:${config.barWidth}px;height:${config.barHeight}px;background:white;display:inline-block;vertical-align:top;`
            });
            barcodeEl.appendChild(space);
        }
    };

    let countdownInterval;
    let followMouseInterval;
    let currentMouseMoveHandler = null;
    let isDragging = false;

    const showBarcode = (text, x, y) => {
        if(text && config.enabled && container) {
            const bars = genCode128(text);
            if(bars.length > 0) {
                renderBarcode(bars);
                const origTextEl = $('#original-text');
                if (origTextEl) origTextEl.textContent = `原文: ${text}`;

                container.style.left = '16px';
                container.style.top = '16px';
                container.style.display = 'block';

                if(countdownInterval) clearInterval(countdownInterval);
                if(followMouseInterval) clearInterval(followMouseInterval);

                if(currentMouseMoveHandler) {
                    document.removeEventListener('mousemove', currentMouseMoveHandler);
                }

                let isFollowing = true;

                const followMouse = (e) => {
                    if (!isFollowing) return;
                    container.style.left = (e.clientX + 10) + 'px';
                    container.style.top = (e.clientY + 10) + 'px';
                };

                currentMouseMoveHandler = followMouse;
                document.addEventListener('mousemove', followMouse);

                let sec = config.countdownTime;
                const cdEl = $('#countdown-display');
                if (cdEl) cdEl.textContent = ` ${sec}秒后关闭`;

                countdownInterval = setInterval(() => {
                    sec--;
                    if (cdEl) cdEl.textContent = ` ${sec}秒后关闭`;
                    if(sec <= 0) {
                        clearInterval(countdownInterval);
                        isFollowing = false;
                        document.removeEventListener('mousemove', followMouse);
                        container.style.display = 'none';
                    }
                }, 1000);
            }
        }
    };

    document.addEventListener('dragstart', (e) => {
        if (!config.enabled || !dropZone) return;

        const selectedText = window.getSelection().toString().trim();
        if (selectedText) {
            e.dataTransfer.setData('text/plain', selectedText);
            dropZone.style.display = 'flex';
            dropZone.style.left = (e.clientX + 10) + 'px';
            dropZone.style.top = (e.clientY + 10) + 'px';
            isDragging = true;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging && dropZone && dropZone.style.display === 'flex') {
            dropZone.style.left = (e.clientX + 10) + 'px';
            dropZone.style.top = (e.clientY + 10) + 'px';
        }
    });

    document.addEventListener('dragend', () => {
        isDragging = false;
        if (dropZone) dropZone.style.display = 'none';
    });

    ['dragover', 'drop'].forEach(eventType => {
        document.addEventListener(eventType, (e) => {
            if (!config.enabled) return;
            e.preventDefault();
        });
    });

    ensureBodyThen(() => {
        if (!dropZone) return;
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            const data = e.dataTransfer.getData('text/plain');
            if(data) {
                const rect = dropZone.getBoundingClientRect();
                const x = rect.left;
                const y = rect.bottom;
                showBarcode(data, x, y);
            }
            dropZone.style.display = 'none';
        });

        dropZone.addEventListener('dragenter', (e) => {
            if (!config.enabled) return;
            e.preventDefault();
            dropZone.style.background = 'linear-gradient(135deg, rgba(16,185,129,0.96), rgba(164,230,206,0.95))';
            dropZone.style.borderColor = '#10b981';
            dropZone.style.color = '#065f46';
            dropZone.style.boxShadow = '0 22px 45px rgba(16,185,129,0.22)';
            dropZone.style.transform = 'scale(1.04)';
            dropZone.textContent = '释放生成!';
        });

        dropZone.addEventListener('dragleave', (e) => {
            if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) {
                 dropZone.style.background = 'linear-gradient(135deg, rgba(59,130,246,0.95), rgba(37,99,235,0.92))';
                 dropZone.style.borderColor = 'rgba(59,130,246,0.9)';
                 dropZone.style.color = '#ffffff';
                 dropZone.style.boxShadow = '0 20px 40px rgba(15,23,42,0.18)';
                 dropZone.style.transform = 'scale(1)';
                 dropZone.textContent = '拖拽至此\n生成条码';
            }
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
    });

    ensureBodyThen(() => {
        if (SHOULD_CREATE_CONFIG === null) SHOULD_CREATE_CONFIG = shouldCreateConfig();
        if (!SHOULD_CREATE_CONFIG) return;
        const saveBtn = $('#saveConfigBtn');
        const closeBtn = $('#closeConfigBtn');
        if (!saveBtn || !closeBtn) return;

        saveBtn.onclick = () => {
            config.barWidth = parseInt($('#barWidthInput').value) || DEFAULT_CONFIG.barWidth;
            config.barHeight = parseInt($('#barHeightInput').value) || DEFAULT_CONFIG.barHeight;
            config.countdownTime = parseInt($('#countdownTimeInput').value) || DEFAULT_CONFIG.countdownTime;
            config.enabled = $('#enabledCheckbox').checked;
            config.removeWatermark = $('#removeWatermarkCheckbox').checked;

            config.showConfig = false;
            localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
            if(config.removeWatermark) rmWatermark();
            if (configPanel) configPanel.style.display = 'none';
            location.reload();
        };

        closeBtn.onclick = () => {
            if (configPanel) configPanel.style.display = 'none';
            config.showConfig = false;
            localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        };
    });

    if(config.removeWatermark) {
        rmWatermark();
        const observer = new MutationObserver(rmWatermark);
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();

/* ================= 「拣货效率同步」（合并自 hema-pick-sync.user.js） =================
   取 UMS 拣货单数据回传到「拣货效率统计」后端入库。
   · 全部 UI 放在条码脚本的「条码设置」面板里（状态 / 设置 / 立即同步 / 调试日志 / 捕获的 Cookie）；
     若该面板在本窗口不存在，退化为右上角的独立浮动面板
   · 页面域与接口域不同时（portalpro.hemaos.com → ums.hemaos.com），在「调试日志 → 接口域」里改
   · 请求接口：先走 fetch（自动带 Cookie），被 CORS 拦则自动改走 GM_xmlhttpRequest
   ================================================================================== */
(function () {
  'use strict';

  // 本文件还兼管条码脚本（不能加 @noframes），这里自己判断：只在顶层窗口建面板，iframe 里不重复出现
  try { if (window.top !== window) return; } catch (e) { return; }

  /* ---------- 常量与配置 ---------- */
  var UMS_PATH = '/out/PickOrderManager/listPickOrderForB2C.json';
  var MAX_PAGES = 400;          // 分页保护上限，与后端一致
  var MAX_LOG = 300;            // 调试日志最多保留多少条
  var OPEN_URL = 'http://8.137.63.172:40043/';   // 同步成功后「打开统计页面」跳转的地址

  var cfg = {
    base: GM_getValue('base', 'http://8.137.63.172:3001'),
    enabled: GM_getValue('enabled', true),
    intervalMin: GM_getValue('intervalMin', 5),
    range: GM_getValue('range', 'today'),      // today | y2 | d3 | d7
    incremental: GM_getValue('incremental', true),
    apiOrigin: GM_getValue('apiOrigin', 'https://ums.hemaos.com'),  // 接口所在域（可能与页面域不同）
    path: GM_getValue('path', UMS_PATH)        // 接口路径，可改（排查 404 用）
  };
  var last = GM_getValue('last', null);        // { at, ok, msg, added, replaced, records, pages, range }
  var running = false;
  var stateText = '尚未同步';
  var stateCls = '';

  function saveCfg() {
    GM_setValue('base', cfg.base);
    GM_setValue('enabled', !!cfg.enabled);
    GM_setValue('intervalMin', cfg.intervalMin);
    GM_setValue('range', cfg.range);
    GM_setValue('incremental', !!cfg.incremental);
    GM_setValue('apiOrigin', cfg.apiOrigin);
    GM_setValue('path', cfg.path);
  }

  function api(path) {
    return String(cfg.base || '').replace(/\/+$/, '') + path;
  }
  // 接口域：允许留空（留空则回退到页面所在域）
  function apiOrigin() {
    var o = String(cfg.apiOrigin || '').trim();
    if (!o) return location.origin;
    if (!/^https?:\/\//i.test(o)) o = 'https://' + o;
    return o.replace(/\/+$/, '');
  }
  function umsPath() {
    var p = String(cfg.path || UMS_PATH).trim() || UMS_PATH;
    return p.charAt(0) === '/' ? p : '/' + p;
  }

  /* ---------- 小工具 ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(t) {
    var d = new Date(t);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function hm(t) {
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function rangeOf() {
    var end = new Date(), start = new Date();
    if (cfg.range === 'y2') start.setDate(start.getDate() - 1);
    else if (cfg.range === 'd3') start.setDate(start.getDate() - 2);
    else if (cfg.range === 'd7') start.setDate(start.getDate() - 6);
    return { start: fmtDate(start), end: fmtDate(end) };
  }

  /* ---------- 请求 ---------- */
  // 请求后端：走 GM_xmlhttpRequest，不受页面跨域限制
  function http(method, url, body) {
    dbg('→ 后端 ' + method + ' ' + url);
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 180000,
        onload: function (res) {
          dbg('← 后端 ' + res.status + '（' + method + ' ' + url.replace(/^.*\/api/, '/api') + '）',
            res.status >= 400 ? 'err' : 'ok');
          var j = null;
          try { j = JSON.parse(res.responseText); }
          catch (e) {
            return reject(new Error('后端未返回 JSON（HTTP ' + res.status + '）：' +
              oneLine(res.responseText).slice(0, 120)));
          }
          if (res.status >= 400) return reject(new Error(j.error || ('HTTP ' + res.status)));
          resolve(j);
        },
        ontimeout: function () {
          dbg('后端请求超时：' + url, 'err');
          reject(new Error('请求后端超时'));
        },
        onerror: function () {
          dbg('无法连接后端：' + url, 'err');
          reject(new Error('无法连接后端（检查地址、服务是否已启动）'));
        }
      });
    });
  }

  // 拣货单接口请求：先按普通 fetch（浏览器自动带该域 Cookie）；
  // 页面域与接口域不同（如 portalpro.hemaos.com → ums.hemaos.com）且接口没开放 CORS 时，
  // fetch 会直接抛网络错误，这里自动改走 GM_xmlhttpRequest（扩展网络层：不受 CORS 限制，同样自动带目标域 Cookie）
  function umsRequest(url) {
    return fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    }).then(function (res) {
      return res.text().then(function (t) { return { status: res.status, text: t, via: 'fetch' }; });
    }, function (e) {
      dbg('fetch 被拦截（多为跨域 CORS）：' + ((e && e.message) || e) + ' → 改用 GM_xmlhttpRequest', 'warn');
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: { Accept: 'application/json, text/plain, */*' },
          timeout: 60000,
          onload: function (r) { resolve({ status: r.status, text: r.responseText || '', via: 'GM' }); },
          ontimeout: function () { reject(new Error('接口请求超时：' + url)); },
          onerror: function () { reject(new Error('接口请求失败（网络不可达）：' + url)); }
        });
      });
    });
  }

  // 拣货单接口：按「接口域名 + 接口路径」拼 URL（同源则浏览器自动带上当前登录态 Cookie）
  function fetchPage(index, start, end, num) {
    var q = '?pickOperateType=3&pickOrderCode=&externalBatchCode=&subTaskType=&deliveryCodes=' +
      '&index=' + index + '&num=' + num +
      '&startDate=' + encodeURIComponent(start) + '&endDate=' + encodeURIComponent(end);
    var url = apiOrigin() + umsPath() + q;
    dbg('→ 接口 GET ' + url);
    return umsRequest(url).then(function (r) {
      if (r.status !== 200) {
        var extra = oneLine(r.text).slice(0, 140);
        dbg('← 接口 ' + r.status + '（via ' + r.via + '）' + (extra ? ' body: ' + extra : ''), 'err');
        throw new Error('接口返回 HTTP ' + r.status + '（via ' + r.via + '）：' + url +
          (r.status === 404 ? '　提示：接口域名/路径不对，可在「调试日志」里改' : '') +
          (extra ? '，返回片段：' + extra : ''));
      }
      var j, text = r.text;
      try { j = JSON.parse(text); }
      catch (e) {
        dbg('← 接口 200 但不是 JSON（登录态可能已失效）：' + oneLine(text).slice(0, 120), 'err');
        throw new Error('接口未返回 JSON（登录态可能已失效）：' + oneLine(text).slice(0, 100));
      }
      if (j.code !== 200 || !j.info) {
        dbg('← 接口 200 但 code=' + j.code + '：' + oneLine(JSON.stringify(j)).slice(0, 120), 'err');
        throw new Error('接口返回异常：' + oneLine(JSON.stringify(j)).slice(0, 150));
      }
      dbg('← 接口 200（via ' + r.via + '）index=' + index + ' 本页 ' + ((j.info.list || []).length) +
        ' 条 / 共 ' + (j.info.totalNum || 0) + ' 条', 'ok');
      return j;
    });
  }

  /* ---------- 同步主流程 ---------- */
  function sync() {
    if (running) return Promise.resolve();
    running = true;
    var rg = rangeOf(), pages = [], got = 0, total = 0, reached = false, complete = false, num = 100;
    setState('同步中…', 'run');
    dbg('— 开始同步 ' + rg.start + ' ~ ' + rg.end + (cfg.incremental ? '（增量）' : '（全量）') + ' —', 'run');

    return http('GET', api('/api/ums/config'))
      .then(function (j) { if (j && j.num) num = j.num; }, function (e) {
        dbg('读取后端配置失败，用默认每页 ' + num + ' 条：' + ((e && e.message) || e), 'warn');
      })
      .then(function () {
        function step(index) {
          return fetchPage(index, rg.start, rg.end, num).then(function (j) {
            var list = (j.info && j.info.list) || [];
            pages.push(j);
            got += list.length;
            total = Number(j.info && j.info.totalNum) || got;
            setState('同步中… 第 ' + (index + 1) + '/' + Math.max(1, Math.ceil(total / num)) +
              ' 页，已取 ' + got + '/' + total, 'run');
            if (!list.length || got >= total) { complete = true; return null; }
            if (pages.length >= MAX_PAGES) return null;
            if (!cfg.incremental) return step(index + 1);
            return http('POST', api('/api/ums/known'), {
              codes: list.map(function (x) { return String(x.code); })
            }).then(function (k) {
              if (k && k.known >= list.length) { reached = true; return null; }  // 整页都已入库：追平
              return step(index + 1);
            });
          });
        }
        return step(0);
      })
      .then(function () {
        dbg('回传后端：' + pages.length + ' 页，complete=' + complete + '，reached=' + reached);
        return http('POST', api('/api/ums/agent/data'), {
          startDate: rg.start, endDate: rg.end, complete: complete, reached: reached, pages: pages
        });
      })
      .then(function (r) {
        last = {
          at: Date.now(), ok: true, range: rg.start + ' ~ ' + rg.end, pages: pages.length,
          added: r.added || 0, replaced: r.replaced || 0,
          records: (r.meta && r.meta.recordCount) || 0,
          msg: (complete ? '全量' : '增量追平') + '，数据集 #' + r.id
        };
        running = false;
        GM_setValue('last', last);
        setState(lastText(), 'ok');
        tip('同步完成，可点「打开统计页面」查看', 'ok');
        showOpen(true);   // 同步成功：露出跳转按钮
        dbg('同步完成：新增 ' + last.added + ' 条，覆盖 ' + last.replaced + ' 条，合计 ' + last.records + ' 条', 'ok');
        refreshCookie(true, true);   // 顺手把最新 Cookie 推给后端：后端自己取数时也不会因登录态过期而失败
      })
      .catch(function (e) {
        last = {
          at: Date.now(), ok: false, range: rg.start + ' ~ ' + rg.end,
          msg: (e && e.message) || String(e)
        };
        running = false;
        GM_setValue('last', last);
        setState(lastText(), 'err');
        tip('同步失败', 'err');
        dbg('同步失败：' + last.msg, 'err');
        refreshCookie(true);
      });
  }

  function lastText() {
    if (!last) return '尚未同步';
    if (!last.ok) return '上次同步失败 ' + fmtTime(last.at) + '（' + last.range + '）：' + last.msg;
    return '上次同步 ' + fmtTime(last.at) + '（' + last.range + '，' + last.msg + '）：新增 ' +
      (last.added || 0) + ' 条' +
      ((last.replaced || 0) ? '，覆盖旧明细 ' + last.replaced + ' 条' : '') +
      '，共 ' + (last.records || 0) + ' 条';
  }
  function countdownText() {
    if (!cfg.enabled) return '自动同步：已关闭';
    var at = last && last.at ? last.at : 0;
    if (!at) return '自动同步：每 ' + cfg.intervalMin + ' 分钟，等待首次执行';
    var left = at + cfg.intervalMin * 60000 - Date.now();
    return '自动同步：每 ' + cfg.intervalMin + ' 分钟，' + (left > 0 ? Math.ceil(left / 1000) + ' 秒后执行' : '即将执行');
  }

  /* ---------- 面板：整块同步 UI ----------
     这一整块会被放进条码脚本的「条码设置」面板里（见本文件末尾的挂载逻辑），
     所以全部用内联样式；只有日志行的着色用一小段 <style> 限定在 #hps-cfg 内 */
  var S = {
    inp: 'width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:5px 8px;font:inherit;color:#0f172a;background:#fff;outline:none',
    row: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px',
    lab: 'display:inline-flex;align-items:center;gap:5px;min-width:0',
    chk: 'width:14px;height:14px;accent-color:#2563eb;margin:0;flex:none',
    num: 'width:44px;box-sizing:border-box;flex:none;border:1px solid #cbd5e1;border-radius:8px;padding:3px 6px;font:inherit;outline:none',
    sel: 'min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:8px;padding:3px 6px;font:inherit;background:#fff;outline:none',
    btn: 'border:1px solid #c9d6ea;background:#fff;border-radius:8px;padding:4px 10px;font:inherit;cursor:pointer;color:#0f172a;text-align:center',
    grid2: 'display:grid;grid-template-columns:1fr 1fr;gap:7px 8px;margin-top:9px',
    lb: 'color:#94a3b8;font-size:11px',
    linkS: 'border:0;background:transparent;color:#2563eb;cursor:pointer;font:11px/1 inherit;padding:0 3px',
    secH: 'display:flex;align-items:center;gap:6px;cursor:pointer;color:#475569;font-weight:600;user-select:none',
    sec: 'margin-top:9px;border-top:1px dashed #e2e8f0;padding-top:7px'
  };
  var cfgBlock = document.createElement('div');
  cfgBlock.id = 'hps-cfg';
  // 自成一张卡片：与上方条码设置视觉分离
  cfgBlock.setAttribute('style', 'padding:9px 10px;box-sizing:border-box;' +
    'border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;' +
    'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#0f172a;');
  cfgBlock.innerHTML = [
    // 标题 + 状态（状态点 / 底色随结果变化）
    '<div style="display:flex;align-items:center;gap:6px">',
    '  <span id="hpsDot" style="width:8px;height:8px;border-radius:50%;background:#cbd5e1;flex:none"></span>',
    '  <span style="font-weight:600;color:#1d4ed8">拣货效率同步</span>',
    '</div>',
    '<div id="hpsState" style="margin:5px 0 10px;padding:6px 8px;border-radius:8px;background:#f1f5f9;color:#64748b;font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums;word-break:break-all">尚未同步</div>',
    // 后端地址
    '<div style="' + S.lb + '">后端地址</div>',
    '<input id="hpsBase" type="text" placeholder="如 http://localhost:3001/hpe" style="margin-top:3px;' + S.inp + '">',
    // 取数选项（两列）
    '<div style="' + S.grid2 + '">',
    '  <label style="' + S.lab + ';cursor:pointer"><input id="hpsOn" type="checkbox" style="' + S.chk + '">自动同步</label>',
    '  <label style="' + S.lab + '">每<input id="hpsMin" type="number" min="1" max="1440" step="1" style="' + S.num + '">分钟</label>',
    '  <label style="' + S.lab + '">范围<select id="hpsRange" style="' + S.sel + '">',
    '    <option value="today">当天</option><option value="y2">昨天 ~ 今天</option>',
    '    <option value="d3">最近 3 天</option><option value="d7">最近 7 天</option></select></label>',
    '  <label style="' + S.lab + ';cursor:pointer"><input id="hpsInc" type="checkbox" style="' + S.chk + '">增量</label>',
    '</div>',
    // 操作（两个按钮一行，跳转按钮占整行）
    '<div style="' + S.grid2 + '">',
    '  <button id="hpsNow" style="' + S.btn + '">立即同步</button>',
    '  <button id="hpsTest" style="' + S.btn + '">测试接口</button>',
    '  <a id="hpsOpen" href="' + OPEN_URL + '" target="_blank" rel="noopener" title="' + OPEN_URL + '"',
    '    style="grid-column:1 / -1;display:none;text-decoration:none;' + S.btn + '">打开统计页面 ↗</a>',
    '</div>',
    '<div id="hpsTip" style="margin-top:6px;color:#64748b;font-size:11px;min-height:14px"></div>',
    '<div style="' + S.sec + '">',
    '  <div id="hpsDbgH" style="' + S.secH + '"><span id="hpsDbgA" style="width:10px;color:#94a3b8">▸</span><span>调试日志</span>',
    '    <span id="hpsDbgN" style="color:#94a3b8;font-weight:400"></span><span style="flex:1"></span>',
    '    <button id="hpsDbgCopy" style="' + S.linkS + '">复制</button>',
    '    <button id="hpsDbgClr" style="' + S.linkS + '">清空</button></div>',
    '  <div id="hpsDbgB" style="display:none">',
    '    <div style="' + S.row + '"><span>接口域</span>',
    '      <input id="hpsApiOrigin" type="text" placeholder="https://ums.hemaos.com" style="flex:1;min-width:0;' + S.inp + '"></div>',
    '    <div style="' + S.row + '"><span>接口路径</span>',
    '      <input id="hpsPath" type="text" style="flex:1;min-width:0;' + S.inp + '"></div>',
    '    <div id="hpsDbgBody" style="height:96px;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:5px 6px"></div>',
    '  </div>',
    '</div>',
    '<div style="' + S.sec + '">',
    '  <div id="hpsCkH" style="' + S.secH + '"><span id="hpsCkA" style="width:10px;color:#94a3b8">▸</span><span>捕获的 Cookie</span>',
    '    <span id="hpsCkN" style="color:#94a3b8;font-weight:400"></span><span style="flex:1"></span>',
    '    <button id="hpsCkSave" style="' + S.linkS + '">存到服务端</button>',
    '    <button id="hpsCkCopy" style="' + S.linkS + '">复制</button>',
    '    <button id="hpsCkRefresh" style="' + S.linkS + '">刷新</button></div>',
    '  <div id="hpsCkB" style="display:none">',
    '    <textarea id="hpsCkVal" readonly placeholder="点「刷新」从浏览器读取（含 HttpOnly 登录态）"',
    '      style="width:100%;box-sizing:border-box;height:56px;resize:vertical;border:1px solid #cbd5e1;border-radius:8px;padding:5px 6px;font:11px/1.4 ui-monospace,Consolas,monospace;color:#0f172a"></textarea>',
    '    <div style="color:#94a3b8;font-size:11px;margin-top:4px">「存到服务端」后，后端可自己带 Cookie 取数；也可复制粘贴到后端「实时获取 → 接口 Cookie → 设置」</div>',
    '  </div>',
    '</div>',
    '<style>#hps-cfg .hps-ln{font:10px/1.4 ui-monospace,Consolas,monospace;color:#475569;word-break:break-all;white-space:pre-wrap}',
    '#hps-cfg .hps-ln.ok{color:#047857}#hps-cfg .hps-ln.err{color:#b91c1c}',
    '#hps-cfg .hps-ln.warn{color:#b45309}#hps-cfg .hps-ln.run{color:#1d4ed8}</style>'
  ].join('');

  var $ = function (sel) { return cfgBlock.querySelector(sel); };

  /* ---------- 元素引用（全部在 cfgBlock 内） ---------- */
  var elBase = $('#hpsBase'), elOn = $('#hpsOn'), elMin = $('#hpsMin'), elRange = $('#hpsRange'), elInc = $('#hpsInc');
  var elState = $('#hpsState'), elTip = $('#hpsTip'), elOpen = $('#hpsOpen'), elDot = $('#hpsDot');
  var elLogBody = $('#hpsDbgBody'), elLogN = $('#hpsDbgN'), elPath = $('#hpsPath'), elLogA = $('#hpsDbgA');
  var elApiOrigin = $('#hpsApiOrigin');
  var elCkVal = $('#hpsCkVal'), elCkN = $('#hpsCkN'), elCkA = $('#hpsCkA');

  /* ---------- 调试日志 ---------- */
  var logBuf = [];
  function dbg(msg, cls) {
    logBuf.push({ t: Date.now(), m: String(msg), c: cls || '' });
    if (logBuf.length > MAX_LOG) logBuf.splice(0, logBuf.length - MAX_LOG);
    try { console.log('[拣货效率同步]', msg); } catch (e) { /* ignore */ }
    renderLog();
  }
  function logText() {
    return logBuf.map(function (x) { return fmtTime(x.t) + '  ' + x.m; }).join('\n');
  }
  function renderLog() {
    if (!elLogBody) return;
    elLogBody.innerHTML = logBuf.map(function (x) {
      return '<div class="hps-ln ' + x.c + '">' + esc(hm(x.t)) + ' ' + esc(x.m) + '</div>';
    }).join('');
    elLogBody.scrollTop = elLogBody.scrollHeight;
    elLogN.textContent = logBuf.length ? '(' + logBuf.length + ')' : '';
  }

  /* ---------- Cookie 捕获（含 HttpOnly） ---------- */
  // url：要读取哪个域的 Cookie（同步用的是「接口域」的登录态，未必等于页面域）
  function readCookies(url, cb) {
    var out = [], names = {};
    // 1) 接口域与页面域相同：document.cookie 里还有非 HttpOnly 的那部分
    if (url.indexOf(location.origin) === 0) {
      try {
        (document.cookie || '').split(/;\s*/).forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          if (i > 0) { var n = kv.slice(0, i); names[n] = 1; out.push({ name: n, value: kv.slice(i + 1) }); }
        });
      } catch (e) { /* ignore */ }
    }
    // 2) HttpOnly（UMS 的登录态都在这）：Tampermonkey 的 GM_cookie
    if (typeof GM_cookie !== 'undefined' && GM_cookie && GM_cookie.list) {
      try {
        GM_cookie.list({ url: url }, function (list, err) {
          if (err) dbg('GM_cookie 读取失败：' + (err.message || err), 'warn');
          (list || []).forEach(function (c) {
            if (c && c.name && !names[c.name]) { names[c.name] = 1; out.push({ name: c.name, value: c.value }); }
          });
          cb(out);
        });
      } catch (e) {
        dbg('GM_cookie 调用异常：' + ((e && e.message) || e), 'warn');
        cb(out);
      }
      return;
    }
    dbg('当前脚本管理器不支持 GM_cookie，只能读到非 HttpOnly Cookie（登录态多半拿不到）', 'warn');
    cb(out);
  }
  function cookieStr(list) {
    return list.map(function (c) { return c.name + '=' + c.value; }).join('; ');
  }
  // quiet：不写调试日志；push：读到后顺带存到后端
  function refreshCookie(quiet, push) {
    var target = apiOrigin() + '/';
    readCookies(target, function (list) {
      var s = cookieStr(list);
      elCkVal.value = s;
      elCkN.textContent = list.length ? '(' + list.length + ' 项 / ' + s.length + ' 字符)' : '(空)';
      if (!quiet) {
        dbg('捕获 Cookie（' + target + '）：' + list.length + ' 项' +
          (list.length ? '（' + list.map(function (c) { return c.name; }).join(', ') + '）' :
            '　—— 该域没有 Cookie，同步可能未登录'),
          list.length ? 'ok' : 'warn');
      }
      if (push && s) saveCookie(true);
      // 接口域读不到时，顺手读一下页面域的，方便对比（脚本同步用的是接口域）
      if (!list.length && target !== location.origin + '/') {
        readCookies(location.origin + '/', function (l2) {
          if (!l2.length) return;
          elCkVal.value = cookieStr(l2);
          elCkN.textContent = '(接口域为空，显示页面域 ' + l2.length + ' 项)';
          if (!quiet) dbg('页面域 ' + location.origin + ' 有 ' + l2.length + ' 项 Cookie（仅备查）', 'warn');
        });
      }
    });
  }

  /* 把捕获到的 Cookie 存到后端（POST /api/ums/config {cookie}）：
     存好后后端就能自己带 Cookie 取数，不再依赖脚本同步。
     auto=true 时不弹「没读到」的错误（同步成功后的自动推送用） */
  function saveCookie(auto) {
    function doSave(str) {
      if (!str) {
        if (!auto) tip('还没读到 Cookie，先点「刷新」', 'err');
        return;
      }
      http('POST', api('/api/ums/config'), { cookie: str }).then(function (j) {
        var ok = !!(j && j.cookieSet);
        dbg('Cookie 已保存到服务端（' + str.length + ' 字符' + (ok ? '，服务端已确认' : '') + '）', 'ok');
        tip('Cookie 已保存到服务端' + (ok ? '' : '（服务端未确认）'), ok ? 'ok' : 'err');
      }, function (e) {
        var msg = (e && e.message) || e;
        dbg('Cookie 保存到服务端失败：' + msg, 'err');
        tip('Cookie 保存失败：' + msg, 'err');
      });
    }
    var cur = (elCkVal.value || '').trim();
    if (cur) return doSave(cur);
    // 输入框还是空的（还没刷新过）：先读一次再存
    readCookies(apiOrigin() + '/', function (list) {
      var s = cookieStr(list);
      elCkVal.value = s;
      elCkN.textContent = s ? '(' + list.length + ' 项 / ' + s.length + ' 字符)' : '(空)';
      doSave(s);
    });
  }

  /* ---------- 渲染 ---------- */
  // 状态（上次同步结果 + 自动同步倒计时）画在设置面板里，倒计时一行淡一些
  function paintState() {
    var tone = running ? 'run' : (stateCls === 'ok' ? 'ok' : (stateCls === 'err' ? 'err' : ''));
    elDot.style.background = { run: '#2563eb', ok: '#10b981', err: '#ef4444' }[tone] || '#cbd5e1';
    elState.style.color = { run: '#1d4ed8', ok: '#047857', err: '#b91c1c' }[tone] || '#64748b';
    elState.style.background = { run: '#eff6ff', ok: '#ecfdf5', err: '#fef2f2' }[tone] || '#f1f5f9';
    elState.innerHTML = esc(stateText) + '<br><span style="color:#94a3b8">' + esc(countdownText()) + '</span>';
  }

  function paint() {
    elBase.value = cfg.base;
    elOn.checked = !!cfg.enabled;
    elMin.value = cfg.intervalMin;
    elRange.value = cfg.range;
    elInc.checked = !!cfg.incremental;
    elPath.value = cfg.path;
    elApiOrigin.value = cfg.apiOrigin;
    paintState();
  }

  function setState(text, cls) {
    stateText = text || stateText;
    stateCls = cls || '';
    paint();
  }

  function tip(text, cls) {
    elTip.textContent = text || '';
    elTip.style.color = cls === 'err' ? '#b91c1c' : (cls === 'ok' ? '#047857' : '#64748b');
  }

  // 同步成功后显示「打开统计页面」跳转按钮（指向 OPEN_URL）
  function showOpen(on) { elOpen.style.display = on ? 'block' : 'none'; }

  function section(headerEl, bodyEl, arwEl) {
    headerEl.addEventListener('click', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;   // 点按钮不折叠
      var hide = bodyEl.style.display !== 'none';
      bodyEl.style.display = hide ? 'none' : 'block';
      arwEl.textContent = hide ? '▸' : '▾';
    });
  }

  /* ---------- 交互 ---------- */
  elBase.addEventListener('change', function () {
    cfg.base = elBase.value.trim();
    saveCfg();
    tip('后端地址已保存', 'ok');
    dbg('后端地址改为 ' + cfg.base);
  });
  elPath.addEventListener('change', function () {
    cfg.path = elPath.value.trim() || UMS_PATH;
    elPath.value = cfg.path;
    saveCfg();
    tip('接口路径已保存', 'ok');
    dbg('接口路径改为 ' + cfg.path);
  });
  elApiOrigin.addEventListener('change', function () {
    cfg.apiOrigin = elApiOrigin.value.trim();
    saveCfg();
    tip('接口域名已保存为 ' + apiOrigin(), 'ok');
    dbg('接口域名改为 ' + apiOrigin() + '（页面域 ' + location.origin + '）');
    refreshCookie(true);
  });
  elOn.addEventListener('change', function () {
    cfg.enabled = elOn.checked;
    saveCfg();
    tip(cfg.enabled ? '自动同步已开启' : '自动同步已关闭', 'ok');
    paint();
  });
  elMin.addEventListener('change', function () {
    var n = Math.round(Number(elMin.value) || 5);
    cfg.intervalMin = Math.min(1440, Math.max(1, n));
    saveCfg();
    tip('间隔已设为每 ' + cfg.intervalMin + ' 分钟', 'ok');
    paint();
  });
  elRange.addEventListener('change', function () {
    cfg.range = elRange.value;
    saveCfg();
    tip('日期范围已保存', 'ok');
    paint();
  });
  elInc.addEventListener('change', function () {
    cfg.incremental = elInc.checked;
    saveCfg();
    tip(cfg.incremental ? '增量：遇到已入库即停' : '全量：整段区间重取', 'ok');
  });
  $('#hpsNow').addEventListener('click', function () { tip('', ''); sync(); });
  $('#hpsTest').addEventListener('click', function () { tip('', ''); testApi(); });

  section($('#hpsDbgH'), $('#hpsDbgB'), elLogA);
  section($('#hpsCkH'), $('#hpsCkB'), elCkA);

  /* 把整块同步 UI 放进条码脚本的「条码设置」面板（保存 / 关闭按钮上方）。
     该面板可能比本脚本晚创建、或不在本窗口创建，所以轮询 10 秒；
     实在找不到就退化为右上角的独立浮动面板，功能不丢 */
  (function mount() {
    var tries = 0;
    var timer = setInterval(function () {
      var saveBtn = document.getElementById('saveConfigBtn');
      if (saveBtn && saveBtn.parentNode && saveBtn.parentNode.parentNode) {
        var panel = document.getElementById('tm-config-panel');
        // 同步模块内容较多：把条码设置面板放宽一点、并可纵向滚动，避免挤在一列里换行 / 溢出屏幕
        if (panel) {
          panel.style.width = 'min(250px, calc(100vw - 32px))';   // 比原来的 220px 略宽即可
          panel.style.maxHeight = 'calc(100vh - 32px)';
          panel.style.overflowY = 'auto';
          panel.style.overflowX = 'hidden';
        }
        cfgBlock.style.marginTop = '10px';   // 与上方条码设置留出间距（卡片自带边框）
        saveBtn.parentNode.parentNode.insertBefore(cfgBlock, saveBtn.parentNode);
        clearInterval(timer);
        return;
      }
      if (++tries >= 20) {
        clearInterval(timer);
        mountFloating();
      }
    }, 500);
  })();

  function mountFloating() {
    var host = document.createElement('div');
    host.id = 'hps-host';
    (document.body || document.documentElement).appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{all:initial}.w{position:fixed;top:10px;right:10px;z-index:2147483647;' +
      'width:240px;box-sizing:border-box;background:#fff;border:1px solid #dbe3ef;border-radius:10px;' +
      'box-shadow:0 8px 24px rgba(15,23,42,.18);padding:10px}</style><div class="w"></div>';
    root.querySelector('.w').appendChild(cfgBlock);
  }

  $('#hpsDbgClr').addEventListener('click', function () { logBuf = []; renderLog(); });
  $('#hpsDbgCopy').addEventListener('click', function () { copy(logText(), '调试日志'); });
  $('#hpsCkRefresh').addEventListener('click', function () { refreshCookie(false); });
  $('#hpsCkSave').addEventListener('click', function () { saveCookie(false); });
  $('#hpsCkCopy').addEventListener('click', function () {
    if (!elCkVal.value) return tip('还没有读到 Cookie，先点「刷新」', 'err');
    copy(elCkVal.value, 'Cookie');
  });

  function copy(text, what) {
    if (!text) return tip('没有可复制的内容', 'err');
    function fallback() {
      try {
        elCkVal.value = text;
        elCkVal.removeAttribute('readonly');
        elCkVal.select();
        document.execCommand('copy');
        elCkVal.setAttribute('readonly', 'readonly');
        tip(what + '已复制到剪贴板', 'ok');
      } catch (e) { tip('复制失败，请手动选中「' + what + '」里的内容', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { tip(what + '已复制到剪贴板', 'ok'); }, fallback);
    } else { fallback(); }
  }

  // 测试接口：只取第 1 页，把 URL / 状态 / 返回片段写进调试日志
  function testApi() {
    dbg('— 测试接口 —', 'run');
    dbg('页面地址 ' + location.href);
    dbg('接口地址 ' + apiOrigin() + umsPath());
    dbg('User-Agent ' + navigator.userAgent);
    var rg = rangeOf(), num = 100;
    http('GET', api('/api/ums/config'))
      .then(function (j) { if (j && j.num) num = j.num; }, function (e) {
        dbg('读取后端配置失败（不影响接口测试）：' + ((e && e.message) || e), 'warn');
      })
      .then(function () { return fetchPage(0, rg.start, rg.end, num); })
      .then(function (j) {
        var list = (j.info && j.info.list) || [];
        dbg('测试成功：totalNum=' + j.info.totalNum + '，本页 ' + list.length + ' 条', 'ok');
        tip('测试成功：本页 ' + list.length + ' 条', 'ok');
      })
      .catch(function (e) {
        dbg('测试失败：' + ((e && e.message) || e), 'err');
        tip('测试失败，看调试日志', 'err');
      });
  }

  GM_registerMenuCommand('立即同步', function () { sync(); });
  GM_registerMenuCommand('测试接口', function () { testApi(); });
  GM_registerMenuCommand('打开 / 关闭设置面板', function () {
    var p = document.getElementById('tm-config-panel');
    if (p) p.style.display = p.style.display === 'block' ? 'none' : 'block';
    else tip('没找到设置面板，点页面右下角的「条码设置」');
  });

  /* ---------- 自动同步：每 15 秒检查是否到点；每秒只更新倒计时 ---------- */
  setInterval(function () {
    if (running) return;
    var at = last && last.at ? last.at : 0;
    if (cfg.enabled && (!at || Date.now() - at >= cfg.intervalMin * 60000)) { sync(); return; }
    paintState();
  }, 15000);

  setInterval(function () { if (!running) paintState(); }, 1000);

  /* ---------- 首屏 ---------- */
  if (last) { stateText = lastText(); stateCls = last.ok ? 'ok' : 'err'; }
  renderLog();
  paint();
  showOpen(!!(last && last.ok));   // 之前成功同步过：直接显示跳转按钮
  dbg('同步模块已加载：' + location.href);
  dbg('页面域 ' + location.origin + ' → 接口域 ' + apiOrigin() + umsPath());
  dbg('登录态是 HttpOnly Cookie，且未必在页面域上；同步靠请求接口域时自动带上它的 Cookie', '');
  refreshCookie(true);
})();
