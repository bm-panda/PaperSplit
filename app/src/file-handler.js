import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { state, resetState } from './state.js';
import { elements } from './dom.js';
import { renderThumbnails, renderCurrentPage, updatePageControls } from './viewer.js';

// 本地打包 PDF.js Worker，避免依赖 CDN（离线可用）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;

function isPdfFile(name, type) {
    if (type && type === 'application/pdf') return true;
    return /\.pdf$/i.test(String(name || ''));
}

function isImageFile(name, type) {
    if (type && type.startsWith('image/')) return true;
    return IMAGE_EXT.test(String(name || ''));
}

/**
 * 准备界面：隐藏空状态、显示缩略图面板、启用操作按钮
 */
function prepareUi() {
    elements.thumbnailsPanel.innerHTML = '';
    elements.emptyState.style.display = 'none';

    const leftPanel = document.querySelector('.left-panel');
    if (leftPanel) {
        leftPanel.style.display = 'flex';
    }

    elements.toggleSealLineBtn.disabled = false;
    elements.exportBtn.disabled = false;
    elements.applyToTypeBtn.disabled = false;
    elements.applyToAllBtn.disabled = false;
}

/**
 * 加载一个 File / Blob（统一入口）
 */
async function loadFile(file) {
    if (!file) return;

    resetState();
    state.fileName = String(file.name || 'document').replace(/\.[^/.]+$/, '');

    if (isPdfFile(file.name, file.type)) {
        state.isPdf = true;
    } else if (isImageFile(file.name, file.type)) {
        state.isPdf = false;
    } else {
        alert('不支持的文件格式，请上传 PDF 或图片文件');
        return;
    }

    prepareUi();

    if (state.isPdf) {
        const arrayBuffer = await file.arrayBuffer();
        await loadPdf(arrayBuffer);
    } else {
        loadImage(file);
    }
}

/**
 * 处理文件上传事件 (Change Event)
 */
export async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    await loadFile(file);
}

/**
 * 从 Blob 载入（盒子预载源文件 / 服务端选择文件时使用）
 */
export async function loadFromBlob(blob, name) {
    if (!blob) return;
    const file = new File([blob], name || 'document.pdf', { type: blob.type || '' });
    await loadFile(file);
}

/**
 * 加载并解析 PDF 文件
 * @param {ArrayBuffer} arrayBuffer 文件二进制数据
 */
async function loadPdf(arrayBuffer) {
    try {
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        state.pdfDoc = await loadingTask.promise;
        state.totalPages = state.pdfDoc.numPages;
        state.currentPage = 1;

        updatePageControls();
        renderThumbnails();
        renderCurrentPage();
    } catch (error) {
        console.error('Error loading PDF:', error);
        alert('无法加载 PDF 文件');
    }
}

/**
 * 加载图片文件 (作为单页文档处理)
 * @param {File|Blob} file 文件对象
 */
function loadImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        state.fileData = e.target.result;
        state.totalPages = 1;
        state.currentPage = 1;
        state.pdfDoc = null;

        updatePageControls();
        elements.thumbnailsPanel.innerHTML = '';
        const thumb = document.createElement('div');
        thumb.className = 'thumbnail-item active';
        const img = document.createElement('img');
        img.src = state.fileData;
        img.style.width = '100%';
        thumb.appendChild(img);
        elements.thumbnailsPanel.appendChild(thumb);

        renderCurrentPage();
    };
    reader.readAsDataURL(file);
}
