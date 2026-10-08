#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORTED_EXTS = ['.pdf', '.jpg', '.jpeg', '.png'];

function readPayload() {
  const jsonPath = process.argv[2];
  if (!jsonPath) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch (err) {
    console.error('参数文件解析失败:', err.message);
    return {};
  }
}

function writeEnvelope(env, payload) {
  if (!env || !env.output_json) return;
  try {
    fs.writeFileSync(env.output_json, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error('信封写入失败:', err.message);
  }
}

function isSupported(p) {
  return (
    typeof p === 'string' &&
    SUPPORTED_EXTS.includes(path.extname(p).toLowerCase()) &&
    fs.existsSync(p)
  );
}

async function main() {
  const payload = readPayload();

  // 无参数（本地调试 / 命令行直接运行）：打开空窗口
  if (!payload) {
    const { start } = await import('./app/server/index.js');
    start({ files: [], params: {} });
    return;
  }

  const env = payload.environment || {};
  const data = payload.data || {};
  const params = payload.params || {};
  const mode = env.invoke_mode || 'manual';
  const files = (Array.isArray(data.target_paths) ? data.target_paths : []).filter(isSupported);

  // 本项目为画布交互，暂不支持无人值守运行
  if (mode === 'node') {
    writeEnvelope(env, { code: 1, msg: '该脚本需要在窗口中手动操作，暂不支持被联动调用' });
    process.exit(1);
  }
  if (mode === 'scheduled') {
    console.error('该脚本需要在窗口中手动操作，暂不支持定时任务');
    process.exit(1);
  }

  const { start } = await import('./app/server/index.js');
  start({ files, params, env });
}

main().catch((err) => {
  console.error('启动失败:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
