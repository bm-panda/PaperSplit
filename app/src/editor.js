import { state } from './state.js';
import { elements } from './dom.js';
import { confirmDialog, showToast } from './box.js';

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 4;

/**
 * 生成均分后的分割点（不含 0 / 1）
 * @param {number} n 分栏数
 */
function evenSplits(n) {
    const count = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(Number(n) || 2)));
    const splits = [];
    for (let i = 1; i < count; i++) splits.push(i / count);
    return splits;
}

/**
 * 规整一组分割点：转数字、裁剪到 (0,1)、去重、升序
 */
function normalizeSplits(splits) {
    const arr = (Array.isArray(splits) ? splits : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0 && v < 1)
        .sort((a, b) => a - b);
    const out = [];
    for (const v of arr) {
        if (out.length === 0 || v - out[out.length - 1] > 1e-4) out.push(v);
    }
    return out;
}

/**
 * 获取或初始化当前页面的配置
 * 结构: { splits: [0.5], sealLine: null | { x: 0.15, type: 'left'|'right' } }
 * splits 为有序分割点数组，长度 +1 即分栏数
 * @param {number} pageIndex 页面索引 (1-based)
 * @returns {Object} 页面配置对象
 */
export function getPageConfig(pageIndex) {
    if (!state.pagesData[pageIndex]) {
        state.pagesData[pageIndex] = {
            splits: evenSplits(state.columns),
            sealLine: null
        };
    }
    const config = state.pagesData[pageIndex];

    // 兼容旧的单分割线字段
    if (!Array.isArray(config.splits)) {
        config.splits = normalizeSplits([config.splitX]);
        if (config.splits.length === 0) config.splits = [0.5];
        delete config.splitX;
    } else {
        config.splits = normalizeSplits(config.splits);
        if (config.splits.length === 0) config.splits = [0.5];
    }
    return config;
}

/**
 * 渲染当前页的所有辅助线 (多条切割线 + 密封线)
 */
export function renderSplitLines() {
    // 清除现有的线
    elements.canvasWrapper.querySelectorAll('.split-line').forEach(e => e.remove());

    const config = getPageConfig(state.currentPage);
    const splits = config.splits;
    const total = splits.length;

    // 1. 渲染切割线（每条限制在相邻线之间，防止交叉）
    splits.forEach((x, i) => {
        const min = i === 0 ? 0 : splits[i - 1];
        const max = i === total - 1 ? 1 : splits[i + 1];
        createLineElement(x, 'split', { min, max }, (newIter) => {
            config.splits[i] = newIter;
        });
    });

    // 同步分栏数下拉
    if (elements.columnsSelect) {
        elements.columnsSelect.value = String(total + 1);
    }

    // 2. 渲染密封线 (如果存在)
    if (config.sealLine) {
        createLineElement(config.sealLine.x, 'seal', { min: 0, max: 1 }, (newIter) => {
            config.sealLine.x = newIter;
        });

        // 更新按钮状态：显示取消
        elements.toggleSealLineBtn.innerHTML = '<span class="material-icons">close</span> 取消去除';
        elements.toggleSealLineBtn.classList.add('active-state');
    } else {
        // 更新按钮状态：显示添加
        elements.toggleSealLineBtn.innerHTML = '<span class="material-icons">format_shapes</span> 去除密封线';
        elements.toggleSealLineBtn.classList.remove('active-state');
    }

    // 启用相关操作按钮
    elements.toggleSealLineBtn.disabled = false;
    elements.applyToTypeBtn.disabled = false;
    elements.applyToAllBtn.disabled = false;
}

/**
 * 设置当前页面分栏数（自动均分），保留密封线
 * @param {number} n 2 | 3 | 4
 */
export function setColumns(n) {
    const count = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(Number(n) || 2)));
    state.columns = count;
    const config = getPageConfig(state.currentPage);
    config.splits = evenSplits(count);
    renderSplitLines();
}

/**
 * 创建辅助线 DOM 元素并绑定拖拽事件
 * @param {number} initialX 初始位置比例 (0-1)
 * @param {string} type 线条类型 ('split' | 'seal')
 * @param {{min:number,max:number}} bounds 拖动范围（比例）
 * @param {Function} onUpdate 更新位置回调
 */
