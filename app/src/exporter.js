import { jsPDF } from 'jspdf';
import { state } from './state.js';
import { elements } from './dom.js';
import { getPageConfig } from './editor.js';
import { isBridge, showToast, closeBoxWindow } from './box.js';

/**
 * 导出处理后的 PDF
 * 遍历每一页，根据切割线和密封线裁剪，每页生成贴合裁剪区域的页面 (高度对齐 A4)
 */
export async function exportPdf() {
    if (!state.pdfDoc && !state.fileData) return;

    elements.exportBtn.disabled = true;
    elements.exportBtn.textContent = '生成中...';

    // 导出适配模式：'a4-fit'(等比留白) | 'a4-fill'(拉伸填满) | 'wysiwyg'(原始裁剪尺寸)
    const fit = elements.exportFitSelect ? elements.exportFitSelect.value : 'a4-fit';

    try {
        // 延迟创建：首页尺寸需贴合第一片裁剪区域 (所见即所得)
        let doc = null;

        // 遍历所有原始页面
        for (let i = 1; i <= state.totalPages; i++) {
            const config = getPageConfig(i);

            // 准备切割区间：以有序分割点为界，逐段切分
            // 1. 依据密封线确定保留区间 [keepStart, keepEnd]
            // 2. 每段与保留区间求交，得到最终切片
            const splits = (config.splits && config.splits.length ? config.splits : [0.5])
                .slice()
                .sort((a, b) => a - b);
            const seal = config.sealLine;

            let keepStart = 0;
            let keepEnd = 1;
            if (seal) {
                if (seal.type === 'left') {
                    keepStart = Math.min(Math.max(seal.x, 0), 1);
                } else {
                    keepEnd = Math.min(Math.max(seal.x, 0), 1);
                }
            }

            const points = [0, ...splits, 1];
            const ranges = [];
            for (let k = 0; k < points.length - 1; k++) {
                const a = Math.max(points[k], keepStart);
                const b = Math.min(points[k + 1], keepEnd);
                if (b - a > 1e-4) ranges.push([a, b]);
            }

            // 渲染高清 Canvas (2倍缩放以保证清晰度)
            let sourceCanvas;
            if (state.isPdf) {
                const page = await state.pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: 2 });
                sourceCanvas = document.createElement('canvas');
                sourceCanvas.width = viewport.width;
                sourceCanvas.height = viewport.height;
                await page.render({ canvasContext: sourceCanvas.getContext('2d'), viewport }).promise;
            } else {
                const img = new Image();
                img.src = state.fileData;
                await new Promise(r => img.onload = r);
                sourceCanvas = document.createElement('canvas');
                sourceCanvas.width = img.width;
                sourceCanvas.height = img.height;
                sourceCanvas.getContext('2d').drawImage(img, 0, 0);
            }

            // 执行切割
            for (let rng of ranges) {
                const startXRatio = rng[0];
                const endXRatio = rng[1];
                const widthRatio = endXRatio - startXRatio;

                // 忽略过小的切片
                if (widthRatio <= 0.01) continue;

                const sx = sourceCanvas.width * startXRatio;
                const sy = 0;
                const sWidth = sourceCanvas.width * widthRatio;
                const sHeight = sourceCanvas.height;

                // 创建切片 Canvas
                const sliceCanvas = document.createElement('canvas');
                sliceCanvas.width = sWidth;
                sliceCanvas.height = sHeight;
                sliceCanvas.getContext('2d').drawImage(sourceCanvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

                const imgData = sliceCanvas.toDataURL('image/jpeg', 0.95);

                // 根据导出适配模式确定页面尺寸与图片绘制区域
                let pageWidth, pageHeight, orientation;
                let drawX, drawY, drawW, drawH;

                if (fit === 'wysiwyg') {
                    // 所见即所得：页面尺寸 = 裁剪区域，图片铺满整页（无白边、不变形）。
                    // 高度锁定 297mm，宽度按裁剪比例。标准 A3 对半切正好得到 210×297 的 A4。
                    pageHeight = 297;
                    pageWidth = pageHeight * (sWidth / sHeight);
                    orientation = pageWidth > pageHeight ? 'landscape' : 'portrait';
                    drawX = 0; drawY = 0; drawW = pageWidth; drawH = pageHeight;
                } else {
                    // 标准 A4 纵向 (210×297mm)
                    pageWidth = 210; pageHeight = 297; orientation = 'portrait';
                    if (fit === 'a4-fill') {
                        // 拉伸填满：图片铺满整页，切偏时内容会被轻微拉伸变形
                        drawX = 0; drawY = 0; drawW = 210; drawH = 297;
                    } else {
                        // 等比留白 (a4-fit)：保持裁剪比例缩放并居中，切偏时四周留白、不变形
                        const sliceAspect = sWidth / sHeight;
                        const a4Aspect = 210 / 297;
                        if (sliceAspect > a4Aspect) {
                            drawW = 210; drawH = 210 / sliceAspect;
                        } else {
                            drawH = 297; drawW = 297 * sliceAspect;
                        }
                        drawX = (210 - drawW) / 2;
                        drawY = (297 - drawH) / 2;
                    }
                }

                if (!doc) {
                    doc = new jsPDF({ unit: 'mm', orientation, format: [pageWidth, pageHeight] });
                } else {
                    doc.addPage([pageWidth, pageHeight], orientation);
                }

                doc.addImage(imgData, 'JPEG', drawX, drawY, drawW, drawH);
            }
        }

        if (!doc) {
            if (isBridge()) showToast('没有可导出的内容', 'error');
            else alert('没有可导出的内容');
            return;
        }

        const filename = `${state.fileName}(A4).pdf`;

        if (isBridge()) {
            // 盒子模式：交给本地服务写盘
            const blob = doc.output('blob');
            const headers = {
                'Content-Type': 'application/pdf',
                'X-Filename': encodeURIComponent(filename),
            };
            const outDir = elements.outputDirInput ? elements.outputDirInput.value.trim() : '';
            if (outDir) headers['X-Output-Dir'] = encodeURIComponent(outDir);

            const resp = await fetch('/api/save', {
                method: 'POST',
                headers,
                body: blob,
            });
            const data = await resp.json().catch(() => ({ ok: false, error: '保存响应解析失败' }));
            if (!data.ok) throw new Error(data.error || '保存失败');
            showToast('已保存：' + data.output, 'success');
            setTimeout(closeBoxWindow, 1000);
        } else {
            doc.save(filename);
        }

    } catch (e) {
        console.error(e);
        if (isBridge()) showToast('导出失败: ' + e.message, 'error');
        else alert('导出失败: ' + e.message);
    } finally {
        elements.exportBtn.disabled = false;
        elements.exportBtn.innerHTML = '<span class="material-icons">save_alt</span> 导出为 PDF (A4)';
    }
}
