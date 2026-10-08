import { elements } from './dom.js';

let toastEl = null;

/**
 * 是否运行在盒子窗口中（本地服务桥接模式）
 */
export function isBridge() {
    return !!window.__BM_BRIDGE__;
}

/**
 * 页内轻提示
 */
export function showToast(message, type = 'info') {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'bmToast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.className = 'bm-toast show ' + type;
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(
        () => toastEl.classList.remove('show'),
        type === 'error' ? 6000 : 3200
    );
}

/**
 * 页内确认框（替换原生 confirm，WebView2 下更可靠）
 */
export function confirmDialog(message, { okText = '确定', cancelText = '取消' } = {}) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'bm-modal-overlay';
        overlay.innerHTML = `
            <div class="bm-modal">
                <p class="bm-modal-msg"></p>
                <div class="bm-modal-actions">
                    <button class="bm-modal-btn secondary" data-act="cancel"></button>
                    <button class="bm-modal-btn primary" data-act="ok"></button>
                </div>
            </div>`;
        overlay.querySelector('.bm-modal-msg').textContent = message;
        overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
        overlay.querySelector('[data-act="ok"]').textContent = okText;

        const close = (val) => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close(false);
            if (e.key === 'Enter') close(true);
        };

        overlay.addEventListener('click', (e) => {
            const act = e.target.getAttribute && e.target.getAttribute('data-act');
            if (act) close(act === 'ok');
            else if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
    });
}

/**
 * 关闭盒子窗口（成功）
 */
export function closeBoxWindow() {
    try {
        if (window.webview && typeof window.webview.resolve === 'function') {
            window.webview.resolve({ ok: true });
            return;
        }
    } catch {}
    try { window.close(); } catch {}
}

function rebindClick(el, handler) {
    if (!el || !el.parentNode) return el;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    clone.addEventListener('click', handler);
    return clone;
}

async function loadSourceFromServer() {
    const resp = await fetch('/api/input');
    if (!resp.ok) throw new Error('无法读取源文件');
    const blob = await resp.blob();
    const name = (window.__BM_STATE__ && window.__BM_STATE__.source && window.__BM_STATE__.source.name) || 'document';
    const { loadFromBlob } = await import('./file-handler.js');
    await loadFromBlob(blob, name);
}

async function pickFile() {
    try {
        const res = await (await fetch('/api/pick', { method: 'POST' })).json();
        if (!res || !res.ok) return;
        window.__BM_STATE__ = window.__BM_STATE__ || {};
        window.__BM_STATE__.source = res.source;
        await loadSourceFromServer();
    } catch (e) {
        showToast('打开文件失败: ' + e.message, 'error');
    }
}

async function pickOutputDir() {
    try {
        const res = await (await fetch('/api/pick-dir', { method: 'POST' })).json();
        if (!res || !res.ok || !res.path) return;
        if (elements.outputDirInput) elements.outputDirInput.value = res.path;
    } catch (e) {
        showToast('选择目录失败: ' + e.message, 'error');
    }
}

/**
 * 初始化盒子桥接：探测本地服务、预载源文件、接管文件选择
 */
export async function initBox() {
    let st;
    try {
        st = await (await fetch('/api/state')).json();
    } catch {
        return;
    }
    if (!st || !st.bridge) return;

    window.__BM_BRIDGE__ = true;
    window.__BM_STATE__ = st;

    // 桥接模式：选择 / 切换文件改走盒子本地服务（原生文件对话框）
    elements.changeFileBtn = rebindClick(elements.changeFileBtn, pickFile);
    elements.uploadBtn = rebindClick(elements.uploadBtn, pickFile);

    // 输出目录控件（仅桥接模式可用）
    if (elements.outputDirRow) elements.outputDirRow.style.display = '';
    if (elements.outputDirInput) {
        elements.outputDirInput.value = (st.output && st.output.dir) || '';
    }
    if (elements.pickOutputDirBtn) {
        elements.pickOutputDirBtn.addEventListener('click', pickOutputDir);
    }

    if (st.source && st.source.name) {
        try {
            await loadSourceFromServer();
        } catch (e) {
            showToast('载入源文件失败: ' + e.message, 'error');
        }
    }
}