function createLineElement(initialX, type, bounds, onUpdate) {
    const lineEl = document.createElement('div');
    lineEl.className = `split-line ${type}`;
    lineEl.style.left = `${initialX * 100}%`;

    // 拖拽状态
    let isDragging = false;
    let startX = 0;
    let startLeft = 0; // 记录初始百分比

    const onDragStart = (clientX) => {
        isDragging = true;
        startX = clientX;
        // 获取当前 style.left 的百分比数值 (去除 %)
        startLeft = parseFloat(lineEl.style.left);
        lineEl.classList.add('dragging');
    };

    const onDragMove = (clientX) => {
        if (!isDragging) return;

        const rect = elements.canvasWrapper.getBoundingClientRect();
        const deltaX = clientX - startX;
        const deltaPercent = (deltaX / rect.width) * 100;

        let newPercent = startLeft + deltaPercent;

        // 限制在 [min, max] 之间（相邻切割线 / 画面边界）
        const minPercent = bounds.min * 100;
        const maxPercent = bounds.max * 100;
        newPercent = Math.max(minPercent, Math.min(newPercent, maxPercent));

        lineEl.style.left = `${newPercent}%`;
        onUpdate(newPercent / 100);
    };

    const onDragEnd = () => {
        isDragging = false;
        lineEl.classList.remove('dragging');
    };

    // Mouse Events
    const onMouseDown = (e) => {
        e.preventDefault(); // 防止选中文本
        onDragStart(e.clientX);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        onDragMove(e.clientX);
    };

    const onMouseUp = () => {
        onDragEnd();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };

    // Touch Events (Mobile)
    const onTouchStart = (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault(); // 防止页面滚动
        onDragStart(e.touches[0].clientX);
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend', onTouchEnd);
    };

    const onTouchMove = (e) => {
        if (!isDragging) return;
        e.preventDefault(); // 防止滚动
        onDragMove(e.touches[0].clientX);
    };

    const onTouchEnd = () => {
        onDragEnd();
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
    };

    lineEl.addEventListener('mousedown', onMouseDown);
    lineEl.addEventListener('touchstart', onTouchStart, { passive: false });

    elements.canvasWrapper.appendChild(lineEl);
}

/**
 * 切换密封线状态 (添加/移除)
 * 智能判断：奇数页默认左侧，偶数页默认右侧
 */
export function toggleSealLine() {
    const config = getPageConfig(state.currentPage);

    if (config.sealLine) {
        // 移除密封线
        config.sealLine = null;
    } else {
        // 添加密封线
        // 奇数页 (1, 3, 5): 左侧 (0.15)
        // 偶数页 (2, 4, 6): 右侧 (0.85)，与左侧对称，各留 15% 边距
        const isOdd = state.currentPage % 2 !== 0;
        if (isOdd) {
            config.sealLine = { x: 0.15, type: 'left' };
        } else {
            config.sealLine = { x: 0.85, type: 'right' };
        }
    }
    renderSplitLines();
}

/**
 * 批量应用配置到同类页面 (奇数页或偶数页)
 */
export async function applySplitToType() {
    const currentConfig = getPageConfig(state.currentPage);
    const isCurrentOdd = state.currentPage % 2 !== 0;
    const typeName = isCurrentOdd ? '奇数页' : '偶数页';

    const ok = await confirmDialog(`确定将当前配置应用到所有${typeName}吗？`);
    if (ok) {
        for (let i = 1; i <= state.totalPages; i++) {
            const isIterOdd = i % 2 !== 0;
            if (isIterOdd === isCurrentOdd) {
                // 深拷贝配置
                state.pagesData[i] = JSON.parse(JSON.stringify(currentConfig));
            }
        }
        showToast(`已应用到所有${typeName}`, 'success');
    }
}

/**
 * 批量应用配置到所有页面
 */
export async function applySplitToAll() {
    const currentConfig = getPageConfig(state.currentPage);
    const ok = await confirmDialog(`确定将当前配置应用到所有 ${state.totalPages} 页吗？`);
    if (ok) {
        for (let i = 1; i <= state.totalPages; i++) {
            // 深拷贝配置
            state.pagesData[i] = JSON.parse(JSON.stringify(currentConfig));
        }
        showToast('已应用到所有页面', 'success');
    }
}
